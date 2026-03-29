export const GET_MY_AGE_TOOL_NAME = 'get_my_age'
export const GET_AVAILABLE_DOCTOR_APPOINTMENTS_TOOL_NAME =
	'get_available_doctor_appointments'
export const BOOK_DOCTOR_APPOINTMENT_TOOL_NAME = 'book_doctor_appointment'

const APPOINTMENT_WINDOW_DAYS = 5
const DAILY_SLOT_COUNT = 13
const SLOT_DURATION_MINUTES = 30
const SLOT_START_TIMES = [
	'09:00',
	'09:30',
	'10:00',
	'10:30',
	'11:00',
	'11:30',
	'13:00',
	'13:30',
	'14:00',
	'14:30',
	'15:00',
	'15:30',
	'16:00',
	'16:30'
]

const DOCTOR_ROSTER = [
	{name: 'Dr. Maya Patel', specialty: 'Primary care'},
	{name: 'Dr. Ethan Brooks', specialty: 'Sports medicine'},
	{name: 'Dr. Sofia Nguyen', specialty: 'Lifestyle medicine'}
]

function formatLocalDate(date) {
	const year = date.getFullYear()
	const month = `${date.getMonth() + 1}`.padStart(2, '0')
	const day = `${date.getDate()}`.padStart(2, '0')
	return `${year}-${month}-${day}`
}

function hashString(value) {
	let hash = 0
	
	for (const character of value) {
		hash = (hash * 31 + character.charCodeAt(0)) >>> 0
	}
	
	return hash
}

function timeToMinutes(time) {
	const [hours, minutes] = time.split(':').map(Number)
	return hours * 60 + minutes
}

function minutesToTime(totalMinutes) {
	const hours = Math.floor(totalMinutes / 60)
	const minutes = totalMinutes % 60
	return `${`${hours}`.padStart(2, '0')}:${`${minutes}`.padStart(2, '0')}`
}

function createDailySlots(dateString) {
	const selectedTimes = SLOT_START_TIMES.map((startTime) => ({
		startTime,
		score: hashString(`${dateString}-${startTime}`)
	}))
		.sort((left, right) => left.score - right.score)
		.slice(0, DAILY_SLOT_COUNT)
		.sort((left, right) => timeToMinutes(left.startTime) - timeToMinutes(right.startTime))
	
	return selectedTimes.map(({startTime}, index) => {
		const endTime = minutesToTime(timeToMinutes(startTime) + SLOT_DURATION_MINUTES)
		const doctor =
			DOCTOR_ROSTER[hashString(`${dateString}-${startTime}-doctor`) % DOCTOR_ROSTER.length]
		
		return {
			slotId: `${dateString}-${startTime.replace(':', '')}`,
			date: dateString,
			startTime,
			endTime,
			durationMinutes: SLOT_DURATION_MINUTES,
			doctorName: doctor.name,
			specialty: doctor.specialty,
			location: 'Goals Health Virtual Clinic',
			ordinal: index + 1
		}
	})
}

function createAppointmentStore() {
	const allSlots = []
	const bookings = new Map()
	
	for (let dayOffset = 0; dayOffset < APPOINTMENT_WINDOW_DAYS; dayOffset += 1) {
		const date = new Date()
		date.setHours(0, 0, 0, 0)
		date.setDate(date.getDate() + dayOffset)
		allSlots.push(...createDailySlots(formatLocalDate(date)))
	}
	
	function getSupportedDates() {
		return [...new Set(allSlots.map((slot) => slot.date))]
	}
	
	function getAvailableSlots(date) {
		return allSlots.filter((slot) => {
			const matchesDate = !date || slot.date === date
			return matchesDate && !bookings.has(slot.slotId)
		})
	}
	
	return {
		listAvailableAppointments(args = {}) {
			const requestedDate =
				typeof args.date === 'string' && args.date.trim() ? args.date.trim() : null
			const supportedDates = getSupportedDates()
			
			if (requestedDate && !supportedDates.includes(requestedDate)) {
				return {
					success: false,
					error: {
						code: 'DATE_OUT_OF_RANGE',
						message: `No appointment inventory exists for ${requestedDate}.`
					},
					supportedDates
				}
			}
			
			const availableSlots = getAvailableSlots(requestedDate)
			const groupedByDate = supportedDates.map((date) => ({
				date,
				slots: getAvailableSlots(date)
			}))
			
			return {
				success: true,
				requestedDate,
				totalAvailable: availableSlots.length,
				supportedDates,
				availableSlots,
				groupedByDate
			}
		},
		
		bookAppointment(args = {}) {
			const slotId = typeof args.slotId === 'string' ? args.slotId.trim() : ''
			const patientName =
				typeof args.patientName === 'string' && args.patientName.trim()
					? args.patientName.trim()
					: 'Guest'
			const reason =
				typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim() : null
			
			if (!slotId) {
				return {
					success: false,
					error: {
						code: 'MISSING_SLOT_ID',
						message:
							'slotId is required. First call get_available_doctor_appointments, then book one of those slot IDs.'
					}
				}
			}
			
			const slot = allSlots.find((candidate) => candidate.slotId === slotId)
			
			if (!slot) {
				return {
					success: false,
					error: {
						code: 'UNKNOWN_SLOT',
						message: `The slotId ${slotId} does not exist in the next ${APPOINTMENT_WINDOW_DAYS} days.`
					},
					supportedDates: getSupportedDates()
				}
			}
			
			if (bookings.has(slotId)) {
				return {
					success: false,
					error: {
						code: 'SLOT_UNAVAILABLE',
						message: `The slot ${slotId} is no longer available.`
					},
					requestedSlot: slot,
					alternativeSlotsSameDay: getAvailableSlots(slot.date)
				}
			}
			
			const confirmationId = `apt-${hashString(`${slotId}-${patientName}`)}`
			const booking = {
				confirmationId,
				patientName,
				reason,
				bookedAt: new Date().toISOString(),
				slot
			}
			
			bookings.set(slotId, booking)
			
			return {
				success: true,
				confirmationId,
				patientName,
				reason,
				appointment: slot,
				remainingSlotsSameDay: getAvailableSlots(slot.date)
			}
		}
	}
}

const appointmentStore = createAppointmentStore()

export const getMyAgeToolDefinition = {
	name: GET_MY_AGE_TOOL_NAME,
	description: 'Returns the user age as a hardcoded integer.',
	parametersJsonSchema: {
		type: 'object',
		properties: {},
		additionalProperties: false
	}
}

export const getAvailableDoctorAppointmentsToolDefinition = {
	name: GET_AVAILABLE_DOCTOR_APPOINTMENTS_TOOL_NAME,
	description:
		'Returns available doctor appointment slots for today and the next four days. Optionally filter by date in YYYY-MM-DD format.',
	parametersJsonSchema: {
		type: 'object',
		properties: {
			date: {
				type: 'string',
				description:
					'Optional date filter in YYYY-MM-DD format. Must be one of the next five supported dates.'
			}
		},
		additionalProperties: false
	}
}

export const bookDoctorAppointmentToolDefinition = {
	name: BOOK_DOCTOR_APPOINTMENT_TOOL_NAME,
	description:
		'Books a doctor appointment by slotId. Always call get_available_doctor_appointments first and only use a returned slotId.',
	parametersJsonSchema: {
		type: 'object',
		properties: {
			slotId: {
				type: 'string',
				description:
					'Required slot identifier returned by get_available_doctor_appointments.'
			},
			patientName: {
				type: 'string',
				description: 'Optional patient name to attach to the booking.'
			},
			reason: {
				type: 'string',
				description: 'Optional short reason for the appointment.'
			}
		},
		required: ['slotId'],
		additionalProperties: false
	}
}

export const HEALTH_TOOL_DEFINITIONS = [
	getMyAgeToolDefinition,
	getAvailableDoctorAppointmentsToolDefinition,
	bookDoctorAppointmentToolDefinition
]

export const HEALTH_TOOL_NAMES = HEALTH_TOOL_DEFINITIONS.map((tool) => tool.name)

function parseToolArgs(functionCall) {
	const input = functionCall.args ?? functionCall.arguments ?? {}
	
	if (typeof input === 'string') {
		try {
			return JSON.parse(input)
		}
		catch {
			return {}
		}
	}
	
	if (input && typeof input === 'object') {
		return input
	}
	
	return {}
}

function executeTool(functionCall) {
	const args = parseToolArgs(functionCall)
	
	switch (functionCall.name) {
		case GET_MY_AGE_TOOL_NAME:
			return {age: 27}
		
		case GET_AVAILABLE_DOCTOR_APPOINTMENTS_TOOL_NAME:
			return appointmentStore.listAvailableAppointments(args)
		
		case BOOK_DOCTOR_APPOINTMENT_TOOL_NAME:
			return appointmentStore.bookAppointment(args)
		
		default:
			return {
				error: `Unknown tool: ${functionCall.name}`
			}
	}
}

export function executeToolCalls(functionCalls = []) {
	return functionCalls.map((functionCall) => ({
		id: functionCall.id,
		name: functionCall.name,
		response: executeTool(functionCall)
	}))
}
