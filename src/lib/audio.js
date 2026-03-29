import {base64ToFloat32, float32ToPcm16Base64} from './encoding.js'

const CAPTURE_WORKLET_PATH = '/audio-processors/capture.worklet.js'
const PLAYBACK_WORKLET_PATH = '/audio-processors/playback.worklet.js'

export class AudioRecorder {
	constructor({onChunk, sampleRate = 16000} = {}) {
		this.onChunk = onChunk
		this.sampleRate = sampleRate
		this.mediaStream = null
		this.audioContext = null
		this.audioWorklet = null
		this.source = null
		this.isStreaming = false
	}
	
	async start(deviceId) {
		const audioConstraints = {
			channelCount: 1,
			sampleRate: this.sampleRate,
			echoCancellation: true,
			noiseSuppression: true,
			autoGainControl: true
		}
		
		if (deviceId) {
			audioConstraints.deviceId = {exact: deviceId}
		}
		
		this.mediaStream = await navigator.mediaDevices.getUserMedia({
			audio: audioConstraints
		})
		
		this.audioContext = new window.AudioContext({
			sampleRate: this.sampleRate
		})
		
		await this.audioContext.audioWorklet.addModule(CAPTURE_WORKLET_PATH)
		
		this.audioWorklet = new AudioWorkletNode(
			this.audioContext,
			'audio-capture-processor'
		)
		
		this.audioWorklet.port.onmessage = (event) => {
			if (!this.isStreaming || event.data?.type !== 'audio') {
				return
			}
			
			this.onChunk?.({
				mimeType: 'audio/pcm;rate=16000',
				data: float32ToPcm16Base64(event.data.data)
			})
		}
		
		this.source = this.audioContext.createMediaStreamSource(this.mediaStream)
		this.source.connect(this.audioWorklet)
		this.isStreaming = true
		
		if (this.audioContext.state === 'suspended') {
			await this.audioContext.resume()
		}
	}
	
	stop() {
		this.isStreaming = false
		this.audioWorklet?.disconnect()
		this.audioWorklet?.port?.close()
		this.audioWorklet = null
		this.source?.disconnect()
		this.source = null
		this.mediaStream?.getTracks().forEach((track) => track.stop())
		this.mediaStream = null
		this.audioContext?.close()
		this.audioContext = null
	}
}

export class AudioPlayer {
	constructor({sampleRate = 24000} = {}) {
		this.sampleRate = sampleRate
		this.audioContext = null
		this.workletNode = null
		this.gainNode = null
		this.volume = 0.8
		this.initialized = false
	}
	
	async init() {
		if (this.initialized) {
			return
		}
		
		this.audioContext = new window.AudioContext({
			sampleRate: this.sampleRate
		})
		
		await this.audioContext.audioWorklet.addModule(PLAYBACK_WORKLET_PATH)
		
		this.workletNode = new AudioWorkletNode(this.audioContext, 'pcm-processor')
		this.gainNode = this.audioContext.createGain()
		this.gainNode.gain.value = this.volume
		
		this.workletNode.connect(this.gainNode)
		this.gainNode.connect(this.audioContext.destination)
		this.initialized = true
	}
	
	async play(base64Audio) {
		if (!this.initialized) {
			await this.init()
		}
		
		if (this.audioContext.state === 'suspended') {
			await this.audioContext.resume()
		}
		
		this.workletNode.port.postMessage(base64ToFloat32(base64Audio))
	}
	
	interrupt() {
		this.workletNode?.port.postMessage('interrupt')
	}
	
	setVolume(volume) {
		this.volume = Math.max(0, Math.min(1, volume))
		
		if (this.gainNode) {
			this.gainNode.gain.value = this.volume
		}
	}
	
	destroy() {
		this.audioContext?.close()
		this.audioContext = null
		this.workletNode = null
		this.gainNode = null
		this.initialized = false
	}
}
