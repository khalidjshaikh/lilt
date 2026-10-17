/*
 * Minimal WAV helpers for the acoustic tests.
 *
 * The browser app never needs these: Web Audio hands it Float32 samples and
 * plays them back directly. The hardware loopback test writes a file for the
 * system player and reads back what the microphone heard, so a tiny PCM codec
 * keeps that test dependency-free.
 */

const WAV_HEADER_BYTES = 44;
const PCM_FORMAT = 1;
const BITS_PER_SAMPLE = 16;

/** Encode mono Float32 samples as a 16-bit PCM WAV file. */
export function encodeWav(samples, sampleRate) {
  if (!(sampleRate > 0)) throw new Error("sample rate must be positive");
  const dataBytes = samples.length * 2;
  const bytes = new Uint8Array(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(bytes.buffer);

  writeAscii(bytes, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(bytes, 8, "WAVE");

  writeAscii(bytes, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, PCM_FORMAT, true);
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, BITS_PER_SAMPLE, true);

  writeAscii(bytes, 36, "data");
  view.setUint32(40, dataBytes, true);

  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(WAV_HEADER_BYTES + i * 2, Math.round(clamped * 32767), true);
  }
  return bytes;
}

/** Decode the 16-bit mono PCM WAV files written by the test recorder. */
export function decodeWav(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 12) throw new Error("WAV file is too short");
  if (readAscii(bytes, 0, 4) !== "RIFF" || readAscii(bytes, 8, 12) !== "WAVE") {
    throw new Error("not a RIFF/WAVE file");
  }

  let format = null;
  let data = null;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = readAscii(bytes, offset, offset + 4);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (body + size > bytes.length) throw new Error(`truncated ${id} chunk`);

    if (id === "fmt ") {
      format = {
        encoding: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bitsPerSample: view.getUint16(body + 14, true),
      };
    } else if (id === "data") {
      data = bytes.subarray(body, body + size);
    }
    offset = body + size + (size % 2);
  }

  if (!format) throw new Error("WAV file has no fmt chunk");
  if (!data) throw new Error("WAV file has no data chunk");
  if (format.encoding !== PCM_FORMAT) throw new Error("WAV is not integer PCM");
  if (format.bitsPerSample !== BITS_PER_SAMPLE) {
    throw new Error(`WAV is ${format.bitsPerSample}-bit; expected 16-bit`);
  }
  if (format.channels !== 1) {
    throw new Error(`WAV has ${format.channels} channels; expected mono`);
  }

  const samples = new Float32Array(Math.floor(data.length / 2));
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = view.getInt16(data.byteOffset - bytes.byteOffset + i * 2, true) / 32768;
  }
  return { samples, sampleRate: format.sampleRate, channels: 1 };
}

function writeAscii(bytes, offset, text) {
  for (let i = 0; i < text.length; i += 1) bytes[offset + i] = text.charCodeAt(i);
}

function readAscii(bytes, from, to) {
  let text = "";
  for (let i = from; i < to; i += 1) text += String.fromCharCode(bytes[i]);
  return text;
}
