// Captures the microphone in ~20 ms blocks and hands them to the main thread untouched.
// Runs inside the AudioWorklet thread, so it is plain JavaScript (not bundled).
class TelecomwayMicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.target = Math.max(128, Math.round(sampleRate * 0.02));
    this.block = new Float32Array(this.target);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    let offset = 0;
    while (offset < channel.length) {
      const take = Math.min(channel.length - offset, this.target - this.filled);
      this.block.set(channel.subarray(offset, offset + take), this.filled);
      this.filled += take;
      offset += take;
      if (this.filled === this.target) {
        this.port.postMessage(this.block.slice(0));
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('tw-mic', TelecomwayMicProcessor);
