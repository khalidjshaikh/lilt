/*
 * Acoustic loopback test.
 *
 * This is the part the unit tests cannot fake: render a packet, let the
 * computer speak it through its speaker, record the room through its
 * microphone, and decode what actually arrived. It is intentionally separate
 * from `npm test` because it needs a microphone, a speaker, and permission to
 * use both.
 *
 * macOS only for now. It uses the tools that ship with the system (`afplay`,
 * `osascript`, `system_profiler`) plus `ffmpeg` for capture.
 */

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { buildPacket, CALL_TO_DATA_MS } from "../src/protocol.js";
import { decodeRecording, detectCall, synthesizePacket } from "../src/dsp.js";
import { decodeWav, encodeWav } from "../src/wav.js";

const DEFAULT_TEXT = "hello from the room";
const DEFAULT_MESSAGE_ID = 42;
const DEFAULT_SAMPLE_RATE = 48_000;
const DEFAULT_PRE_ROLL = 1.0;
const DEFAULT_TAIL = 1.5;
const DEFAULT_SYSTEM_VOLUME = 40;

export async function runAcousticLoopback(options = {}) {
  if (process.platform !== "darwin") {
    throw new Error(
      "The acoustic loopback test currently needs macOS tools (afplay, ffmpeg/avfoundation).",
    );
  }

  const text = options.text ?? DEFAULT_TEXT;
  const messageId = options.messageId ?? DEFAULT_MESSAGE_ID;
  const sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const playbackGain = options.playbackGain ?? 0.5;
  const preRoll = options.preRoll ?? DEFAULT_PRE_ROLL;
  const tail = options.tail ?? DEFAULT_TAIL;
  const requestedVolume = options.systemVolume ?? DEFAULT_SYSTEM_VOLUME;
  const log = options.quiet ? () => {} : (...parts) => console.log(...parts);
  const temporaryDirectory = !options.workDirectory;
  const workDirectory =
    options.workDirectory ??
    mkdtempSync(join(tmpdir(), "lilt-acoustic-"));
  const transmitPath = join(workDirectory, "transmit.wav");
  const recordingPath = join(workDirectory, "recording.wav");
  let keepFiles = Boolean(options.keep) || !temporaryDirectory;

  const packet = buildPacket(text, { messageId });
  const rendered = synthesizePacket(packet, sampleRate);
  const scaled = new Float32Array(rendered.samples.length);
  for (let i = 0; i < rendered.samples.length; i += 1) {
    scaled[i] = rendered.samples[i] * playbackGain;
  }
  writeFileSync(transmitPath, encodeWav(scaled, sampleRate));
  log(`transmit: ${text} (${packet.payload.length} bytes, ${rendered.end.toFixed(2)} s)`);

  const inputs = listAudioInputs();
  const mic = resolveMicrophone(options.mic ?? process.env.LILT_MIC, inputs);
  log(`microphone: ${mic.name} (${mic.index})`);

  const originalVolume = readSystemVolume();
  if (requestedVolume != null) {
    setSystemVolume(requestedVolume, false);
    log(
      `system volume: ${originalVolume.volume}${originalVolume.muted ? " (muted)" : ""} -> ${requestedVolume}`,
    );
  }

  let recorder;
  try {
    const recordSeconds = preRoll + rendered.end + tail;
    log(`recording ${recordSeconds.toFixed(1)} s while the speaker plays...`);
    recorder = startRecorder({
      micIndex: mic.index,
      recordSeconds,
      sampleRate,
      recordingPath,
    });
    recorder.done.catch(() => {
      // Awaited below; this prevents an early ffmpeg failure from becoming an
      // unhandled rejection while we are still waiting for `ready`.
    });
    await recorder.ready;
    await sleep(preRoll * 1000);
    await playFile(transmitPath);
    await recorder.done;
  } catch (error) {
    keepFiles = true;
    throw withArtifacts(error, transmitPath, recordingPath);
  } finally {
    if (requestedVolume != null) {
      setSystemVolume(originalVolume.volume, originalVolume.muted);
    }
  }

  let decoded;
  try {
    const recording = decodeWav(readFileSync(recordingPath));
    const call = detectCall(recording.samples, recording.sampleRate);
    if (!call) {
      throw new Error("the recording never produced a convincing two-tone call");
    }
    log(
      `call heard at ${(call.startSample / recording.sampleRate).toFixed(3)} s ` +
        `(strength ${call.strength.toFixed(2)})`,
    );
    decoded = decodeAround(recording.samples, recording.sampleRate, call.startSample);
    if (!decoded.ok) {
      throw new Error(`the recording did not decode: ${decoded.reason}`);
    }
    if (decoded.text !== text) {
      throw new Error(
        `decoded text does not match: expected ${JSON.stringify(text)}, ` +
          `received ${JSON.stringify(decoded.text)}`,
      );
    }
  } catch (error) {
    keepFiles = true;
    throw withArtifacts(error, transmitPath, recordingPath);
  }

  if (!keepFiles) rmSync(workDirectory, { recursive: true, force: true });
  return {
    ok: true,
    text,
    received: decoded.text,
    messageId,
    sampleRate,
    microphone: mic,
    recordingSeconds: rendered.end + preRoll + tail,
    syncSeconds: decoded.syncOffset / sampleRate,
    confidence: decoded.confidence,
    transmitPath: keepFiles ? transmitPath : null,
    recordingPath: keepFiles ? recordingPath : null,
  };
}

function decodeAround(samples, sampleRate, callStart) {
  const expectedSync = callStart + (CALL_TO_DATA_MS / 1000) * sampleRate;
  let last = { ok: false, reason: "no greeting candidates" };
  for (const shift of [0, -0.05, 0.05, -0.1, 0.1, -0.2, 0.2, -0.3, 0.3]) {
    const approximately = Math.round(expectedSync + shift * sampleRate);
    const decoded = decodeRecording(samples, approximately, sampleRate);
    if (decoded.ok) return decoded;
    last = decoded;
  }
  return last;
}

function startRecorder({ micIndex, recordSeconds, sampleRate, recordingPath }) {
  const args = [
    "-hide_banner",
    "-loglevel",
    "info",
    "-f",
    "avfoundation",
    "-i",
    `:${micIndex}`,
    "-t",
    recordSeconds.toFixed(3),
    "-ac",
    "1",
    "-ar",
    String(sampleRate),
    // avfoundation can drop sample blocks on macOS. `async` pads the gaps from
    // the device timestamps instead of silently shortening the recording.
    "-af",
    "aresample=async=1:min_hard_comp=0.01",
    "-c:a",
    "pcm_s16le",
    "-y",
    recordingPath,
  ];
  const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  let readySettled = false;

  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const done = new Promise((resolve, reject) => {
    const readyTimer = setTimeout(() => {
      child.kill("SIGINT");
      readySettled = true;
      rejectReady(new Error("ffmpeg did not start recording within 8 seconds"));
    }, 8000);

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (!readySettled && stderr.includes("Output #0")) {
        clearTimeout(readyTimer);
        readySettled = true;
        resolveReady();
      }
    });
    child.on("error", (error) => {
      clearTimeout(readyTimer);
      readySettled = true;
      rejectReady(error);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(readyTimer);
      if (!readySettled) {
        readySettled = true;
        rejectReady(
          new Error(
            `ffmpeg stopped before recording began (exit code ${code}):\n${stderr.trim()}`,
          ),
        );
      }
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `ffmpeg recording failed with exit code ${code}:\n${stderr.trim()}`,
          ),
        );
      }
    });
  });

  return { ready, done };
}

function playFile(path) {
  return new Promise((resolve, reject) => {
    const child = spawn("afplay", [path], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`afplay failed with exit code ${code}: ${stderr.trim()}`));
    });
  });
}

function listAudioInputs() {
  let output = "";
  try {
    execFileSync(
      "ffmpeg",
      ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    output = error.stderr ?? error.stdout ?? "";
  }
  const lines = output.split(/\r?\n/);
  const inputs = [];
  let inAudio = false;
  for (const line of lines) {
    if (line.includes("AVFoundation audio devices:")) {
      inAudio = true;
      continue;
    }
    if (line.includes("AVFoundation video devices:")) {
      inAudio = false;
      continue;
    }
    if (!inAudio) continue;
    const match = /\[(\d+)\]\s+(.+?)\s*$/.exec(line);
    if (match) inputs.push({ index: Number(match[1]), name: match[2] });
  }
  if (inputs.length === 0) {
    throw new Error(
      "No microphone inputs were found. Install ffmpeg and check Microphone permission.",
    );
  }
  return inputs;
}

function resolveMicrophone(requested, inputs) {
  if (requested != null && String(requested).trim() !== "") {
    const value = String(requested).trim();
    if (/^\d+$/.test(value)) {
      const byIndex = inputs.find((input) => input.index === Number(value));
      if (byIndex) return byIndex;
    }
    const lowered = value.toLowerCase();
    const byName = inputs.find((input) => input.name.toLowerCase().includes(lowered));
    if (byName) return byName;
    throw new Error(
      `No microphone matches ${JSON.stringify(value)}. Available: ` +
        inputs.map((input) => `${input.index}=${input.name}`).join(", "),
    );
  }

  const defaultName = defaultInputName();
  if (defaultName) {
    const byDefault = inputs.find(
      (input) => input.name.toLowerCase() === defaultName.toLowerCase(),
    );
    if (byDefault) return byDefault;
  }
  return inputs[0];
}

function defaultInputName() {
  try {
    const output = execFileSync("system_profiler", ["SPAudioDataType", "-json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const data = JSON.parse(output);
    for (const group of data.SPAudioDataType ?? []) {
      for (const item of group._items ?? []) {
        if (item.coreaudio_default_audio_input_device === "spaudio_yes") {
          return item._name;
        }
      }
    }
  } catch {
    // system_profiler is a convenience; ffmpeg's list is authoritative.
  }
  return null;
}

function readSystemVolume() {
  const output = execFileSync("osascript", ["-e", "get volume settings"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const volume = /output volume:(\d+)/.exec(output);
  return {
    volume: volume ? Number(volume[1]) : 50,
    muted: /output muted:true/.test(output),
  };
}

function setSystemVolume(volume, muted = false) {
  const level = Math.max(1, Math.min(100, Math.round(volume)));
  execFileSync(
    "osascript",
    [
      "-e",
      `set volume output volume ${level} ${muted ? "with" : "without"} output muted`,
    ],
    { stdio: ["ignore", "ignore", "ignore"] },
  );
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function withArtifacts(error, transmitPath, recordingPath) {
  error.message +=
    `\nThe transmit WAV is at ${transmitPath}` +
    `\nThe recording is at ${recordingPath}`;
  return error;
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--keep") {
      options.keep = true;
    } else if (arg === "--quiet") {
      options.quiet = true;
    } else if (arg === "--text") {
      options.text = argv[++i];
    } else if (arg === "--mic") {
      options.mic = argv[++i];
    } else if (arg === "--message-id") {
      options.messageId = Number(argv[++i]);
    } else if (arg === "--sample-rate") {
      options.sampleRate = Number(argv[++i]);
    } else if (arg === "--gain") {
      options.playbackGain = Number(argv[++i]);
    } else if (arg === "--system-volume") {
      options.systemVolume = Number(argv[++i]);
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  return options;
}

function usage() {
  return `Usage: node scripts/acoustic-loopback.js [options]

Renders a Lilt message, plays it through the default speaker, records the room
through a microphone, and decodes the result.

Options:
  --text <message>        text to send (default: "${DEFAULT_TEXT}")
  --mic <index|name>      microphone to use (default: the system input)
  --message-id <n>        message id, 0-255 (default: ${DEFAULT_MESSAGE_ID})
  --sample-rate <hz>      sample rate (default: ${DEFAULT_SAMPLE_RATE})
  --gain <0..1>           playback amplitude (default: 0.5)
  --system-volume <0..100> output volume during the test (default: 40)
  --keep                  keep the transmit and recording WAV files
  --quiet                 only print the result
  -h, --help              show this help

Environment:
  LILT_MIC                microphone index or name, same as --mic
  LILT_SYSTEM_VOLUME      same as --system-volume
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
  if (options.systemVolume == null && process.env.LILT_SYSTEM_VOLUME) {
    options.systemVolume = Number(process.env.LILT_SYSTEM_VOLUME);
  }
  try {
    const result = await runAcousticLoopback(options);
    console.log(
      `decoded: ${JSON.stringify(result.received)} ` +
        `(id ${result.messageId}, sync ${result.syncSeconds.toFixed(3)} s, ` +
        `confidence ${result.confidence.toFixed(3)})`,
    );
  } catch (error) {
    console.error(`acoustic loopback failed: ${error.message}`);
    process.exitCode = 1;
  }
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  await main();
}
