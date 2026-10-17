import assert from "node:assert/strict";
import test from "node:test";

import { decodeWav, encodeWav } from "../src/wav.js";

test("16-bit PCM WAV files round-trip through the test codec", () => {
  const sampleRate = 48_000;
  const samples = Float32Array.from([
    0,
    0.25,
    -0.5,
    1,
    -1,
    Math.SQRT1_2,
    1.5,
    -1.5,
  ]);
  const wav = encodeWav(samples, sampleRate);
  const decoded = decodeWav(wav);

  assert.equal(decoded.sampleRate, sampleRate);
  assert.equal(decoded.channels, 1);
  assert.equal(decoded.samples.length, samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const expected = Math.max(-1, Math.min(1, samples[i]));
    assert.ok(
      Math.abs(decoded.samples[i] - expected) <= 1 / 32767,
      `sample ${i}: ${decoded.samples[i]} vs ${expected}`,
    );
  }
});

test("the WAV writer declares the format the reader expects", () => {
  const wav = encodeWav(Float32Array.from([0, 0]), 44_100);
  const view = new DataView(wav.buffer);

  assert.equal(String.fromCharCode(...wav.subarray(0, 4)), "RIFF");
  assert.equal(String.fromCharCode(...wav.subarray(8, 12)), "WAVE");
  assert.equal(String.fromCharCode(...wav.subarray(12, 16)), "fmt ");
  assert.equal(view.getUint16(20, true), 1, "PCM");
  assert.equal(view.getUint16(22, true), 1, "mono");
  assert.equal(view.getUint32(24, true), 44_100);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), 4);
});

test("the WAV reader rejects audio it cannot interpret", () => {
  const wav = encodeWav(Float32Array.from([0]), 48_000);
  const stereo = Uint8Array.from(wav);
  new DataView(stereo.buffer).setUint16(22, 2, true);
  assert.throws(() => decodeWav(stereo), /mono/);
  assert.throws(() => decodeWav(Uint8Array.from([0, 1, 2])), /too short/);
});
