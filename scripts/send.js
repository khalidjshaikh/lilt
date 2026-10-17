/*
 * Send one Lilt message through the speaker.
 *
 *   npm run send -- "hello from the room"
 *   printf 'piped text' | npm run send
 *
 * Rendering and playback are local; the room is the network.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { MAX_PAYLOAD_BYTES, buildPacket } from "../src/protocol.js";
import { synthesizePacket } from "../src/dsp.js";
import { encodeWav } from "../src/wav.js";
import {
  DEFAULT_SAMPLE_RATE,
  playFile,
} from "./audio-tools.js";

const DEFAULT_GAIN = 0.5;
const encoder = new TextEncoder();

export async function runSend(options = {}) {
  const text = options.text;
  if (typeof text !== "string" || text.length === 0) {
    throw new Error("there is no text to send");
  }
  const bytes = encoder.encode(text).length;
  if (bytes > MAX_PAYLOAD_BYTES) {
    throw new Error(
      `message is ${bytes} bytes; the Lilt limit is ${MAX_PAYLOAD_BYTES}`,
    );
  }

  const sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const gain = options.gain ?? DEFAULT_GAIN;
  if (!(sampleRate > 0)) throw new Error("sample rate must be positive");
  if (!(gain >= 0 && gain <= 1)) throw new Error("gain must be between 0 and 1");
  const messageId = options.messageId;
  if (
    messageId != null &&
    (!Number.isInteger(messageId) || messageId < 0 || messageId > 255)
  ) {
    throw new Error("message id must be an integer from 0 to 255");
  }

  const onStatus = options.onStatus ?? (() => {});
  const packet = buildPacket(text, { messageId });
  const rendered = synthesizePacket(packet, sampleRate);
  const samples = new Float32Array(rendered.samples.length);
  for (let i = 0; i < rendered.samples.length; i += 1) {
    samples[i] = rendered.samples[i] * gain;
  }

  const directory = mkdtempSync(join(tmpdir(), "lilt-send-"));
  const transmitPath = join(directory, "transmit.wav");
  try {
    writeFileSync(transmitPath, encodeWav(samples, sampleRate));
    onStatus(
      `sending ${JSON.stringify(text)} — ${bytes} bytes, ` +
        `${packet.airtimeSeconds.toFixed(1)} s of air, id ${packet.messageId}`,
    );
    onStatus("playing through the speaker…");
    await playFile(transmitPath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }

  return {
    text,
    bytes,
    messageId: packet.messageId,
    sampleRate,
    airtimeSeconds: packet.airtimeSeconds,
    renderedSeconds: rendered.end,
  };
}

function parseArgs(argv) {
  const options = {};
  const words = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--text") {
      options.text = requireValue(argv, ++i, arg);
    } else if (arg === "--message-id") {
      options.messageId = Number(requireValue(argv, ++i, arg));
    } else if (arg === "--sample-rate") {
      options.sampleRate = Number(requireValue(argv, ++i, arg));
    } else if (arg === "--gain") {
      options.gain = Number(requireValue(argv, ++i, arg));
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      words.push(arg);
    }
  }
  if (options.text == null && words.length > 0) options.text = words.join(" ");
  return options;
}

function requireValue(argv, index, option) {
  const value = argv[index];
  if (value == null) throw new Error(`${option} needs a value`);
  return value;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

function usage() {
  return `Usage: npm run send -- [options] <text>

Renders a Lilt message and plays it through the speaker.

Options:
  --text <message>        text to send (the positional form is equivalent)
  --message-id <n>        message id, 0-255 (default: random)
  --sample-rate <hz>      sample rate (default: ${DEFAULT_SAMPLE_RATE})
  --gain <0..1>           playback amplitude (default: ${DEFAULT_GAIN})
  -h, --help              show this help

Examples:
  npm run send -- "hello from the room"
  npm run send -- --message-id 7 "hello again"
  printf 'piped text' | npm run send

Environment:
  LILT_MIC                not used by the sender; see \`npm run listen\`
`;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    if (!options.help && options.text == null && !process.stdin.isTTY) {
      options.text = await readStdin();
    }
    if (!options.help && (options.text == null || options.text.length === 0)) {
      throw new Error("write something to send");
    }
  } catch (error) {
    console.error(`send: ${error.message}`);
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(usage());
    return;
  }

  try {
    const result = await runSend({
      ...options,
      onStatus: (message) => console.error(message),
    });
    console.error(
      `sent ${JSON.stringify(result.text)} ` +
        `(${result.bytes} bytes, id ${result.messageId})`,
    );
  } catch (error) {
    console.error(`send failed: ${error.message}`);
    process.exitCode = 1;
  }
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  await main();
}
