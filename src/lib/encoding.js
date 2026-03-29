export function arrayBufferToBase64(buffer) {
	const bytes = new Uint8Array(buffer)
	let binary = ''
	
	for (let index = 0; index < bytes.byteLength; index += 1) {
		binary += String.fromCharCode(bytes[index])
	}
	
	return window.btoa(binary)
}

export function base64ToFloat32(base64) {
	const binaryString = window.atob(base64)
	const bytes = new Uint8Array(binaryString.length)
	
	for (let index = 0; index < binaryString.length; index += 1) {
		bytes[index] = binaryString.charCodeAt(index)
	}
	
	const pcm = new Int16Array(bytes.buffer)
	const float32 = new Float32Array(pcm.length)
	
	for (let index = 0; index < pcm.length; index += 1) {
		float32[index] = pcm[index] / 32768
	}
	
	return float32
}

export function float32ToPcm16Base64(float32Array) {
	const pcm = new Int16Array(float32Array.length)
	
	for (let index = 0; index < float32Array.length; index += 1) {
		const sample = Math.max(-1, Math.min(1, float32Array[index]))
		pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
	}
	
	return arrayBufferToBase64(pcm.buffer)
}

export function blobToBase64(blob) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader()
		
		reader.onerror = () => reject(new Error('Failed to read blob as base64.'))
		reader.onloadend = () => {
			const value = typeof reader.result === 'string' ? reader.result : ''
			resolve(value.split(',')[1] || '')
		}
		
		reader.readAsDataURL(blob)
	})
}
