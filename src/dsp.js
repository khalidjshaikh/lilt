/*
 * The audible part of Lilt: synthesis, tone detection and packet recovery.
 * Everything here is plain arithmetic over Float32Array, so it runs in the
 * browser and under Node in the tests.
 */

import {
  CALL_MS,
  CALL_TO_DATA_MS,
  SYMBOL_SECONDS,
  SYMBOL_MS,
  SYNC_SYMBOLS,
  TONE_FREQS,
  TONE_MS,
  CODEWORD_SYMBOLS,
  decodeBodySymbols,
  decodeHeaderSymbols,
  bodyBlockCount,
} from "./protocol.js";

export const CALL_FREQS = Object.freeze([TONE_FREQS[0], TONE_FREQS[15]]);

const TAU = Math.PI * 2;

function hann(length) {
  const window = new Float32Array(length);
  let sum = 0;
  for (let i = 0; i < length; i += 1) {
    const value = 0.5 - 0.5 * Math.cos((TAU * i) / (length - 1));
    window[i] = value;
    sum += value;
  }
  return { window, sum };
}

function writeTone(out, startSample, durationSeconds, frequency, amplitude, sampleRate) {
  const start = Math.max(0, Math.round(startSample));
  const length = Math.round(durationSeconds * sampleRate);
  const fade = Math.max(1, Math.min(Math.round(0.004 * sampleRate), Math.floor(length / 3)));
  const angular = (TAU * frequency) / sampleRate;
  for (let i = 0; i < length; i += 1) {
    let env = 1;
    if (i < fade) env = 0.5 - 0.5 * Math.cos((Math.PI * i) / fade);
    else if (i >= length - fade) {
      env = 0.5 - 0.5 * Math.cos((Math.PI * (length - 1 - i)) / fade);
    }
    const index = start + i;
    if (index >= out.length) break;
    out[index] += amplitude * env * Math.sin(angular * i);
  }
}

function writeChord(out, startSample, durationSeconds, frequencies, amplitude, sampleRate) {
  const start = Math.max(0, Math.round(startSample));
  const length = Math.round(durationSeconds * sampleRate);
  const fade = Math.max(1, Math.round(0.015 * sampleRate));
  const oscillators = frequencies.map((frequency) => (TAU * frequency) / sampleRate);
  for (let i = 0; i < length; i += 1) {
    let env = 1;
    if (i < fade) env = 0.5 - 0.5 * Math.cos((Math.PI * i) / fade);
    else if (i >= length - fade) {
      env = 0.5 - 0.5 * Math.cos((Math.PI * (length - 1 - i)) / fade);
    }
    let value = 0;
    for (const angular of oscillators) value += Math.sin(angular * i);
    const index = start + i;
    if (index >= out.length) break;
    out[index] += amplitude * env * value;
  }
}

/**
 * Render a packet's call + greeting + head + body into a mono waveform.
 * The returned timeline is handy for the interface's progress display.
 */
export function synthesizePacket(packet, sampleRate, options = {}) {
  const leadIn = options.leadIn ?? 0.25;
  const tail = options.tail ?? 0.55;
  const toneAmplitude = options.toneAmplitude ?? 0.38;
  const callAmplitude = options.callAmplitude ?? 0.16;
  const symbolSamples = Math.round(SYMBOL_SECONDS * sampleRate);
  const allSymbols = [...SYNC_SYMBOLS, ...packet.symbols];
  const callStart = leadIn;
  const dataStart = callStart + CALL_TO_DATA_MS / 1000;
  const total =
    dataStart + (allSymbols.length * SYMBOL_MS) / 1000 + tail;
  const out = new Float32Array(Math.ceil(total * sampleRate));

  writeChord(
    out,
    callStart * sampleRate,
    CALL_MS / 1000,
    CALL_FREQS,
    callAmplitude,
    sampleRate,
  );

  const toneLength = (TONE_MS / 1000);
  allSymbols.forEach((symbol, index) => {
    const start = (dataStart * sampleRate) + index * symbolSamples;
    writeTone(
      out,
      start,
      toneLength,
      TONE_FREQS[symbol],
      toneAmplitude,
      sampleRate,
    );
  });

  return {
    samples: out,
    sampleRate,
    callStart,
    dataStart,
    end: total,
    symbolSamples,
    totalSymbols: allSymbols.length,
    allSymbols,
    timeline: [
      { name: "call", start: callStart, end: callStart + CALL_MS / 1000 },
      {
        name: "greeting",
        start: dataStart,
        end: dataStart + (SYNC_SYMBOLS.length * SYMBOL_MS) / 1000,
      },
      {
        name: "head",
        start: dataStart + (SYNC_SYMBOLS.length * SYMBOL_MS) / 1000,
        end: dataStart + ((SYNC_SYMBOLS.length + CODEWORD_SYMBOLS) * SYMBOL_MS) / 1000,
      },
      {
        name: "body",
        start: dataStart + ((SYNC_SYMBOLS.length + CODEWORD_SYMBOLS) * SYMBOL_MS) / 1000,
        end: dataStart + ((SYNC_SYMBOLS.length + CODEWORD_SYMBOLS + packet.bodySymbols.length) * SYMBOL_MS) / 1000,
      },
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Tone analysis                                                       */
/* ------------------------------------------------------------------ */

function goertzelPower(values, coefficient) {
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < values.length; i += 1) {
    s0 = values[i] + coefficient * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coefficient * s1 * s2;
}

export class Demodulator {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.symbolSamples = Math.round(SYMBOL_SECONDS * sampleRate);
    this.offset = Math.round(0.003 * sampleRate);
    this.length = Math.round(0.040 * sampleRate);
    const { window, sum } = hann(this.length);
    this.window = window;
    this.windowSum = sum;
    this.coefficients = TONE_FREQS.map(
      (frequency) => 2 * Math.cos((TAU * frequency) / sampleRate),
    );
    this.normalizer = (this.windowSum / 2) ** 2;
  }

  /** Read one syllable at a symbol boundary. */
  at(samples, start) {
    const base = Math.round(start) + this.offset;
    if (base < 0 || base + this.length > samples.length) return null;
    const windowed = new Float32Array(this.length);
    for (let i = 0; i < this.length; i += 1) {
      windowed[i] = samples[base + i] * this.window[i];
    }
    const powers = new Float32Array(TONE_FREQS.length);
    let total = 0;
    let best = 0;
    let second = 0;
    let bestIndex = 0;
    for (let t = 0; t < TONE_FREQS.length; t += 1) {
      const power = goertzelPower(windowed, this.coefficients[t]) / this.normalizer;
      powers[t] = power;
      total += power;
      if (power > best) {
        second = best;
        best = power;
        bestIndex = t;
      } else if (power > second) {
        second = power;
      }
    }
    return {
      symbol: bestIndex,
      powers,
      total,
      confidence: total > 0 ? best / total : 0,
      margin: best > 0 ? (best - second) / best : 0,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Call detection                                                      */
/* ------------------------------------------------------------------ */

function toneAmplitudes(windowed, frequencies, sampleRate, windowSum) {
  const amplitudes = [];
  for (const frequency of frequencies) {
    const coefficient = 2 * Math.cos((TAU * frequency) / sampleRate);
    const power = goertzelPower(windowed, coefficient);
    amplitudes.push((2 * Math.sqrt(Math.max(0, power))) / windowSum);
  }
  return amplitudes;
}

/**
 * Look for the two-tone call. Returns the first convincing run, measured in
 * samples from the start of `samples`.
 */
export function detectCall(samples, sampleRate, options = {}) {
  const threshold = options.threshold ?? 0.0045;
  const minRun = options.minRun ?? 0.32;
  const winSeconds = options.window ?? 0.03;
  const hopSeconds = options.hop ?? 0.015;
  const win = Math.round(winSeconds * sampleRate);
  const hop = Math.round(hopSeconds * sampleRate);
  if (samples.length < win) return null;
  const { window, sum } = hann(win);
  const maxIndex = samples.length - win;

  let runStart = -1;
  let lastHit = -1;

  for (let start = 0; start <= maxIndex; start += hop) {
    let energy = 0;
    const windowed = new Float32Array(win);
    for (let i = 0; i < win; i += 1) {
      const value = samples[start + i];
      energy += value * value;
      windowed[i] = value * window[i];
    }
    const rms = Math.sqrt(energy / win);
    if (rms < threshold) {
      if (runStart >= 0 && start - lastHit > 0.06 * sampleRate) runStart = -1;
      continue;
    }

    const amps = toneAmplitudes(windowed, CALL_FREQS, sampleRate, sum);
    const low = amps[0] * amps[0];
    const high = amps[1] * amps[1];
    const rms2 = rms * rms;
    const lowRatio = low / rms2;
    const highRatio = high / rms2;
    const balanced = lowRatio > highRatio / 5 && highRatio > lowRatio / 5;
    const hit = lowRatio > 0.15 && highRatio > 0.15 && balanced;

    if (hit) {
      if (runStart < 0) runStart = start;
      lastHit = start;
      if ((start - runStart) / sampleRate >= minRun) {
        return {
          startSample: runStart + Math.round(win / 2),
          endSample: start + win,
          strength: Math.min(1, (lowRatio + highRatio) / 2),
        };
      }
    } else if (runStart >= 0 && start - lastHit > 0.06 * sampleRate) {
      runStart = -1;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Greeting search, head and body                                      */
/* ------------------------------------------------------------------ */

function syncScore(samples, offset, demodulator) {
  if (offset < 0) return -Infinity;
  let score = 0;
  for (let i = 0; i < SYNC_SYMBOLS.length; i += 1) {
    const read = demodulator.at(samples, offset + i * demodulator.symbolSamples);
    if (!read) return -Infinity;
    const expectedPower = read.powers[SYNC_SYMBOLS[i]];
    const ratio = expectedPower / (read.total + 1e-12);
    score += Math.log(ratio + 1e-7);
  }
  return score;
}

/**
 * Search for the greeting around an estimated boundary. The call detector is
 * only a hint; this is what actually locks the syllable clock.
 */
export function findSyncCandidates(samples, approximateSync, sampleRate, options = {}) {
  const demodulator = options.demodulator ?? new Demodulator(sampleRate);
  const range = Math.round((options.range ?? 0.14) * sampleRate);
  const coarseStep = Math.max(1, Math.round((options.coarseStep ?? 0.004) * sampleRate));
  const fineStep = Math.max(1, Math.round((options.fineStep ?? 0.001) * sampleRate));
  const maxCandidates = options.count ?? 5;
  const frameNeed = SYNC_SYMBOLS.length * demodulator.symbolSamples;
  const minOffset = Math.max(0, approximateSync - range);
  const maxOffset = Math.min(
    samples.length - frameNeed,
    approximateSync + range,
  );
  if (maxOffset < minOffset) return [];

  const coarse = [];
  for (let offset = minOffset; offset <= maxOffset; offset += coarseStep) {
    const score = syncScore(samples, offset, demodulator);
    if (Number.isFinite(score)) coarse.push({ offset, score });
  }
  coarse.sort((a, b) => b.score - a.score);

  const refined = new Map();
  for (const candidate of coarse.slice(0, maxCandidates * 2)) {
    const from = Math.max(minOffset, candidate.offset - coarseStep);
    const to = Math.min(maxOffset, candidate.offset + coarseStep);
    for (let offset = from; offset <= to; offset += fineStep) {
      const score = syncScore(samples, offset, demodulator);
      if (!Number.isFinite(score)) continue;
      const key = Math.round(offset / fineStep);
      if (!refined.has(key) || refined.get(key).score < score) {
        refined.set(key, { offset, score });
      }
    }
  }

  const list = [...refined.values()].sort((a, b) => b.score - a.score);
  const spaced = [];
  for (const item of list) {
    if (spaced.every((other) => Math.abs(other.offset - item.offset) > demodulator.symbolSamples / 8)) {
      spaced.push(item);
      if (spaced.length >= maxCandidates) break;
    }
  }
  return spaced;
}

export function readHeaderAt(samples, syncOffset, sampleRate, demodulator = new Demodulator(sampleRate)) {
  const headerStart = syncOffset + SYNC_SYMBOLS.length * demodulator.symbolSamples;
  const symbols = [];
  let confidence = 0;
  for (let i = 0; i < CODEWORD_SYMBOLS; i += 1) {
    const read = demodulator.at(samples, headerStart + i * demodulator.symbolSamples);
    if (!read) return null;
    symbols.push(read.symbol);
    confidence += read.confidence;
  }
  const decoded = decodeHeaderSymbols(symbols);
  if (!decoded) return null;
  return {
    header: decoded,
    symbols,
    headerStart,
    bodyStart: headerStart + CODEWORD_SYMBOLS * demodulator.symbolSamples,
    confidence: confidence / CODEWORD_SYMBOLS,
  };
}

function demodulateRun(samples, start, count, demodulator) {
  const symbols = [];
  let confidence = 0;
  for (let i = 0; i < count; i += 1) {
    const read = demodulator.at(samples, start + i * demodulator.symbolSamples);
    if (!read) return null;
    symbols.push(read.symbol);
    confidence += read.confidence;
  }
  return { symbols, confidence: confidence / count };
}

/** Locate a greeting, then read the five-byte head behind it. */
export function locateFrame(samples, approximateSync, sampleRate, options = {}) {
  const demodulator = options.demodulator ?? new Demodulator(sampleRate);
  const candidates = findSyncCandidates(samples, approximateSync, sampleRate, {
    ...options,
    demodulator,
  });
  for (const candidate of candidates) {
    const header = readHeaderAt(samples, candidate.offset, sampleRate, demodulator);
    if (header) {
      return {
        ...header,
        syncOffset: candidate.offset,
        syncScore: candidate.score,
        demodulator,
        candidates,
      };
    }
  }
  return {
    header: null,
    demodulator,
    candidates,
  };
}

export function availableBodyBlocks(samples, bodyStart, sampleRate, header) {
  const available = Math.floor(
    (samples.length - bodyStart) / (SYMBOL_SECONDS * sampleRate),
  );
  return Math.max(0, Math.min(bodyBlockCount(header.payloadLength), Math.floor(available / CODEWORD_SYMBOLS)));
}

export function readBodyAt(samples, frame, sampleRate, demodulator = frame.demodulator) {
  const blockCount = bodyBlockCount(frame.header.payloadLength);
  const symbolCount = blockCount * CODEWORD_SYMBOLS;
  if (samples.length < frame.bodyStart + symbolCount * demodulator.symbolSamples) {
    return { ok: false, reason: "the rest of the frame has not arrived yet", waiting: true };
  }
  const run = demodulateRun(samples, frame.bodyStart, symbolCount, demodulator);
  if (!run) return { ok: false, reason: "the body has not arrived yet", waiting: true };
  const decoded = decodeBodySymbols(run.symbols, frame.header);
  if (!decoded.ok) return { ...decoded, confidence: run.confidence };
  return {
    ...decoded,
    confidence: run.confidence,
    symbols: run.symbols,
  };
}

/** Convenience for tests and for decoding a complete recording in one go. */
export function decodeRecording(samples, approximateSync, sampleRate) {
  const located = locateFrame(samples, approximateSync, sampleRate);
  if (!located.header) return { ok: false, reason: "greeting or head not found" };
  const body = readBodyAt(samples, located, sampleRate);
  if (!body.ok) return { ...body, header: located.header };
  return {
    ok: true,
    header: located.header,
    syncOffset: located.syncOffset,
    confidence: (located.confidence + body.confidence) / 2,
    text: body.text,
    payload: body.payload,
    checksum: body.checksum,
  };
}

export function frameDurationSeconds(header) {
  return (
    CALL_TO_DATA_MS / 1000 +
    (SYNC_SYMBOLS.length + CODEWORD_SYMBOLS + bodyBlockCount(header.payloadLength) * CODEWORD_SYMBOLS) *
      SYMBOL_SECONDS
  );
}
