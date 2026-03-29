import {ActivityHandling, GoogleGenAI, Modality, TurnCoverage} from '@google/genai'
import {HEALTH_TOOL_DEFINITIONS} from './tools.js'

export const FIXED_MODEL_ID = 'gemini-3.1-flash-live-preview'
const LIVE_API_VERSION = 'v1alpha'

export const VOICE_OPTIONS = ['Puck', 'Charon', 'Kore', 'Fenrir', 'Aoede']

export const END_SENSITIVITY_OPTIONS = [
	{value: 'END_SENSITIVITY_UNSPECIFIED', label: 'Default'},
	{value: 'END_SENSITIVITY_HIGH', label: 'High'},
	{value: 'END_SENSITIVITY_LOW', label: 'Low'}
]

export const START_SENSITIVITY_OPTIONS = [
	{value: 'START_SENSITIVITY_UNSPECIFIED', label: 'Default'},
	{value: 'START_SENSITIVITY_HIGH', label: 'High'},
	{value: 'START_SENSITIVITY_LOW', label: 'Low'}
]

export const ACTIVITY_HANDLING_OPTIONS = [
	{
		value: ActivityHandling.ACTIVITY_HANDLING_UNSPECIFIED,
		label: 'Default (interrupts)'
	},
	{
		value: ActivityHandling.START_OF_ACTIVITY_INTERRUPTS,
		label: 'Interrupt on new activity'
	},
	{
		value: ActivityHandling.NO_INTERRUPTION,
		label: 'Do not interrupt'
	}
]

export function buildLiveConfig(settings) {
	return {
		responseModalities: [Modality.AUDIO],
		temperature: Number(settings.temperature),
		systemInstruction: {
			parts: [{text: settings.systemInstructions}]
		},
		speechConfig: {
			voiceConfig: {
				prebuiltVoiceConfig: {
					voiceName: settings.voiceName
				}
			}
		},
		tools: settings.enableGrounding
			? [{googleSearch: {}}]
			: [{functionDeclarations: HEALTH_TOOL_DEFINITIONS}],
		inputAudioTranscription: settings.enableInputTranscription ? {} : undefined,
		outputAudioTranscription: settings.enableOutputTranscription ? {} : undefined,
		realtimeInputConfig: {
			automaticActivityDetection: {
				disabled: settings.disableActivityDetection,
				silenceDurationMs: Number(settings.silenceDurationMs),
				prefixPaddingMs: Number(settings.prefixPaddingMs),
				endOfSpeechSensitivity: settings.endOfSpeechSensitivity,
				startOfSpeechSensitivity: settings.startOfSpeechSensitivity
			},
			activityHandling: settings.activityHandling,
			turnCoverage: TurnCoverage.TURN_INCLUDES_AUDIO_ACTIVITY_AND_ALL_VIDEO
		}
	}
}

export function formatSetupPayload(settings) {
	return {
		model: FIXED_MODEL_ID,
		config: buildLiveConfig(settings)
	}
}

export async function connectLiveSession({apiKey, settings, callbacks}) {
	const ai = new GoogleGenAI({
		apiKey,
		apiVersion: apiKey.startsWith('auth_tokens/') ? LIVE_API_VERSION : 'v1beta'
	})
	const config = buildLiveConfig(settings)
	const session = await ai.live.connect({
		model: FIXED_MODEL_ID,
		config,
		callbacks
	})
	
	return {
		session,
		config
	}
}
