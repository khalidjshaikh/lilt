/* Microphone capture and speaker playback for Lilt. */

export class SampleRing {
  constructor(seconds, sampleRate) {
    this.capacity = Math.max(1, Math.round(seconds * sampleRate));
    this.buffer = new Float32Array(this.capacity);
    this.writeIndex = 0;
    this.total = 0;
  }

  append(chunk) {
    let source = chunk;
    if (source.length > this.capacity) {
      source = source.subarray(source.length - this.capacity);
    }
    for (let i = 0; i < source.length; i += 1) {
      this.buffer[this.writeIndex] = source[i];
      this.writeIndex = (this.writeIndex + 1) % this.capacity;
    }
    this.total += source.length;
  }

  get start() {
    return Math.max(0, this.total - this.capacity);
  }

  slice(start, end) {
    const from = Math.max(this.start, Math.floor(start));
    const to = Math.min(this.total, Math.ceil(end));
    const length = Math.max(0, to - from);
    const out = new Float32Array(length);
    if (length === 0) return out;
    const read =
      (this.writeIndex - (this.total - from) + this.capacity * 2) %
      this.capacity;
    for (let i = 0; i < length; i += 1) {
      out[i] = this.buffer[(read + i) % this.capacity];
    }
    return out;
  }
}

export class AudioEngine {
  constructor(options = {}) {
    this.onSamples = options.onSamples ?? (() => {});
    this.onStateChange = options.onStateChange ?? (() => {});
    this.context = null;
    this.ring = null;
    this.listening = false;
    this.transmitting = false;
    this.volume = options.volume ?? 0.72;
    this.stream = null;
    this.micSource = null;
    this.micAnalyser = null;
    this.captureNode = null;
    this.captureSink = null;
    this.txAnalyser = null;
    this.activeSource = null;
    this.usingWorklet = false;
  }

  async ensureContext() {
    if (!this.context) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) throw new Error("This browser does not support Web Audio.");
      this.context = new AudioContextClass({ latencyHint: "interactive" });
      this.ring = new SampleRing(92, this.context.sampleRate);
      this.txAnalyser = this.context.createAnalyser();
      this.txAnalyser.fftSize = 2048;
      this.txAnalyser.smoothingTimeConstant = 0.72;
      this.txAnalyser.connect(this.context.destination);
      this.onStateChange();
    }
    if (this.context.state === "suspended") await this.context.resume();
    return this.context;
  }

  get sampleRate() {
    return this.context?.sampleRate ?? 48_000;
  }

  async startListening() {
    if (this.listening) return;
    await this.ensureContext();
    this.clearInput();
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Microphone access is not available in this browser.");
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
      video: false,
    });
    this.stream = stream;
    this.micSource = this.context.createMediaStreamSource(stream);
    this.micAnalyser = this.context.createAnalyser();
    this.micAnalyser.fftSize = 2048;
    this.micAnalyser.smoothingTimeConstant = 0.72;
    this.micSource.connect(this.micAnalyser);

    this.captureSink = this.context.createGain();
    this.captureSink.gain.value = 0;
    this.captureSink.connect(this.context.destination);

    if (this.context.audioWorklet) {
      try {
        await this.context.audioWorklet.addModule(
          new URL("./capture-worklet.js", import.meta.url),
        );
        this.captureNode = new AudioWorkletNode(this.context, "lilt-capture");
        this.captureNode.port.onmessage = (event) => {
          this.ring.append(event.data);
          this.onSamples();
        };
        this.micSource.connect(this.captureNode);
        this.captureNode.connect(this.captureSink);
        this.usingWorklet = true;
      } catch (error) {
        console.warn("AudioWorklet unavailable; using ScriptProcessor.", error);
      }
    }

    if (!this.usingWorklet) {
      const processor = this.context.createScriptProcessor(2048, 1, 1);
      processor.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0);
        this.ring.append(new Float32Array(input));
        this.onSamples();
      };
      this.micSource.connect(processor);
      processor.connect(this.captureSink);
      this.captureNode = processor;
    }

    this.listening = true;
    this.onStateChange();
  }

  stopListening() {
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
    }
    if (this.captureNode) {
      this.captureNode.disconnect();
      if ("port" in this.captureNode) this.captureNode.port.onmessage = null;
      this.captureNode = null;
    }
    if (this.micSource) {
      this.micSource.disconnect();
      this.micSource = null;
    }
    if (this.micAnalyser) {
      this.micAnalyser.disconnect();
      this.micAnalyser = null;
    }
    if (this.captureSink) {
      this.captureSink.disconnect();
      this.captureSink = null;
    }
    this.stream = null;
    this.listening = false;
    this.usingWorklet = false;
    this.onStateChange();
  }

  async playSamples(samples) {
    const context = await this.ensureContext();
    if (this.activeSource) {
      try {
        this.activeSource.stop();
      } catch {
        // The previous source already finished.
      }
    }
    const buffer = context.createBuffer(1, samples.length, context.sampleRate);
    buffer.copyToChannel(samples, 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    const gain = context.createGain();
    gain.gain.value = this.volume;
    source.connect(gain);
    gain.connect(this.txAnalyser);
    this.activeSource = source;
    this.transmitting = true;
    this.onStateChange();
    const finished = new Promise((resolve) => {
      source.onended = () => {
        source.disconnect();
        gain.disconnect();
        if (this.activeSource === source) {
          this.activeSource = null;
          this.transmitting = false;
          this.onStateChange();
        }
        resolve();
      };
    });
    source.start();
    return finished;
  }

  stopPlaying() {
    if (this.activeSource) {
      try {
        this.activeSource.stop();
      } catch {
        // Already stopped.
      }
    }
  }

  clearInput() {
    if (!this.ring) return;
    this.ring.buffer.fill(0);
    this.ring.writeIndex = 0;
    this.ring.total = 0;
  }

  setVolume(value) {
    this.volume = Math.max(0, Math.min(1, value));
  }

  activeAnalyser() {
    if (this.transmitting) return this.txAnalyser;
    return this.micAnalyser;
  }

  spectrum() {
    const analyser = this.activeAnalyser();
    if (!analyser) return null;
    const data = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatFrequencyData(data);
    return data;
  }

  micLevel() {
    if (!this.micAnalyser) return 0;
    const data = new Float32Array(this.micAnalyser.fftSize);
    this.micAnalyser.getFloatTimeDomainData(data);
    let sum = 0;
    for (const value of data) sum += value * value;
    return Math.sqrt(sum / data.length);
  }
}
