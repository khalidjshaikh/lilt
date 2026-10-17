/*
 * Listen to the microphone and print decoded Lilt messages to standard output.
 *
 *   npm run listen
 *   npm run listen -- --mic "MacBook Pro Microphone"
 *
 * Standard output is reserved for the messages themselves, one per line, so it
 * can be piped. Progress and errors go to standard error. Press Ctrl+C to stop.
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  DEFAULT_SAMPLE_RATE,
  listAudioInputs,
  resolveMicrophone,
  startMicrophoneStream,
} from "./audio-tools.js";
import { LiveReceiver } from "./live-receiver.js";

const TICK_MS = 120;

function describeStatus(event) {
  switch (event.type) {
    case "call":
      return `call heard at ${event.atSeconds.toFixed(2)} s`;
    case "head":
      return `head read: ${event.payloadLength} bytes, id ${event.messageId}`;
    case "repeat":
      return `heard ${JSON.stringify(event.text)} again; ignoring the repeat`;
    case "error":
      return `could not decode: ${event.reason}`;
    default:
      return null;
  }
}

export async function runListen(options = {}) {
  const sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;
  if (!(sampleRate > 0)) throw new Error("sample rate must be positive");
  const inputs = listAudioInputs();
  const mic = resolveMicrophone(options.mic ?? process.env.LILT_MIC, inputs);
  const onStatus = options.onStatus ?? (() => {});
  const onMessage = options.onMessage ?? (() => {});

  let stream;
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    stream?.stop();
  };

  const receiver = new LiveReceiver({
    sampleRate,
    onStatus,
    onMessage: (message) => {
      onMessage(message);
      if (options.once) stop();
    },
  });

  const handleSignal = () => {
    stop();
  };
  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);

  let timer = null;
  try {
    stream = startMicrophoneStream({
      micIndex: mic.index,
      sampleRate,
      onSamples: (samples) => receiver.push(samples),
      onError: (error) => onStatus({ type: "error", reason: error.message }),
    });
    // If `ready` rejects, `done` may reject too; keep that from becoming an
    // unhandled rejection while we unwind.
    stream.done.catch(() => {});
    await stream.ready;

    onStatus({
      type: "ready",
      microphone: mic.name,
      index: mic.index,
      sampleRate,
    });

    timer = setInterval(() => {
      try {
        receiver.tick();
      } catch (error) {
        onStatus({ type: "error", reason: error.message });
      }
    }, TICK_MS);

    await stream.done;
  } finally {
    if (timer) clearInterval(timer);
    process.removeListener("SIGINT", handleSignal);
    process.removeListener("SIGTERM", handleSignal);
    if (stream && !stopping) stream.stop();
  }

  return { microphone: mic, sampleRate };
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--mic") {
      options.mic = requireValue(argv, ++i, arg);
    } else if (arg === "--sample-rate") {
      options.sampleRate = Number(requireValue(argv, ++i, arg));
    } else if (arg === "--once") {
      options.once = true;
    } else if (arg === "--quiet") {
      options.quiet = true;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  return options;
}

function requireValue(argv, index, option) {
  const value = argv[index];
  if (value == null) throw new Error(`${option} needs a value`);
  return value;
}

function usage() {
  return `Usage: npm run listen -- [options]

Listens through the microphone and prints each decoded message to stdout.
Progress and errors go to stderr. Press Ctrl+C to stop.

Options:
  --mic <index|name>      microphone to use (default: the system input)
  --sample-rate <hz>      sample rate (default: ${DEFAULT_SAMPLE_RATE})
  --once                  stop after the first message
  --quiet                 do not print progress to stderr
  -h, --help              show this help

Environment:
  LILT_MIC                microphone index or name, same as --mic

Examples:
  npm run listen
  npm run listen -- --mic "MacBook Pro Microphone"
  npm run listen -- --quiet --once

The microphone side is macOS-only for now and needs ffmpeg on your PATH.
`;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(usage());
    return;
  }
  if (options.sampleRate != null && !(options.sampleRate > 0)) {
    console.error("listen: sample rate must be positive");
    process.exitCode = 2;
    return;
  }

  const status = (event) => {
    if (options.quiet) return;
    if (event.type === "ready") {
      console.error(
        `listening on ${event.microphone} (${event.index}) at ` +
          `${event.sampleRate} Hz — Ctrl+C to stop`,
      );
      return;
    }
    const message = describeStatus(event);
    if (message) console.error(message);
  };

  try {
    await runListen({
      ...options,
      onStatus: status,
      onMessage: (message) => {
        process.stdout.write(`${message.text}\n`);
      },
    });
  } catch (error) {
    console.error(`listen failed: ${error.message}`);
    process.exitCode = 1;
  }
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  await main();
}
