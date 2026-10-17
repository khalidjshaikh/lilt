import assert from "node:assert/strict";
import test from "node:test";

import { buildPacket } from "../src/protocol.js";
import { synthesizePacket } from "../src/dsp.js";
import { LiveReceiver } from "../scripts/live-receiver.js";

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

function feed(receiver, samples, sampleRate) {
  const chunk = Math.round(0.12 * sampleRate);
  for (let start = 0; start < samples.length; start += chunk) {
    receiver.push(samples.subarray(start, start + chunk));
    receiver.tick();
  }
}

for (const sampleRate of [44_100, 48_000]) {
  test(`live receiver prints a packet streamed at ${sampleRate} Hz`, () => {
    const text = "hello from a streamed microphone";
    const packet = buildPacket(text, { messageId: 33 });
    const rendered = synthesizePacket(packet, sampleRate);
    const messages = [];
    const statuses = [];

    const receiver = new LiveReceiver({
      sampleRate,
      onMessage: (message) => messages.push(message),
      onStatus: (status) => statuses.push(status),
    });
    feed(receiver, rendered.samples, sampleRate);

    assert.equal(messages.length, 1, JSON.stringify(statuses));
    assert.equal(messages[0].text, text);
    assert.equal(messages[0].header.messageId, 33);
    assert.ok(messages[0].confidence > 0.5, `confidence ${messages[0].confidence}`);
  });
}

test("live receiver ignores the same message when it is repeated", () => {
  const sampleRate = 48_000;
  const text = "say it twice";
  const first = synthesizePacket(buildPacket(text, { messageId: 8 }), sampleRate);
  const second = synthesizePacket(buildPacket(text, { messageId: 8 }), sampleRate);
  const audio = new Float32Array(first.samples.length + second.samples.length);
  audio.set(first.samples);
  audio.set(second.samples, first.samples.length);
  addNoise(audio, 18, 0xbeef);

  const messages = [];
  const statuses = [];
  const receiver = new LiveReceiver({
    sampleRate,
    onMessage: (message) => messages.push(message),
    onStatus: (status) => statuses.push(status),
  });
  feed(receiver, audio, sampleRate);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, text);
  assert.ok(
    statuses.some((status) => status.type === "repeat"),
    JSON.stringify(statuses),
  );
});
