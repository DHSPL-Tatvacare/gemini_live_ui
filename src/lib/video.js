import {blobToBase64} from './encoding.js'

class BaseVisualStreamer {
	constructor({onFrame, onEnded, fps = 1, quality = 0.82} = {}) {
		this.onFrame = onFrame
		this.onEnded = onEnded
		this.fps = fps
		this.quality = quality
		this.stream = null
		this.video = null
		this.canvas = null
		this.context = null
		this.intervalId = null
		this.isStreaming = false
		this.isEncodingFrame = false
	}
	
	initializeElements(width, height) {
		this.video = document.createElement('video')
		this.video.autoplay = true
		this.video.muted = true
		this.video.playsInline = true
		this.video.srcObject = this.stream
		
		this.canvas = document.createElement('canvas')
		this.canvas.width = width
		this.canvas.height = height
		this.context = this.canvas.getContext('2d', {alpha: false})
	}
	
	async waitForVideo() {
		await new Promise((resolve) => {
			this.video.onloadedmetadata = resolve
		})
		
		await this.video.play()
	}
	
	startFrameLoop() {
		this.intervalId = window.setInterval(async () => {
			if (!this.isStreaming || this.isEncodingFrame || !this.context) {
				return
			}
			
			this.isEncodingFrame = true
			
			try {
				this.context.drawImage(
					this.video,
					0,
					0,
					this.canvas.width,
					this.canvas.height
				)
				
				const blob = await new Promise((resolve) => {
					this.canvas.toBlob(resolve, 'image/jpeg', this.quality)
				})
				
				if (!blob) {
					return
				}
				
				const data = await blobToBase64(blob)
				this.onFrame?.({mimeType: 'image/jpeg', data})
			}
			finally {
				this.isEncodingFrame = false
			}
		}, 1000 / this.fps)
	}
	
	stop() {
		this.isStreaming = false
		
		if (this.intervalId) {
			window.clearInterval(this.intervalId)
			this.intervalId = null
		}
		
		this.stream?.getTracks().forEach((track) => track.stop())
		this.stream = null
		
		if (this.video) {
			this.video.srcObject = null
			this.video = null
		}
		
		this.canvas = null
		this.context = null
	}
}

export class CameraStreamer extends BaseVisualStreamer {
	async start({
		            deviceId,
		            fps = 1,
		            width = 640,
		            height = 480,
		            facingMode = 'user'
	            } = {}) {
		this.fps = fps
		
		const videoConstraints = {
			width: {ideal: width},
			height: {ideal: height}
		}
		
		if (deviceId) {
			videoConstraints.deviceId = {exact: deviceId}
		}
		else {
			videoConstraints.facingMode = facingMode
		}
		
		this.stream = await navigator.mediaDevices.getUserMedia({
			video: videoConstraints
		})
		
		this.initializeElements(width, height)
		await this.waitForVideo()
		
		this.isStreaming = true
		this.startFrameLoop()
		return this.stream
	}
}

export class ScreenStreamer extends BaseVisualStreamer {
	async start({fps = 0.5, width = 1280, height = 720} = {}) {
		this.fps = fps
		
		this.stream = await navigator.mediaDevices.getDisplayMedia({
			video: {
				width: {ideal: width},
				height: {ideal: height}
			},
			audio: false
		})
		
		this.stream.getVideoTracks()[0].addEventListener('ended', () => {
			this.stop()
			this.onEnded?.()
		})
		
		this.initializeElements(width, height)
		await this.waitForVideo()
		
		this.isStreaming = true
		this.startFrameLoop()
		return this.stream
	}
}
