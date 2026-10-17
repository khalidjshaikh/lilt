/* Forwards microphone samples to the main thread in 2048-frame parcels. */
class LiltCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(2048);
    this.offset = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i += 1) {
      this.buffer[this.offset] = channel[i];
      this.offset += 1;
      if (this.offset === this.buffer.length) {
        const parcel = this.buffer;
        this.port.postMessage(parcel, [parcel.buffer]);
        this.buffer = new Float32Array(2048);
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor("lilt-capture", LiltCapture);
