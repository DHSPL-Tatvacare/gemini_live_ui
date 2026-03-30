import {
  Bot,
  Camera,
  CameraOff,
  ChevronRight,
  Mic,
  MicOff,
  PhoneCall,
  PhoneOff,
  ScreenShare,
  ScreenShareOff,
  Send,
  Settings2,
  Sparkles
} from 'lucide-react'
import {startTransition, useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {AudioPlayer, AudioRecorder} from './lib/audio.js'
import {generateEphemeralToken} from './lib/ephemeral-token.js'
import {
  ACTIVITY_HANDLING_OPTIONS,
  connectLiveSession,
  END_SENSITIVITY_OPTIONS,
  FIXED_MODEL_ID,
  formatSetupPayload,
  START_SENSITIVITY_OPTIONS,
  VOICE_OPTIONS
} from './lib/gemini-live.js'
import {executeToolCalls, HEALTH_TOOL_NAMES} from './lib/tools.js'
import {CameraStreamer, ScreenStreamer} from './lib/video.js'
import {DEFAULT_SYSTEM_PROMPT} from './systemPrompt.js'

const DEFAULT_SETTINGS = {
	systemInstructions: DEFAULT_SYSTEM_PROMPT,
	voiceName: 'Aoede',
	temperature: 1,
	enableGrounding: false,
	enableInputTranscription: true,
	enableOutputTranscription: true,
	disableActivityDetection: false,
	silenceDurationMs: 500,
	prefixPaddingMs: 500,
	endOfSpeechSensitivity: 'END_SENSITIVITY_UNSPECIFIED',
	startOfSpeechSensitivity: 'START_SENSITIVITY_UNSPECIFIED',
	activityHandling: 'ACTIVITY_HANDLING_UNSPECIFIED',
	volume: 80
}

const INITIAL_MESSAGES = [
	{
		id: 'welcome',
		kind: 'system',
		text: 'Connect to Gemini Live, then start talking.'
	}
]

const STATUS_COPY = {
	disconnected: 'Disconnected',
	connecting: 'Connecting',
	connected: 'Connected',
	error: 'Error'
}

const NAV_ITEMS = [
	{path: '/', label: 'Playground', icon: Bot},
	{path: '/system', label: 'System', icon: Sparkles},
	{path: '/settings', label: 'Settings', icon: Settings2}
]
const LIVE_TOKEN_STORAGE_KEY = 'goals-live-ephemeral-token'

function readStoredLiveToken() {
	if (typeof window === 'undefined') {
		return ''
	}
	
	return window.localStorage.getItem(LIVE_TOKEN_STORAGE_KEY) || ''
}

function createMessage(kind, text, extra = {}) {
	return {
		id:
			typeof crypto !== 'undefined' && crypto.randomUUID
				? crypto.randomUUID()
				: `${kind}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
		kind,
		text,
		...extra
	}
}

function classNames(...values) {
	return values.filter(Boolean).join(' ')
}

function readUsageNumber(value) {
	return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function countPresentUsageFields(values) {
	return values.filter((value) => value !== null).length
}

function normalizeUsageMetadata(usageMetadata) {
	if (!usageMetadata || typeof usageMetadata !== 'object') {
		return null
	}
	
	const inputTokens = readUsageNumber(
		usageMetadata.promptTokenCount ?? usageMetadata.inputTokenCount
	)
	const outputTokens = readUsageNumber(
		usageMetadata.responseTokenCount ??
			usageMetadata.outputTokenCount ??
			usageMetadata.candidatesTokenCount
	)
	const toolUsePromptTokens = readUsageNumber(usageMetadata.toolUsePromptTokenCount)
	const thoughtsTokens = readUsageNumber(usageMetadata.thoughtsTokenCount)
	const totalTokens = readUsageNumber(usageMetadata.totalTokenCount)
	const partialKnownTokens = [inputTokens, outputTokens, toolUsePromptTokens, thoughtsTokens]
		.reduce((sum, value) => sum + (value || 0), 0)
	const presentFieldCount = countPresentUsageFields([
		inputTokens,
		outputTokens,
		toolUsePromptTokens,
		thoughtsTokens,
		totalTokens
	])
	
	if (totalTokens === null && presentFieldCount === 0) {
		return null
	}
	
	return {
		raw: usageMetadata,
		inputTokens,
		outputTokens,
		toolUsePromptTokens,
		thoughtsTokens,
		turnTotalTokens: totalTokens,
		isAuthoritative: totalTokens !== null,
		partialKnownTokens,
		presentFieldCount
	}
}

function shouldReplacePendingUsage(currentUsage, nextUsage) {
	if (!currentUsage) {
		return true
	}
	
	if (currentUsage.isAuthoritative !== nextUsage.isAuthoritative) {
		return nextUsage.isAuthoritative
	}
	
	if (nextUsage.isAuthoritative) {
		return (nextUsage.turnTotalTokens || 0) >= (currentUsage.turnTotalTokens || 0)
	}
	
	if (nextUsage.presentFieldCount !== currentUsage.presentFieldCount) {
		return nextUsage.presentFieldCount > currentUsage.presentFieldCount
	}
	
	return nextUsage.partialKnownTokens >= currentUsage.partialKnownTokens
}

function formatTokenCount(value) {
	return value.toLocaleString()
}

function formatUsageLabel(usage) {
	if (!usage) {
		return 'Token count'
	}
	
	if (usage.isAuthoritative && typeof usage.turnTotalTokens === 'number') {
		return `Token count: ${formatTokenCount(usage.turnTotalTokens)}`
	}
	
	if (usage.partialKnownTokens > 0) {
		return `Token count: partial (${formatTokenCount(usage.partialKnownTokens)}+)`
	}
	
	return 'Token count: partial'
}

function formatUsageValue(value) {
	return value === null || value === undefined ? 'Unavailable' : formatTokenCount(value)
}

function formatTimestamp() {
	return new Date().toLocaleTimeString([], {
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit'
	})
}

function readPathname() {
	if (typeof window === 'undefined') {
		return '/'
	}
	
	const pathname = window.location.pathname
	return pathname === '/settings' || pathname === '/system' ? pathname : '/'
}

export default function App() {
	const [pathname, setPathname] = useState(readPathname)
	const [settings, setSettings] = useState(DEFAULT_SETTINGS)
	const [liveApiKey, setLiveApiKey] = useState(readStoredLiveToken)
	const [status, setStatus] = useState('disconnected')
	const [statusDetail, setStatusDetail] = useState(() =>
		readStoredLiveToken()
			? 'Ready to connect.'
			: 'Generate a token to start a Live session.'
	)
	const [chatInput, setChatInput] = useState('')
	const [messages, setMessages] = useState(INITIAL_MESSAGES)
	const [debugLines, setDebugLines] = useState(['Ready to connect.'])
	const [micOptions, setMicOptions] = useState([])
	const [cameraOptions, setCameraOptions] = useState([])
	const [selectedMic, setSelectedMic] = useState('')
	const [selectedCamera, setSelectedCamera] = useState('')
	const [isSessionReady, setIsSessionReady] = useState(false)
	const [isMicOn, setIsMicOn] = useState(false)
	const [isCameraOn, setIsCameraOn] = useState(false)
	const [isScreenOn, setIsScreenOn] = useState(false)
	const [previewTitle, setPreviewTitle] = useState('No live visual stream')
	const [previewStream, setPreviewStream] = useState(null)
	
	const previewRef = useRef(null)
	const conversationFeedRef = useRef(null)
	const sessionRef = useRef(null)
	const recorderRef = useRef(null)
	const audioPlayerRef = useRef(null)
	const cameraRef = useRef(null)
	const screenRef = useRef(null)
	const settingsRef = useRef(settings)
	const closeRequestedRef = useRef(false)
	const pendingTurnUsageRef = useRef(null)
	const sessionTotalTokensRef = useRef(0)
	const sessionHasPartialUsageRef = useRef(false)
	
	useEffect(() => {
		settingsRef.current = settings
	}, [settings])
	
	useEffect(() => {
		if (typeof window === 'undefined') {
			return
		}
		
		if (liveApiKey?.startsWith('auth_tokens/')) {
			window.localStorage.setItem(LIVE_TOKEN_STORAGE_KEY, liveApiKey)
			return
		}
		
		window.localStorage.removeItem(LIVE_TOKEN_STORAGE_KEY)
	}, [liveApiKey])
	
	useEffect(() => {
		const handlePopState = () => {
			setPathname(readPathname())
		}
		
		window.addEventListener('popstate', handlePopState)
		return () => {
			window.removeEventListener('popstate', handlePopState)
		}
	}, [])
	
	const groundingDisablesTools = settings.enableGrounding
	const hasLiveToken = liveApiKey.startsWith('auth_tokens/')
	const canConnect = hasLiveToken && status !== 'connecting' && status !== 'connected'
	const canDisconnect = status === 'connecting' || status === 'connected'
	const isConnected = status === 'connected'
	const canInteract = isConnected && isSessionReady
	const isPlayground = pathname === '/'
	
	useEffect(() => {
		if (!isPlayground || !conversationFeedRef.current) {
			return
		}
		
		const frameId = window.requestAnimationFrame(() => {
			conversationFeedRef.current?.scrollTo({
				top: conversationFeedRef.current.scrollHeight,
				behavior: 'smooth'
			})
		})
		
		return () => {
			window.cancelAnimationFrame(frameId)
		}
	}, [isPlayground, messages])
	
	const messageCount = useMemo(() => messages.length, [messages])
	const setupJson = useMemo(
		() => JSON.stringify(formatSetupPayload(settings), null, 2),
		[settings]
	)
	
	const addDebugLine = useCallback((line) => {
		const stamped = `[${formatTimestamp()}] ${line}`
		startTransition(() => {
			setDebugLines((current) => [...current.slice(-23), stamped])
		})
	}, [])

	const handleStageWheel = useCallback((event) => {
		const feed = conversationFeedRef.current
		
		if (!feed) {
			return
		}
		
		const target = event.target
		if (target instanceof Node && feed.contains(target)) {
			return
		}
		
		if (feed.scrollHeight <= feed.clientHeight) {
			return
		}
		
		event.preventDefault()
		feed.scrollBy({
			top: event.deltaY,
			left: event.deltaX,
			behavior: 'auto'
		})
	}, [])
	
	const addMessage = useCallback((kind, text, {append = false, ...extra} = {}) => {
		startTransition(() => {
			setMessages((current) => {
				if (
					append &&
					current.length > 0 &&
					current[current.length - 1].kind === kind
				) {
					const next = current.slice()
					next[next.length - 1] = {
						...next[next.length - 1],
						text: `${next[next.length - 1].text}${text}`
					}
					return next
				}
				
				return [...current, createMessage(kind, text, extra)]
			})
		})
	}, [])
	
	const refreshDevices = useCallback(async () => {
		if (!navigator.mediaDevices?.enumerateDevices) {
			return
		}
		
		try {
			const devices = await navigator.mediaDevices.enumerateDevices()
			setMicOptions(devices.filter((device) => device.kind === 'audioinput'))
			setCameraOptions(devices.filter((device) => device.kind === 'videoinput'))
		}
		catch (error) {
			addDebugLine(`Device enumeration failed: ${error.message}`)
		}
	}, [addDebugLine])
	
	const attachPreview = useCallback((stream, label) => {
		setPreviewStream(stream)
		setPreviewTitle(label)
	}, [])
	
	const clearPreview = useCallback(() => {
		setPreviewStream(null)
		setPreviewTitle('No live visual stream')
	}, [])
	
	const syncPreview = useCallback(() => {
		if (screenRef.current?.stream) {
			attachPreview(screenRef.current.stream, 'Screen preview')
			return
		}
		
		if (cameraRef.current?.stream) {
			attachPreview(cameraRef.current.stream, 'Camera preview')
			return
		}
		
		clearPreview()
	}, [attachPreview, clearPreview])
	
	useEffect(() => {
		const previewElement = previewRef.current
		
		if (!previewElement) {
			return
		}
		
		previewElement.srcObject = previewStream
		
		if (!previewStream) {
			return
		}
		
		previewElement.play().catch((error) => {
			addDebugLine(`Preview playback failed: ${error.message}`)
		})
		
		return () => {
			if (previewElement.srcObject === previewStream) {
				previewElement.srcObject = null
			}
		}
	}, [addDebugLine, previewStream])
	
	async function ensureAudioPlayer() {
		if (!audioPlayerRef.current) {
			audioPlayerRef.current = new AudioPlayer()
		}
		
		await audioPlayerRef.current.init()
		audioPlayerRef.current.setVolume(settingsRef.current.volume / 100)
		return audioPlayerRef.current
	}
	
	function handleSessionMessage(message) {
		const currentSession = sessionRef.current
		const content = message.serverContent
		const normalizedUsage = normalizeUsageMetadata(message.usageMetadata)
		
		if (normalizedUsage && shouldReplacePendingUsage(pendingTurnUsageRef.current, normalizedUsage)) {
			pendingTurnUsageRef.current = normalizedUsage
		}
		
		if (message.usageMetadata) {
			addDebugLine(`Usage metadata snapshot: ${JSON.stringify(message.usageMetadata)}`)
		}
		
		if (message.setupComplete) {
			const sessionId = message.setupComplete.sessionId || 'unknown'
			setIsSessionReady(true)
			addDebugLine(`Setup complete. Session id: ${sessionId}`)
			addMessage('system', 'Live session ready.')
			setStatusDetail('Session ready. Voice and text input are enabled.')
		}
		
		if (message.toolCall?.functionCalls?.length) {
			const responses = executeToolCalls(message.toolCall.functionCalls)
			
			message.toolCall.functionCalls.forEach((functionCall, index) => {
				addDebugLine(
					`Tool call: ${functionCall.name}(${JSON.stringify(
						functionCall.args ?? functionCall.arguments ?? {}
					)})`
				)
				addMessage(
					'tool',
					`Tool ${responses[index].name} returned ${JSON.stringify(
						responses[index].response
					)}`
				)
			})
			
			currentSession?.sendToolResponse({functionResponses: responses})
		}
		
		if (message.toolCallCancellation?.ids?.length) {
			addDebugLine(
				`Tool call cancellation received for ids: ${message.toolCallCancellation.ids.join(', ')}`
			)
			addMessage('system', 'Tool execution cancelled by the model.')
		}
		
		if (!content) {
			return
		}
		
		if (content.inputTranscription?.text) {
			addMessage('user-transcript', content.inputTranscription.text, {
				append: !content.inputTranscription.finished
			})
		}
		
		if (content.outputTranscription?.text) {
			addMessage('assistant-transcript', content.outputTranscription.text, {
				append: !content.outputTranscription.finished
			})
		}
		
		for (const part of content.modelTurn?.parts || []) {
			if (part.text) {
				addMessage('assistant', part.text)
			}
			
			if (part.inlineData?.mimeType?.startsWith('audio/')) {
				ensureAudioPlayer()
					.then((player) => player.play(part.inlineData.data))
					.catch((error) => {
						addDebugLine(`Audio playback failed: ${error.message}`)
					})
			}
		}
		
		if (content.interrupted) {
			addDebugLine('Generation interrupted.')
			audioPlayerRef.current?.interrupt()
			addMessage('system', 'Assistant output interrupted.')
		}
		
		if (content.turnComplete) {
			const reason = content.turnCompleteReason || 'TURN_COMPLETE_REASON_UNSPECIFIED'
			addDebugLine(`Turn complete. Reason: ${reason}`)
			
			if (pendingTurnUsageRef.current) {
				const usage = pendingTurnUsageRef.current
				
				if (usage.isAuthoritative) {
					sessionTotalTokensRef.current += usage.turnTotalTokens || 0
				}
				else {
					sessionHasPartialUsageRef.current = true
				}
				
				const sessionTotalTokens = sessionTotalTokensRef.current
				pendingTurnUsageRef.current = null
				
				addMessage('usage', '', {
					usage: {
						...usage,
						sessionTotalTokens,
						sessionTotalIsLowerBound: sessionHasPartialUsageRef.current
					}
				})
				addDebugLine(
					usage.isAuthoritative
						? `Tokens used. Turn total: ${usage.turnTotalTokens}, Session total: ${sessionTotalTokens}`
						: `Partial token usage only. Prompt=${usage.inputTokens ?? 'n/a'}, Response=${usage.outputTokens ?? 'n/a'}, ToolUse=${usage.toolUsePromptTokens ?? 'n/a'}, Thoughts=${usage.thoughtsTokens ?? 'n/a'}`
				)
			}
		}
	}
	
	async function connect() {
		if (!hasLiveToken) {
			setStatus('error')
			setStatusDetail('No token found. Generate a token first.')
			addMessage('system', 'Generate a token first, then connect.')
			return
		}
		
		if (!canConnect) {
			return
		}
		
		closeRequestedRef.current = false
		pendingTurnUsageRef.current = null
		sessionTotalTokensRef.current = 0
		sessionHasPartialUsageRef.current = false
		setStatus('connecting')
		setIsSessionReady(false)
		setStatusDetail('Connecting to Gemini Live...')
		addDebugLine(`Opening Live session for ${FIXED_MODEL_ID}`)
		
		try {
			await ensureAudioPlayer()
			
			const {session} = await connectLiveSession({
				apiKey: liveApiKey,
				settings: settingsRef.current,
				callbacks: {
					onopen: () => {
						setStatus('connected')
						setStatusDetail('Socket open. Waiting for session setup...')
						addDebugLine('WebSocket open. Waiting for setupComplete.')
					},
					onmessage: handleSessionMessage,
					onerror: (event) => {
						const nextMessage =
							event?.message || event?.error?.message || 'Connection error'
						setStatus('error')
						setStatusDetail(nextMessage)
						addDebugLine(`Socket error: ${nextMessage}`)
						addMessage('system', `Connection error: ${nextMessage}`)
					},
					onclose: (event) => {
						const closeDetail = event?.reason
							? `code=${event.code} reason=${event.reason}`
							: `code=${event?.code ?? 'unknown'}`
						const tokenExpiredForNewSessions =
							event?.reason?.includes('new_session_expire_time deadline exceeded')
						
						addDebugLine(`WebSocket closed. ${closeDetail}`)
						teardownMedia()
						sessionRef.current = null
						setIsSessionReady(false)
						
						if (closeRequestedRef.current || event?.code === 1000) {
							setStatus('disconnected')
							setStatusDetail('Session closed.')
							return
						}
						
						setStatus('error')
						if (tokenExpiredForNewSessions) {
							setStatusDetail('Ephemeral token expired for new sessions.')
							addMessage(
								'system',
								'Ephemeral token expired for new sessions. Use the Generate New Token button, then connect again.'
							)
							return
						}
						
						setStatusDetail(`Session closed unexpectedly. ${closeDetail}`)
						addMessage('system', `Connection closed unexpectedly. ${closeDetail}`)
					}
				}
			})
			
			sessionRef.current = session
		}
		catch (error) {
			setStatus('error')
			setStatusDetail(error.message)
			addDebugLine(`Connect failed: ${error.message}`)
			addMessage('system', `Connect failed: ${error.message}`)
		}
	}
	
	async function refreshEphemeralToken() {
		setStatusDetail('Generating fresh ephemeral token...')
		addDebugLine('Generating a fresh ephemeral token from the UI.')
		
		try {
			const token = await generateEphemeralToken()
			setLiveApiKey(token.name)
			setStatus('disconnected')
			setStatusDetail('Fresh token ready. Connect again.')
			addDebugLine('Fresh ephemeral token generated successfully.')
			addMessage('system', 'Fresh ephemeral token generated. You can connect again now.')
		}
		catch (error) {
			setStatus('error')
			setStatusDetail(`Token generation failed: ${error.message}`)
			addDebugLine(`Token generation failed: ${error.message}`)
			addMessage('system', `Token generation failed: ${error.message}`)
		}
	}
	
	const teardownMedia = useCallback(() => {
		recorderRef.current?.stop()
		recorderRef.current = null
		cameraRef.current?.stop()
		cameraRef.current = null
		screenRef.current?.stop()
		screenRef.current = null
		setIsMicOn(false)
		setIsCameraOn(false)
		setIsScreenOn(false)
		clearPreview()
	}, [clearPreview])
	
	const teardownSession = useCallback(() => {
		closeRequestedRef.current = true
		pendingTurnUsageRef.current = null
		sessionTotalTokensRef.current = 0
		sessionHasPartialUsageRef.current = false
		teardownMedia()
		
		if (sessionRef.current) {
			sessionRef.current.close()
			sessionRef.current = null
		}
		
		setIsSessionReady(false)
	}, [teardownMedia])
	
	useEffect(() => {
		const refreshTimeoutId = window.setTimeout(() => {
			void refreshDevices()
		}, 0)
		
		const handleDeviceChange = () => {
			void refreshDevices()
		}
		
		navigator.mediaDevices?.addEventListener?.('devicechange', handleDeviceChange)
		
		return () => {
			window.clearTimeout(refreshTimeoutId)
			navigator.mediaDevices?.removeEventListener?.('devicechange', handleDeviceChange)
			teardownSession()
			audioPlayerRef.current?.destroy()
		}
	}, [refreshDevices, teardownSession])
	
	function disconnect() {
		if (!canDisconnect) {
			return
		}
		
		closeRequestedRef.current = true
		addDebugLine('Disconnect requested by user.')
		setStatusDetail('Disconnecting...')
		teardownSession()
		setStatus('disconnected')
		setStatusDetail('Disconnected.')
	}
	
	async function toggleMic() {
		if (!canInteract || !sessionRef.current) {
			addMessage('system', 'Wait for session setup before turning on the microphone.')
			return
		}
		
		if (isMicOn) {
			recorderRef.current?.stop()
			recorderRef.current = null
			
			if (settingsRef.current.disableActivityDetection) {
				sessionRef.current.sendRealtimeInput({activityEnd: {}})
			}
			else {
				sessionRef.current.sendRealtimeInput({audioStreamEnd: true})
			}
			
			setIsMicOn(false)
			addDebugLine('Microphone stopped.')
			addMessage('system', 'Microphone off.')
			return
		}
		
		try {
			if (settingsRef.current.disableActivityDetection) {
				sessionRef.current.sendRealtimeInput({activityStart: {}})
			}
			
			const recorder = new AudioRecorder({
				onChunk: (audioBlob) => {
					sessionRef.current?.sendRealtimeInput({audio: audioBlob})
				}
			})
			
			await recorder.start(selectedMic || undefined)
			recorderRef.current = recorder
			setIsMicOn(true)
			addDebugLine('Microphone streaming at 16 kHz PCM.')
			addMessage('system', 'Microphone on.')
			await refreshDevices()
		}
		catch (error) {
			addDebugLine(`Microphone failed: ${error.message}`)
			addMessage('system', `Microphone failed: ${error.message}`)
		}
	}
	
	async function toggleCamera() {
		if (!canInteract || !sessionRef.current) {
			addMessage('system', 'Wait for session setup before turning on the camera.')
			return
		}
		
		if (isCameraOn) {
			cameraRef.current?.stop()
			cameraRef.current = null
			setIsCameraOn(false)
			addDebugLine('Camera stream stopped.')
			addMessage('system', 'Camera off.')
			syncPreview()
			
			return
		}
		
		try {
			const streamer = new CameraStreamer({
				onFrame: (videoBlob) => {
					sessionRef.current?.sendRealtimeInput({video: videoBlob})
				}
			})
			
			const stream = await streamer.start({
				deviceId: selectedCamera || undefined,
				fps: 1,
				width: 640,
				height: 480
			})
			
			cameraRef.current = streamer
			setIsCameraOn(true)
			attachPreview(stream, 'Camera preview')
			addDebugLine('Camera streaming at 1 FPS.')
			addMessage('system', 'Camera on.')
			await refreshDevices()
		}
		catch (error) {
			addDebugLine(`Camera failed: ${error.message}`)
			addMessage('system', `Camera failed: ${error.message}`)
		}
	}
	
	async function toggleScreen() {
		if (!canInteract || !sessionRef.current) {
			addMessage('system', 'Wait for session setup before sharing the screen.')
			return
		}
		
		if (isScreenOn) {
			screenRef.current?.stop()
			screenRef.current = null
			setIsScreenOn(false)
			addDebugLine('Screen sharing stopped.')
			addMessage('system', 'Screen share off.')
			syncPreview()
			
			return
		}
		
		try {
			const streamer = new ScreenStreamer({
				onFrame: (videoBlob) => {
					sessionRef.current?.sendRealtimeInput({video: videoBlob})
				},
				onEnded: () => {
					setIsScreenOn(false)
					addDebugLine('Screen sharing ended by the browser.')
					screenRef.current = null
					syncPreview()
				}
			})
			
			const stream = await streamer.start({fps: 0.5, width: 1280, height: 720})
			screenRef.current = streamer
			setIsScreenOn(true)
			attachPreview(stream, 'Screen preview')
			addDebugLine('Screen sharing streaming at 0.5 FPS.')
			addMessage('system', 'Screen share on.')
		}
		catch (error) {
			addDebugLine(`Screen share failed: ${error.message}`)
			addMessage('system', `Screen share failed: ${error.message}`)
		}
	}
	
	function sendTextMessage() {
		const nextMessage = chatInput.trim()
		
		if (!nextMessage) {
			return
		}
		
		if (!canInteract || !sessionRef.current) {
			addMessage('system', 'Wait for session setup before sending a text message.')
			return
		}
		
		sessionRef.current.sendRealtimeInput({text: nextMessage})
		addDebugLine(`Realtime text sent: ${nextMessage}`)
		addMessage('user', nextMessage)
		setChatInput('')
	}
	
	function updateSetting(key, value) {
		setSettings((current) => ({
			...current,
			[key]: value
		}))
	}
	
	function navigate(nextPath) {
		if (nextPath === pathname) {
			return
		}
		
		window.history.pushState({}, '', nextPath)
		setPathname(nextPath)
	}
	
	return (
		<div className='studio-shell'>
			<aside className='studio-sidebar'>
				<div className='space-y-6'>
					<div className='sidebar-panel space-y-1'>
						<div className='text-sm text-slate-500'>Gemini 3.1 Flash Live Preview</div>
					</div>
					
					<nav className='space-y-1.5'>
						{NAV_ITEMS.map((item) => (
							<SidebarLink
								key={item.path}
								icon={item.icon}
								label={item.label}
								active={pathname === item.path}
								onClick={() => navigate(item.path)}
							/>
						))}
					</nav>
				</div>
				
				<div className='space-y-3 text-sm text-slate-500'>
					<div className='sidebar-panel rounded-2xl border border-white/8 bg-white/[0.03] p-4'>
						<div className='text-xs uppercase tracking-[0.24em] text-slate-500'>Tool</div>
						<div className='mt-2 text-slate-200'>
							{groundingDisablesTools ? 'Grounding only' : `${HEALTH_TOOL_NAMES.length} local tools`}
						</div>
						{groundingDisablesTools ? null : (
							<div className='mt-2 space-y-1 text-xs leading-5 text-slate-500'>
								{HEALTH_TOOL_NAMES.map((toolName) => (
									<div key={toolName} className='break-all text-sm'>
										{toolName}
									</div>
								))}
							</div>
						)}
					</div>
					<div className='sidebar-panel rounded-2xl border border-white/8 bg-white/[0.03] p-4'>
						<div className='text-xs uppercase tracking-[0.24em] text-slate-500'>Messages</div>
						<div className='mt-2 text-slate-200'>{messageCount}</div>
					</div>
				</div>
			</aside>
			
			<main className='studio-main'>
				<div className='studio-topbar'>
					<div className='flex items-center gap-3'>
						<div>
							<div className='text-2xl font-semibold text-white'>
								{pathname === '/' ? 'Health Coach' : pathname === '/settings' ? 'Run settings' : 'System'}
							</div>
							<div className='text-xs text-slate-500'>
								{pathname === '/'
									? ''
									: pathname === '/settings'
										? 'Live session controls'
										: 'Assistant instructions'}
							</div>
						</div>
					</div>
					
					<div className='flex items-center gap-3'>
						{!hasLiveToken ? (
							<button
								type='button'
								className='run-button'
								onClick={refreshEphemeralToken}
							>
								Generate Token
							</button>
						) : (
							<button
								type='button'
								className='run-button'
								onClick={canDisconnect ? disconnect : connect}
								disabled={!canConnect && !canDisconnect}
							>
								{canDisconnect ? 'Disconnect' : 'Connect'}
							</button>
						)}
						{hasLiveToken && status === 'error' ? (
							<button
								type='button'
								className='run-button'
								onClick={refreshEphemeralToken}
							>
								Generate New Token
							</button>
						) : null}
						<StatusPill
							status={status}
							ready={isSessionReady}
							detail={statusDetail}
						/>
					</div>
				</div>
				
				{isPlayground ? (
					<PlaygroundView
						canConnect={canConnect}
						canDisconnect={canDisconnect}
						canInteract={canInteract}
						hasLiveToken={hasLiveToken}
						connect={connect}
						disconnect={disconnect}
						toggleMic={toggleMic}
						toggleCamera={toggleCamera}
						toggleScreen={toggleScreen}
						isMicOn={isMicOn}
						isCameraOn={isCameraOn}
						isScreenOn={isScreenOn}
						messages={messages}
						chatInput={chatInput}
						setChatInput={setChatInput}
						sendTextMessage={sendTextMessage}
						conversationFeedRef={conversationFeedRef}
						handleStageWheel={handleStageWheel}
						previewRef={previewRef}
						previewStream={previewStream}
						previewTitle={previewTitle}
					/>
				) : pathname === '/settings' ? (
					<SettingsView
						settings={settings}
						updateSetting={updateSetting}
						selectedMic={selectedMic}
						setSelectedMic={setSelectedMic}
						micOptions={micOptions}
						selectedCamera={selectedCamera}
						setSelectedCamera={setSelectedCamera}
						cameraOptions={cameraOptions}
						debugLines={debugLines}
						setupJson={setupJson}
					/>
				) : (
					<SystemView
						systemInstructions={settings.systemInstructions}
						setSystemInstructions={(value) => updateSetting('systemInstructions', value)}
						resetSystemInstructions={() =>
							updateSetting('systemInstructions', DEFAULT_SYSTEM_PROMPT)
						}
					/>
				)}
			</main>
		</div>
	)
}

function PlaygroundView({
	                        canConnect,
	                        canDisconnect,
	                        canInteract,
	                        hasLiveToken,
	                        connect,
	                        disconnect,
	                        toggleMic,
	                        toggleCamera,
	                        toggleScreen,
	                        isMicOn,
	                        isCameraOn,
	                        isScreenOn,
	                        messages,
	                        chatInput,
	                        setChatInput,
	                        sendTextMessage,
	                        conversationFeedRef,
	                        handleStageWheel,
	                        previewRef,
	                        previewStream,
	                        previewTitle
                        }) {
	const showFeed = messages.length > 1
	const showPreview = Boolean(previewStream)
	
	return (
		<div className='playground-layout'>
			<section className='playground-stage' onWheel={showFeed ? handleStageWheel : undefined}>
				{showFeed ? (
					<div className='conversation-shell'>
						<div ref={conversationFeedRef} className='conversation-feed'>
							{messages.map((message) => (
								<ChatBubble key={message.id} message={message}/>
							))}
						</div>
					</div>
				) : (
					<div className='playground-empty'>
						<h1 className='font-display text-5xl tracking-tight text-white'>
							Talk to Gemini live
						</h1>
						<div className='mt-6 flex flex-wrap items-center justify-center gap-3'>
							<StageButton
								label={canDisconnect ? 'Disconnect' : 'Connect'}
								onClick={canDisconnect ? disconnect : connect}
								active={canDisconnect}
								disabled={!canConnect && !canDisconnect}
								icon={
									canDisconnect ? (
										<PhoneOff className='h-4 w-4'/>
									) : (
										<PhoneCall className='h-4 w-4'/>
									)
								}
							/>
							<StageButton
								label={isMicOn ? 'Stop Voice Input' : 'Start Voice Input'}
								onClick={toggleMic}
								active={isMicOn}
								disabled={!canInteract}
								icon={isMicOn ? <Mic className='h-4 w-4'/> : <MicOff className='h-4 w-4'/>}
							/>
							<StageButton
								label={isCameraOn ? 'Stop Webcam' : 'Webcam'}
								onClick={toggleCamera}
								active={isCameraOn}
								disabled={!canInteract}
								icon={isCameraOn ? <Camera className='h-4 w-4'/> : <CameraOff className='h-4 w-4'/>}
							/>
							<StageButton
								label={isScreenOn ? 'Stop Share' : 'Share Screen'}
								onClick={toggleScreen}
								active={isScreenOn}
								disabled={!canInteract}
								icon={isScreenOn ? <ScreenShare className='h-4 w-4'/> : <ScreenShareOff className='h-4 w-4'/>}
							/>
						</div>
						<div className='playground-hint'>
							{canInteract
								? 'Session ready. Start speaking or type below.'
								: hasLiveToken
									? 'Connect first before starting voice input.'
									: 'Generate a token first, then connect.'}
						</div>
					</div>
				)}
				
				{showPreview ? (
					<div className='stage-preview-frame'>
						<div className='preview-frame-label'>{previewTitle}</div>
						<video
							ref={previewRef}
							autoPlay
							playsInline
							muted
							className='h-full w-full object-cover'
						/>
					</div>
				) : null}
			</section>
			
			<div className='composer-shell'>
				<div className='composer-inner'>
					<input
						className='composer-input'
						value={chatInput}
						disabled={!canInteract}
						placeholder={
							canInteract
								? 'Start typing a prompt'
								: hasLiveToken
									? 'Connect and wait for session setup'
									: 'Generate a token, then connect'
						}
						onChange={(event) => setChatInput(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === 'Enter') {
								sendTextMessage()
							}
						}}
					/>
					
					<div className='composer-toolbar'>
						<div className='flex items-center gap-2'>
							<RoundIconButton
								onClick={toggleMic}
								disabled={!canInteract}
								title='Talk'
								icon={isMicOn ? <Mic className='h-4 w-4'/> : <MicOff className='h-4 w-4'/>}
							/>
							<RoundIconButton
								onClick={toggleCamera}
								disabled={!canInteract}
								title='Webcam'
								icon={isCameraOn ? <Camera className='h-4 w-4'/> : <CameraOff className='h-4 w-4'/>}
							/>
							<RoundIconButton
								onClick={toggleScreen}
								disabled={!canInteract}
								title='Screen'
								icon={isScreenOn ? <ScreenShare className='h-4 w-4'/> : <ScreenShareOff className='h-4 w-4'/>}
							/>
							<button
								type='button'
								className='run-button'
								onClick={sendTextMessage}
								disabled={!canInteract}
							>
								Send
								<Send className='h-4 w-4'/>
							</button>
						</div>
					</div>
				</div>
			</div>
		</div>
	)
}

function SettingsView({
	                      settings,
	                      updateSetting,
	                      selectedMic,
	                      setSelectedMic,
	                      micOptions,
	                      selectedCamera,
	                      setSelectedCamera,
	                      cameraOptions,
	                      debugLines,
	                      setupJson
                      }) {
	return (
		<div className='settings-layout'>
			<section className='settings-column'>
				<SettingsCard
					title='Model'
					body={
						<>
							<div className='settings-value-card'>
								<div className='text-sm font-medium text-white'>{FIXED_MODEL_ID}</div>
								<div className='mt-1 text-xs leading-6 text-slate-500'>
									Low-latency audio-to-audio model with transcription and multimodal support.
								</div>
							</div>
						</>
					}
				/>
				
				<SettingsCard
					title='Voice'
					body={
						<Field label='Voice'>
							<select
								className='settings-input'
								value={settings.voiceName}
								onChange={(event) => updateSetting('voiceName', event.target.value)}
							>
								{VOICE_OPTIONS.map((voice) => (
									<option key={voice} value={voice}>
										{voice}
									</option>
								))}
							</select>
						</Field>
					}
				/>
				
				<SettingsCard
					title='Input devices'
					body={
						<div className='space-y-4'>
							<Field label='Microphone'>
								<select
									className='settings-input'
									value={selectedMic}
									onChange={(event) => setSelectedMic(event.target.value)}
								>
									<option value=''>Default microphone</option>
									{micOptions.map((device) => (
										<option key={device.deviceId} value={device.deviceId}>
											{device.label || `Microphone ${device.deviceId.slice(0, 6)}`}
										</option>
									))}
								</select>
							</Field>
							<Field label='Camera'>
								<select
									className='settings-input'
									value={selectedCamera}
									onChange={(event) => setSelectedCamera(event.target.value)}
								>
									<option value=''>Default camera</option>
									{cameraOptions.map((device) => (
										<option key={device.deviceId} value={device.deviceId}>
											{device.label || `Camera ${device.deviceId.slice(0, 6)}`}
										</option>
									))}
								</select>
							</Field>
						</div>
					}
				/>
			</section>
			
			<section className='settings-column'>
				<SettingsCard
					title='Transcription'
					body={
						<div className='space-y-3'>
							<InlineToggle
								label='Enable input transcription'
								checked={settings.enableInputTranscription}
								onChange={(event) =>
									updateSetting('enableInputTranscription', event.target.checked)
								}
							/>
							<InlineToggle
								label='Enable output transcription'
								checked={settings.enableOutputTranscription}
								onChange={(event) =>
									updateSetting('enableOutputTranscription', event.target.checked)
								}
							/>
						</div>
					}
				/>
				
				<SettingsCard
					title='Session Context'
					body={
						<div className='space-y-4'>
							<RangeField
								label={`Temperature ${settings.temperature.toFixed(1)}`}
								min={0.1}
								max={2}
								step={0.1}
								value={settings.temperature}
								className='settings-slider'
								onChange={(event) =>
									updateSetting('temperature', Number(event.target.value))
								}
							/>
							<RangeField
								label={`Output volume ${settings.volume}%`}
								min={0}
								max={100}
								step={1}
								value={settings.volume}
								className='settings-slider'
								onChange={(event) =>
									updateSetting('volume', Number(event.target.value))
								}
							/>
							<InlineToggle
								label='Enable Google grounding'
								checked={settings.enableGrounding}
								onChange={(event) =>
									updateSetting('enableGrounding', event.target.checked)
								}
							/>
						</div>
					}
				/>
				
				<SettingsCard
					title='VAD'
					body={
						<div className='space-y-4'>
							<InlineToggle
								label='Disable automatic activity detection'
								checked={settings.disableActivityDetection}
								onChange={(event) =>
									updateSetting('disableActivityDetection', event.target.checked)
								}
							/>
							<div className='grid gap-4 md:grid-cols-2'>
								<Field label='Silence duration (ms)'>
									<input
										className='settings-input'
										type='number'
										min='500'
										max='10000'
										step='100'
										value={settings.silenceDurationMs}
										onChange={(event) =>
											updateSetting('silenceDurationMs', Number(event.target.value))
										}
									/>
								</Field>
								<Field label='Prefix padding (ms)'>
									<input
										className='settings-input'
										type='number'
										min='0'
										max='2000'
										step='100'
										value={settings.prefixPaddingMs}
										onChange={(event) =>
											updateSetting('prefixPaddingMs', Number(event.target.value))
										}
									/>
								</Field>
								<Field label='End sensitivity'>
									<select
										className='settings-input'
										value={settings.endOfSpeechSensitivity}
										onChange={(event) =>
											updateSetting('endOfSpeechSensitivity', event.target.value)
										}
									>
										{END_SENSITIVITY_OPTIONS.map((option) => (
											<option key={option.value} value={option.value}>
												{option.label}
											</option>
										))}
									</select>
								</Field>
								<Field label='Start sensitivity'>
									<select
										className='settings-input'
										value={settings.startOfSpeechSensitivity}
										onChange={(event) =>
											updateSetting('startOfSpeechSensitivity', event.target.value)
										}
									>
										{START_SENSITIVITY_OPTIONS.map((option) => (
											<option key={option.value} value={option.value}>
												{option.label}
											</option>
										))}
									</select>
								</Field>
							</div>
							<Field label='Activity handling'>
								<select
									className='settings-input'
									value={settings.activityHandling}
									onChange={(event) =>
										updateSetting('activityHandling', event.target.value)
									}
								>
									{ACTIVITY_HANDLING_OPTIONS.map((option) => (
										<option key={option.value} value={option.value}>
											{option.label}
										</option>
									))}
								</select>
							</Field>
						</div>
					}
				/>
			</section>
			
			<section className='settings-column'>
				<SettingsCard
					title='Debug'
					body={
						<div className='debug-panel'>
							{debugLines.map((line) => (
								<div key={line} className='debug-line'>
									{line}
								</div>
							))}
						</div>
					}
				/>
				
				<SettingsCard
					title='Setup JSON'
					body={<pre className='settings-code'>{setupJson}</pre>}
				/>
			</section>
		</div>
	)
}

function SystemView({
	                    systemInstructions,
	                    setSystemInstructions,
	                    resetSystemInstructions
                    }) {
	return (
		<div className='system-layout'>
			<section className='system-editor-card'>
				<div className='mb-6'>
					<div className='flex flex-wrap items-start justify-between gap-4'>
						<div>
							<div className='text-xs uppercase tracking-[0.24em] text-slate-500'>
								System instructions
							</div>
							<h1 className='mt-3 font-display text-4xl text-white'>
								Define how Gemini should behave.
							</h1>
							<p className='mt-3 max-w-3xl text-sm leading-7 text-slate-400'>
								Keep this focused on tone, style, safety, and tool behavior. This page is
								intentionally separate from the playground so the main chat stays clean.
							</p>
						</div>
						
						<button
							type='button'
							className='run-button'
							onClick={resetSystemInstructions}
						>
							Restore default prompt
						</button>
					</div>
				</div>
				
				<textarea
					className='system-editor'
					value={systemInstructions}
					onChange={(event) => setSystemInstructions(event.target.value)}
				/>
			</section>
		</div>
	)
}

function SidebarLink({icon, label, active, onClick}) {
	const IconComponent = icon
	
	return (
		<button
			type='button'
			className={classNames('sidebar-link', active && 'sidebar-link-active')}
			onClick={onClick}
			title={label}
		>
			<div className='flex items-center gap-3'>
				<IconComponent className='h-4 w-4'/>
				<span className='sidebar-link-label'>{label}</span>
			</div>
			<ChevronRight className='h-4 w-4 text-slate-600 transition-opacity duration-200'/>
		</button>
	)
}

function StatusPill({status, ready, detail}) {
	return (
		<div
			className={classNames(
				'status-pill',
				ready && 'status-pill-ready',
				status === 'error' && 'status-pill-error'
			)}
		>
			<span className='h-2 w-2 rounded-full bg-current'/>
			<span>{detail}</span>
		</div>
	)
}

function StageButton({label, onClick, active, disabled, icon}) {
	return (
		<button
			type='button'
			onClick={onClick}
			disabled={disabled}
			className={classNames('stage-button', active && 'stage-button-active')}
		>
			{icon}
			{label}
		</button>
	)
}

function RoundIconButton({onClick, disabled, title, icon}) {
	return (
		<button type='button' className='round-icon-button' onClick={onClick} disabled={disabled} title={title}>
			{icon}
		</button>
	)
}

function SettingsCard({title, body}) {
	return (
		<section className='settings-card'>
			<div className='mb-4 text-sm font-semibold text-white'>{title}</div>
			{body}
		</section>
	)
}

function Field({label, children}) {
	return (
		<label className='space-y-2 text-sm text-slate-300'>
			<div>{label}</div>
			{children}
		</label>
	)
}

function RangeField({label, className, ...props}) {
	return (
		<label className='space-y-2 text-sm text-slate-300'>
			<div>{label}</div>
			<input type='range' className={classNames('slider', className)} {...props} />
		</label>
	)
}

function InlineToggle({label, checked, onChange}) {
	return (
		<label className='inline-toggle'>
			<span>{label}</span>
			<input type='checkbox' className='h-4 w-4 accent-slate-200' checked={checked} onChange={onChange}/>
		</label>
	)
}

function ChatBubble({message}) {
	const [isExpanded, setIsExpanded] = useState(false)
	const [isUsageModalOpen, setIsUsageModalOpen] = useState(false)
	const bubbleClass = {
		user: 'chat-bubble-user',
		assistant: 'chat-bubble-assistant',
		system: 'chat-bubble-system',
		tool: 'chat-bubble-tool',
		'user-transcript': 'chat-bubble-user-transcript',
		'assistant-transcript': 'chat-bubble-assistant-transcript'
	}[message.kind]
	
	const label = {
		user: 'You',
		assistant: 'Gemini',
		system: 'System',
		tool: 'Tool',
		usage: 'Usage',
		'user-transcript': 'You, transcribed',
		'assistant-transcript': 'Gemini, transcribed'
	}[message.kind]
	
	const toolSummary = (() => {
		if (message.kind !== 'tool') {
			return null
		}
		
		const match = message.text.match(/^Tool\s+([a-z_]+)\s+returned/i)
		if (match) {
			return `${match[1]} result`
		}
		
		return 'Tool result'
	})()
	
	const usage = message.usage
	
	useEffect(() => {
		if (!isUsageModalOpen) {
			return
		}
		
		function handleKeyDown(event) {
			if (event.key === 'Escape') {
				setIsUsageModalOpen(false)
			}
		}
		
		window.addEventListener('keydown', handleKeyDown)
		return () => {
			window.removeEventListener('keydown', handleKeyDown)
		}
	}, [isUsageModalOpen])
	
	if (message.kind === 'usage' && usage) {
		const responseDetails = Array.isArray(usage.raw?.responseTokensDetails)
			? usage.raw.responseTokensDetails
			: []
		const promptDetails = Array.isArray(usage.raw?.promptTokensDetails)
			? usage.raw.promptTokensDetails
			: []
		const toolUseDetails = Array.isArray(usage.raw?.toolUsePromptTokensDetails)
			? usage.raw.toolUsePromptTokensDetails
			: []
		
		return (
			<>
				<div className='usage-inline-row'>
					<button
						type='button'
						className='usage-inline-trigger'
						onClick={() => setIsUsageModalOpen(true)}
					>
						{formatUsageLabel(usage)}
					</button>
				</div>
				{isUsageModalOpen ? (
					<div
						className='usage-modal-backdrop'
						role='presentation'
						onClick={() => setIsUsageModalOpen(false)}
					>
						<div
							className='usage-modal'
							role='dialog'
							aria-modal='true'
							aria-labelledby={`usage-modal-title-${message.id}`}
							onClick={(event) => event.stopPropagation()}
						>
							<div className='usage-modal-header'>
								<div>
									<div className='usage-modal-kicker'>Usage</div>
									<h2
										id={`usage-modal-title-${message.id}`}
										className='usage-modal-title'
									>
										API-reported token usage
									</h2>
								</div>
								<button
									type='button'
									className='usage-modal-close'
									onClick={() => setIsUsageModalOpen(false)}
								>
									Close
								</button>
							</div>
							<div className='usage-modal-body'>
								<div className='usage-modal-grid'>
									<UsageStat
										label='Turn total'
										value={
											usage.isAuthoritative
												? formatUsageValue(usage.turnTotalTokens)
												: 'Partial only'
										}
									/>
									<UsageStat
										label='Session total'
										value={
											usage.sessionTotalIsLowerBound
												? `At least ${formatUsageValue(usage.sessionTotalTokens)}`
												: formatUsageValue(usage.sessionTotalTokens)
										}
									/>
									<UsageStat label='Prompt' value={formatUsageValue(usage.inputTokens)} />
									<UsageStat label='Response' value={formatUsageValue(usage.outputTokens)} />
									<UsageStat
										label='Tool use prompt'
										value={formatUsageValue(usage.toolUsePromptTokens)}
									/>
									<UsageStat
										label='Thoughts'
										value={formatUsageValue(usage.thoughtsTokens)}
									/>
								</div>
								
								{!usage.isAuthoritative ? (
									<div className='usage-modal-note'>
										This turn did not include `totalTokenCount`, so the usage is partial.
									</div>
								) : null}
								
								<UsageDetailsSection title='Prompt Modalities' details={promptDetails}/>
								<UsageDetailsSection title='Response Modalities' details={responseDetails}/>
								<UsageDetailsSection title='Tool Use Modalities' details={toolUseDetails}/>
								
								<div className='usage-modal-section'>
									<div className='usage-modal-section-title'>Raw Usage Metadata</div>
									<pre className='usage-modal-code'>
										{JSON.stringify(usage.raw, null, 2)}
									</pre>
								</div>
							</div>
						</div>
					</div>
				) : null}
			</>
		)
	}
	
	return (
		<article className={classNames('chat-bubble', bubbleClass)}>
			<div className='mb-2 text-[10px] uppercase tracking-[0.2em] text-white/45'>{label}</div>
			{message.kind === 'tool' ? (
				<div className='space-y-3'>
					<button
						type='button'
						className='flex w-full items-center justify-between gap-4 py-1 text-left text-sm text-white/90 transition hover:text-white'
						onClick={() => setIsExpanded((current) => !current)}
					>
						<span>{toolSummary}</span>
						<span className='text-xs uppercase tracking-[0.16em] text-white/50'>
              {isExpanded ? 'Collapse' : 'Expand'}
            </span>
					</button>
					
					{isExpanded ? (
						<pre className='whitespace-pre-wrap break-all text-sm leading-6'>
              {message.text}
            </pre>
					) : null}
				</div>
			) : (
				<div className='whitespace-pre-wrap text-base leading-6'>{message.text}</div>
			)}
		</article>
	)
}

function UsageStat({label, value}) {
	return (
		<div className='usage-stat-card'>
			<div className='usage-stat-label'>{label}</div>
			<div className='usage-stat-value'>{value}</div>
		</div>
	)
}

function UsageDetailsSection({title, details}) {
	if (!details.length) {
		return null
	}
	
	return (
		<div className='usage-modal-section'>
			<div className='usage-modal-section-title'>{title}</div>
			<div className='usage-detail-list'>
				{details.map((detail, index) => (
					<div
						key={`${title}-${detail.modality || 'unknown'}-${detail.tokenCount || 0}-${index}`}
						className='usage-detail-row'
					>
						<span>{detail.modality || 'UNKNOWN'}</span>
						<span>{typeof detail.tokenCount === 'number' ? formatTokenCount(detail.tokenCount) : 'Unavailable'}</span>
					</div>
				))}
			</div>
		</div>
	)
}
