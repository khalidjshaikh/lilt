import assert from "node:assert/strict";
import test from "node:test";

import { buildPacket } from "../src/protocol.js";
import {
  decodeRecording,
  detectCall,
  synthesizePacket,
} from "../src/dsp.js";

function deterministicNoise(length, seed = 1) {
  let value = seed >>> 0;
  const noise = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    value = (value * 1664525 + 1013904223) >>> 0;
    noise[i] = (value / 0xffffffff) * 2 - 1;
  }
  return noise;
}

function addNoise(samples, snrDb, seed) {
  let signal = 0;
  for (const sample of samples) signal += sample * sample;
  const signalRms = Math.sqrt(signal / samples.length);
  const noiseRms = signalRms / 10 ** (snrDb / 20);
  const noise = deterministicNoise(samples.length, seed);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] += noise[i] * noiseRms * Math.sqrt(3);
  }
}

function addEcho(samples, sampleRate, delaySeconds, gain) {
  const out = new Float32Array(
    samples.length + Math.round(delaySeconds * sampleRate),
  );
  out.set(samples);
  const delay = Math.round(delaySeconds * sampleRate);
  for (let i = 0; i < samples.length; i += 1) {
    out[i + delay] += samples[i] * gain;
  }
  return out;
}

function prepend(samples, count) {
  const out = new Float32Array(samples.length + count);
  out.set(samples, count);
  return out;
}

for (const sampleRate of [44_100, 48_000]) {
  test(`packet decodes at ${sampleRate} Hz through noise and echo`, () => {
    const text = "the quick brown fox jumps over the lazy dog";
    const packet = buildPacket(text, { messageId: 19 });
    const rendered = synthesizePacket(packet, sampleRate);
    let audio = addEcho(rendered.samples, sampleRate, 0.075, 0.35);
    addNoise(audio, 10, 0x1234 + sampleRate);

    const call = detectCall(audio, sampleRate);
    assert.ok(call, "the two-tone call should be detected");
    const approximateSync =
      call.startSample + Math.round(0.7 * sampleRate);
    const decoded = decodeRecording(audio, approximateSync, sampleRate);
    assert.equal(decoded.ok, true, decoded.reason);
    assert.equal(decoded.text, text);
    assert.equal(decoded.header.messageId, 19);
  });
}

test("the call and greeting survive a late recording start", () => {
  const sampleRate = 48_000;
  const text = "a late listener can still find the clock";
  const packet = buildPacket(text);
  const rendered = synthesizePacket(packet, sampleRate);
  const audio = prepend(rendered.samples, Math.round(0.137 * sampleRate));
  const call = detectCall(audio, sampleRate);
  assert.ok(call);
  const approximateSync = call.startSample + Math.round(0.7 * sampleRate);
  const decoded = decodeRecording(audio, approximateSync, sampleRate);
  assert.equal(decoded.ok, true, decoded.reason);
  assert.equal(decoded.text, text);
});

test("the decoder recovers a long Unicode message", () => {
  const sampleRate = 48_000;
  const text =
    "A longer line for the room: café, 東京, and a little night music. ".repeat(4) +
    "End.";
  const packet = buildPacket(text, { messageId: 200 });
  const rendered = synthesizePacket(packet, sampleRate);
  const decoded = decodeRecording(
    rendered.samples,
    rendered.callStart * sampleRate + 0.7 * sampleRate,
    sampleRate,
  );
  assert.equal(decoded.ok, true, decoded.reason);
  assert.equal(decoded.text, text);
});

test("an empty message is still a valid, signed frame", () => {
  const sampleRate = 48_000;
  const packet = buildPacket("", { messageId: 3 });
  const rendered = synthesizePacket(packet, sampleRate);
  const decoded = decodeRecording(
    rendered.samples,
    rendered.callStart * sampleRate + 0.7 * sampleRate,
    sampleRate,
  );
  assert.equal(decoded.ok, true, decoded.reason);
  assert.equal(decoded.text, "");
});

test("noise alone does not become text", () => {
  const sampleRate = 48_000;
  const noise = deterministicNoise(Math.round(sampleRate * 5), 99);
  const audio = new Float32Array(noise.length);
  for (let i = 0; i < noise.length; i += 1) audio[i] = noise[i] * 0.02;
  const call = detectCall(audio, sampleRate);
  assert.equal(call, null);
  const decoded = decodeRecording(audio, Math.round(2.5 * sampleRate), sampleRate);
  assert.equal(decoded.ok, false);
});
