class ConsultationAudio extends AudioWorkletProcessor {
  constructor() {
    super(); this.samples = new Float32Array(4096); this.length = 0; this.finished = false;
    this.port.onmessage = event => { if (event.data.type === 'flush') { this.finished = true; this.send(); this.port.postMessage({ type: 'flushed' }); } };
  }
  send() { if (!this.length) return; const samples = this.samples.slice(0, this.length); this.port.postMessage({ type: 'samples', samples }, [samples.buffer]); this.length = 0; }
  process(inputs) {
    if (this.finished) return false;
    const channels = inputs[0]; if (!channels?.length) return true;
    for (let index = 0; index < channels[0].length; index++) { let sample = 0; for (const channel of channels) sample += channel[index]; this.samples[this.length++] = sample / channels.length; if (this.length === this.samples.length) this.send(); }
    return true;
  }
}
registerProcessor('consultation-audio', ConsultationAudio);
