class AudioCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.bufferSize = 512
    this.buffer = new Float32Array(this.bufferSize)
    this.bufferIndex = 0
  }

  process(inputs) {
    const input = inputs[0]

    if (input && input.length > 0) {
      const channel = input[0]

      for (let index = 0; index < channel.length; index += 1) {
        this.buffer[this.bufferIndex] = channel[index]
        this.bufferIndex += 1

        if (this.bufferIndex >= this.bufferSize) {
          this.port.postMessage({
            type: 'audio',
            data: this.buffer.slice(),
          })

          this.bufferIndex = 0
        }
      }
    }

    return true
  }
}

registerProcessor('audio-capture-processor', AudioCaptureProcessor)
