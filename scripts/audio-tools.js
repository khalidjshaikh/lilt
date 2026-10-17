/*
 * Small audio helpers for the command-line tools.
 *
 * The browser app uses Web Audio directly. Tools that run in a terminal need
 * the operating system to play a file and hand over microphone samples, so
 * this module wraps `afplay` (or `ffplay`) and `ffmpeg`/avfoundation.
 *
 * The microphone side is macOS-only, matching the acoustic loopback test.
 */

import { execFileSync, spawn } from "node:child_process";

export const DEFAULT_SAMPLE_RATE = 48_000;

export function listAudioInputs() {
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

export function resolveMicrophone(requested, inputs) {
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

/** Play a mono 16-bit PCM WAV file and resolve when the speaker is done. */
export function playFile(path) {
  const player =
    process.platform === "darwin"
      ? { command: "afplay", args: [path] }
      : {
          command: "ffplay",
          args: ["-hide_banner", "-loglevel", "error", "-nodisp", "-autoexit", path],
        };
  return new Promise((resolve, reject) => {
    const child = spawn(player.command, player.args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      reject(
        error.code === "ENOENT"
          ? new Error(
              `${player.command} was not found. ` +
                (process.platform === "darwin"
                  ? "It normally ships with macOS."
                  : "Install ffmpeg (which provides ffplay)."),
            )
          : error,
      );
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else {
        reject(
          new Error(
            `${player.command} failed with exit code ${code}: ${stderr.trim()}`,
          ),
        );
      }
    });
  });
}

/**
 * Stream raw mono PCM from the microphone.
 *
 * Returns promises for `ready` (ffmpeg has opened the input) and `done` (the
 * stream has closed), plus a `stop()` that shuts the recorder down cleanly.
 * Samples arrive through `onSamples` as Float32Arrays in the range -1..1.
 */
export function startMicrophoneStream(options) {
  if (process.platform !== "darwin") {
    throw new Error(
      "Microphone capture currently needs macOS and ffmpeg/avfoundation.",
    );
  }

  const sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const micIndex = options.micIndex;
  const onSamples = options.onSamples ?? (() => {});
  const onError = options.onError ?? (() => {});

  const args = [
    "-hide_banner",
    "-loglevel",
    "info",
    "-nostats",
    "-f",
    "avfoundation",
    "-i",
    `:${micIndex}`,
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
    "-f",
    "s16le",
    "pipe:1",
  ];

  const child = spawn("ffmpeg", args, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  let readySettled = false;
  let stopping = false;
  let suffix = Buffer.alloc(0);

  let resolveReady;
  let rejectReady;
  let resolveDone;
  let rejectDone;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const done = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  const startupTimer = setTimeout(() => {
    if (readySettled) return;
    readySettled = true;
    child.kill("SIGINT");
    rejectReady(new Error("ffmpeg did not start recording within 8 seconds"));
  }, 8000);

  child.stdout.on("data", (chunk) => {
    const bytes = suffix.length ? Buffer.concat([suffix, chunk]) : chunk;
    const usable = bytes.length - (bytes.length % 2);
    if (usable > 0) {
      const samples = new Float32Array(usable / 2);
      for (let i = 0; i < samples.length; i += 1) {
        samples[i] = bytes.readInt16LE(i * 2) / 32768;
      }
      try {
        onSamples(samples);
      } catch (error) {
        onError(error);
      }
    }
    suffix = bytes.subarray(usable);
  });

  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-65_536);
    if (!readySettled && stderr.includes("Output #0")) {
      readySettled = true;
      clearTimeout(startupTimer);
      resolveReady();
    }
  });

  child.on("error", (error) => {
    clearTimeout(startupTimer);
    const wrapped =
      error.code === "ENOENT"
        ? new Error("ffmpeg was not found. Install ffmpeg and try again.")
        : error;
    if (!readySettled) {
      readySettled = true;
      rejectReady(wrapped);
    }
    rejectDone(wrapped);
  });

  child.on("close", (code) => {
    clearTimeout(startupTimer);
    if (!readySettled) {
      readySettled = true;
      rejectReady(
        new Error(
          `ffmpeg stopped before recording began (exit code ${code}):\n${stderr.trim()}`,
        ),
      );
    }
    if (stopping || code === 0) {
      resolveDone();
    } else {
      rejectDone(
        new Error(
          `ffmpeg recording failed with exit code ${code}:\n${stderr.trim()}`,
        ),
      );
    }
  });

  function stop() {
    if (stopping) return;
    stopping = true;
    if (child.exitCode === null) child.kill("SIGINT");
  }

  return { ready, done, stop };
}

export function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
