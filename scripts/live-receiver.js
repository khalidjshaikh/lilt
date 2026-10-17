/*
 * A streaming Lilt receiver.
 *
 * This is the command-line analogue of the browser receiver: keep a rolling
 * buffer of microphone audio, watch for the two-tone call, lock onto the
 * greeting, read the head, wait for the body, and emit text only after the
 * checksum agrees.
 *
 * It is deliberately independent of the audio capture layer, so it can be
 * tested by pushing synthesized samples into it.
 */

import { SampleRing } from "../src/audio.js";
import { CALL_TO_DATA_MS } from "../src/protocol.js";
import {
  Demodulator,
  detectCall,
  findSyncCandidates,
  frameDurationSeconds,
  locateFrame,
  readBodyAt,
  readHeaderAt,
} from "../src/dsp.js";

const HISTORY_SECONDS = 95;
const DEDUPE_MS = 60_000;

export class LiveReceiver {
  constructor(options = {}) {
    this.sampleRate = options.sampleRate ?? 48_000;
    this.ring = new SampleRing(HISTORY_SECONDS, this.sampleRate);
    this.onMessage = options.onMessage ?? (() => {});
    this.onStatus = options.onStatus ?? (() => {});
    this.dedupeMilliseconds = options.dedupeMilliseconds ?? DEDUPE_MS;
    this.pending = null;
    this.lastCallAt = -Infinity;
    this.seen = new Map();
  }

  /** Add captured mono samples; call `tick()` afterwards to decode. */
  push(samples) {
    this.ring.append(samples);
  }

  /**
   * Advance the receiver. Safe to call at any cadence; it only does work when
   * enough new audio has arrived for its current state.
   */
  tick() {
    const sampleRate = this.sampleRate;
    const now = this.ring.total;

    if (this.pending) {
      this.processPending(now, sampleRate);
      return;
    }

    if (now < Math.round(1.2 * sampleRate)) return;
    const windowSamples = Math.min(Math.round(1.8 * sampleRate), now);
    const segmentStart = now - windowSamples;
    const segment = this.ring.slice(segmentStart, now);
    const call = detectCall(segment, sampleRate, { threshold: 0.0035 });
    if (!call) return;

    const callAbs = segmentStart + call.startSample;
    if (callAbs <= this.lastCallAt + Math.round(1.5 * sampleRate)) return;
    this.startPending(callAbs, sampleRate);
  }

  startPending(callAbs, sampleRate) {
    this.lastCallAt = callAbs;
    this.pending = {
      callAbs,
      nextAttemptAbs: callAbs + Math.round(2.05 * sampleRate),
      attempts: 0,
      bodyAttempts: 0,
      header: null,
      syncOffset: null,
      bodyStart: null,
      segStart: null,
      demodulator: null,
      expectedEndAbs: Infinity,
      triedCandidates: false,
    };
    this.onStatus({ type: "call", atSeconds: callAbs / sampleRate });
  }

  processPending(now, sampleRate) {
    const pending = this.pending;
    if (!pending) return;
    if (now < pending.nextAttemptAbs) return;

    const segStart = Math.max(
      this.ring.start,
      pending.callAbs - Math.round(0.25 * sampleRate),
    );
    const approxSync =
      pending.callAbs +
      Math.round((CALL_TO_DATA_MS / 1000) * sampleRate) -
      segStart;

    if (!pending.header) {
      const segEnd = Math.min(now, pending.callAbs + Math.round(4.5 * sampleRate));
      if (segEnd - segStart < Math.round(2.1 * sampleRate)) return;

      pending.attempts += 1;
      const segment = this.ring.slice(segStart, segEnd);
      const located = locateFrame(segment, approxSync, sampleRate, {
        range: 0.18,
        count: 4,
      });

      if (located.header) {
        pending.header = located.header;
        pending.syncOffset = located.syncOffset;
        pending.bodyStart = located.bodyStart;
        pending.segStart = segStart;
        pending.demodulator = located.demodulator;
        pending.expectedEndAbs =
          pending.callAbs + frameDurationSeconds(pending.header) * sampleRate;
        pending.nextAttemptAbs =
          pending.expectedEndAbs + Math.round(0.18 * sampleRate);
        this.onStatus({
          type: "head",
          payloadLength: pending.header.payloadLength,
          messageId: pending.header.messageId,
        });
        return;
      }

      if (
        pending.attempts >= 4 &&
        now > pending.callAbs + Math.round(4.2 * sampleRate)
      ) {
        this.fail("the call dissolved before I could read it");
        return;
      }
      pending.nextAttemptAbs = now + Math.round(0.55 * sampleRate);
      return;
    }

    if (now < pending.expectedEndAbs + Math.round(0.18 * sampleRate)) return;
    if (now > pending.expectedEndAbs + Math.round(8 * sampleRate)) {
      this.fail("the message stopped arriving before its end");
      return;
    }

    pending.bodyAttempts += 1;
    const fullEnd = Math.min(now, pending.expectedEndAbs + Math.round(0.8 * sampleRate));
    const full = this.ring.slice(pending.segStart, fullEnd);
    const frame = {
      header: pending.header,
      bodyStart: pending.bodyStart,
      demodulator: pending.demodulator,
    };
    const body = readBodyAt(full, frame, sampleRate, pending.demodulator);

    if (body.ok) {
      this.accept(
        body.text,
        pending.header,
        body.confidence,
        pending.callAbs,
        sampleRate,
      );
      return;
    }

    if (body.waiting && pending.bodyAttempts < 5) {
      pending.nextAttemptAbs = now + Math.round(0.35 * sampleRate);
      return;
    }

    if (!pending.triedCandidates) {
      pending.triedCandidates = true;
      const demodulator = new Demodulator(sampleRate);
      const candidates = findSyncCandidates(full, approxSync, sampleRate, {
        demodulator,
        range: 0.18,
        count: 6,
      });
      for (const candidate of candidates) {
        const header = readHeaderAt(full, candidate.offset, sampleRate, demodulator);
        if (!header) continue;
        const alternate = readBodyAt(
          full,
          { ...header, demodulator },
          sampleRate,
          demodulator,
        );
        if (alternate.ok) {
          this.accept(
            alternate.text,
            header.header,
            alternate.confidence,
            pending.callAbs,
            sampleRate,
          );
          return;
        }
      }
    }

    this.fail("I heard the melody, but the words were too broken");
  }

  accept(text, header, confidence, callAbs, sampleRate) {
    this.pending = null;
    this.lastCallAt = callAbs;
    const key = `${header.messageId}\u0000${text}`;
    const now = Date.now();
    const previous = this.seen.get(key);

    if (previous != null && now - previous < this.dedupeMilliseconds) {
      this.onStatus({
        type: "repeat",
        text,
        messageId: header.messageId,
        atSeconds: callAbs / sampleRate,
      });
      return;
    }
    for (const [oldKey, timestamp] of this.seen) {
      if (now - timestamp > this.dedupeMilliseconds * 2) this.seen.delete(oldKey);
    }
    this.seen.set(key, now);

    this.onMessage({
      text,
      header,
      confidence,
      atSeconds: callAbs / sampleRate,
    });
  }

  fail(reason) {
    this.pending = null;
    this.onStatus({ type: "error", reason });
  }
}
