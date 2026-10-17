/*
 * Lilt, v1
 *
 * A 16-tone acoustic alphabet. A nibble is a syllable; two syllables make a
 * byte. The frame is:
 *
 *   call (two-tone chord) -> greeting (8 known syllables) -> head (15)
 *   -> body (interleaved Reed-Solomon blocks) -> hush
 *
 * The head and body both use RS(15, 11) over GF(16), correcting up to two
 * wrong syllables in every fifteen.
 */

export const VERSION = 1;
export const SAMPLE_RATE = 48_000;

export const TONE_BASE = 600;
export const TONE_STEP = 100;
export const TONE_COUNT = 16;
export const TONE_FREQS = Object.freeze(
  Array.from({ length: TONE_COUNT }, (_, i) => TONE_BASE + i * TONE_STEP),
);

export const SYMBOL_MS = 50;
export const SYMBOL_SECONDS = SYMBOL_MS / 1000;
export const TONE_MS = 45;
export const SYMBOL_GAP_MS = 5;

export const CALL_MS = 600;
export const CALL_GAP_MS = 100;
export const CALL_TO_DATA_MS = CALL_MS + CALL_GAP_MS;

// The greeting is deliberately eight different syllables: it is easy to
// correlate against, and hard to mistake for the call.
export const SYNC_SYMBOLS = Object.freeze([0xf, 0x0, 0x5, 0xa, 0x3, 0xc, 0x9, 0x6]);

export const BLOCK_DATA_SYMBOLS = 11;
export const BLOCK_PARITY_SYMBOLS = 4;
export const CODEWORD_SYMBOLS = BLOCK_DATA_SYMBOLS + BLOCK_PARITY_SYMBOLS;

export const MAX_PAYLOAD_BYTES = 512;
export const HEADER_BYTES = 5;
export const FLAG_TEXT = 0;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/* ------------------------------------------------------------------ */
/* GF(16)                                                              */
/* ------------------------------------------------------------------ */

// x^4 + x + 1, with alpha = 2.
const GF_EXP = new Uint8Array(30);
const GF_LOG = new Int8Array(16).fill(-1);

{
  let x = 1;
  for (let i = 0; i < 15; i += 1) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x10) x ^= 0x13;
  }
  for (let i = 15; i < 30; i += 1) GF_EXP[i] = GF_EXP[i - 15];
}

function gfAdd(a, b) {
  return a ^ b;
}

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function gfDiv(a, b) {
  if (b === 0) throw new Error("division by zero in GF(16)");
  if (a === 0) return 0;
  return GF_EXP[(GF_LOG[a] - GF_LOG[b] + 15) % 15];
}

function gfPow(a, n) {
  if (n === 0) return 1;
  if (a === 0) return 0;
  return GF_EXP[(GF_LOG[a] * n) % 15];
}

function buildGenerator() {
  let g = [1];
  for (let i = 1; i <= BLOCK_PARITY_SYMBOLS; i += 1) {
    const root = GF_EXP[i];
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j += 1) {
      next[j] ^= g[j];
      next[j + 1] ^= gfMul(g[j], root);
    }
    g = next;
  }
  return Uint8Array.from(g);
}

const GENERATOR = buildGenerator();

export function rsSyndromes(codeword) {
  const s = new Uint8Array(BLOCK_PARITY_SYMBOLS);
  for (let j = 1; j <= BLOCK_PARITY_SYMBOLS; j += 1) {
    const a = GF_EXP[j];
    let value = 0;
    for (let i = 0; i < codeword.length; i += 1) {
      value = gfMul(value, a) ^ codeword[i];
    }
    s[j - 1] = value;
  }
  return s;
}

/**
 * Systematic RS(15, 11), correcting two symbol errors.
 * The returned array is data (11) followed by parity (4).
 */
export function rsEncode(data) {
  if (data.length !== BLOCK_DATA_SYMBOLS) {
    throw new Error(`RS block must have ${BLOCK_DATA_SYMBOLS} data symbols`);
  }
  const work = new Uint8Array(CODEWORD_SYMBOLS);
  work.set(data, 0);
  for (let i = 0; i < BLOCK_DATA_SYMBOLS; i += 1) {
    const coefficient = work[i];
    if (coefficient === 0) continue;
    for (let j = 0; j < GENERATOR.length; j += 1) {
      work[i + j] ^= gfMul(GENERATOR[j], coefficient);
    }
  }
  return Uint8Array.from([...data, ...work.subarray(BLOCK_DATA_SYMBOLS)]);
}

function correctAt(codeword, positions, values) {
  const fixed = Uint8Array.from(codeword);
  for (let i = 0; i < positions.length; i += 1) {
    fixed[14 - positions[i]] ^= values[i];
  }
  const check = rsSyndromes(fixed);
  return check.every((x) => x === 0) ? fixed : null;
}

/** Returns the corrected codeword, or null if more than two symbols are wrong. */
export function rsDecode(received) {
  if (received.length !== CODEWORD_SYMBOLS) {
    throw new Error(`RS codeword must have ${CODEWORD_SYMBOLS} symbols`);
  }
  const codeword = Uint8Array.from(received);
  const s = rsSyndromes(codeword);
  if (s.every((x) => x === 0)) return codeword;

  // One error: S_j = e * X^j.
  for (let p = 0; p < CODEWORD_SYMBOLS; p += 1) {
    const x = GF_EXP[p];
    const e = gfDiv(s[0], x);
    if (e === 0) continue;
    let ok = true;
    for (let j = 2; j <= BLOCK_PARITY_SYMBOLS; j += 1) {
      if (s[j - 1] !== gfMul(e, gfPow(x, j))) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const fixed = correctAt(codeword, [p], [e]);
    if (fixed) return fixed;
  }

  // Two errors. Solve S1 and S2 for the two magnitudes, then check S3/S4.
  for (let p1 = 0; p1 < CODEWORD_SYMBOLS; p1 += 1) {
    const x1 = GF_EXP[p1];
    for (let p2 = p1 + 1; p2 < CODEWORD_SYMBOLS; p2 += 1) {
      const x2 = GF_EXP[p2];
      const x1PlusX2 = gfAdd(x1, x2);
      const denominator = gfMul(x1, x1PlusX2);
      if (denominator === 0) continue;
      const e1 = gfDiv(gfAdd(s[1], gfMul(s[0], x2)), denominator);
      const e2 = gfDiv(gfAdd(s[0], gfMul(e1, x1)), x2);
      if (e1 === 0 || e2 === 0) continue;
      let ok = true;
      for (let j = 3; j <= BLOCK_PARITY_SYMBOLS; j += 1) {
        const expected = gfAdd(
          gfMul(e1, gfPow(x1, j)),
          gfMul(e2, gfPow(x2, j)),
        );
        if (s[j - 1] !== expected) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      const fixed = correctAt(codeword, [p1, p2], [e1, e2]);
      if (fixed) return fixed;
    }
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* Checksums                                                           */
/* ------------------------------------------------------------------ */

export function crc8(bytes) {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}

export function crc16(bytes) {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

/* ------------------------------------------------------------------ */
/* Converters and frame layout                                         */
/* ------------------------------------------------------------------ */

export function bytesToNibbles(bytes) {
  const nibbles = [];
  for (const byte of bytes) {
    nibbles.push((byte >> 4) & 0x0f, byte & 0x0f);
  }
  return nibbles;
}

export function nibblesToBytes(nibbles) {
  const bytes = new Uint8Array(Math.floor(nibbles.length / 2));
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = ((nibbles[i * 2] & 0x0f) << 4) | (nibbles[i * 2 + 1] & 0x0f);
  }
  return bytes;
}

export function bodyBlockCount(payloadLength) {
  const rawNibbles = (payloadLength + 2) * 2;
  return Math.ceil(rawNibbles / BLOCK_DATA_SYMBOLS);
}

export function bodySymbolCount(payloadLength) {
  return bodyBlockCount(payloadLength) * CODEWORD_SYMBOLS;
}

export function randomMessageId() {
  if (globalThis.crypto?.getRandomValues) {
    return globalThis.crypto.getRandomValues(new Uint8Array(1))[0];
  }
  return Math.floor(Math.random() * 256);
}

function interleave(blocks) {
  const out = [];
  for (let symbol = 0; symbol < CODEWORD_SYMBOLS; symbol += 1) {
    for (const block of blocks) out.push(block[symbol]);
  }
  return out;
}

export function deinterleave(symbols, blockCount) {
  if (symbols.length !== blockCount * CODEWORD_SYMBOLS) {
    throw new Error("body symbol count does not match block count");
  }
  const blocks = Array.from({ length: blockCount }, () => new Array(CODEWORD_SYMBOLS));
  for (let i = 0; i < symbols.length; i += 1) {
    const withinBlock = i % blockCount;
    const position = Math.floor(i / blockCount);
    blocks[withinBlock][position] = symbols[i];
  }
  return blocks;
}

export function makeHeader({ messageId, flags = FLAG_TEXT, payloadLength }) {
  if (payloadLength < 0 || payloadLength > MAX_PAYLOAD_BYTES) {
    throw new Error(`payload must be 0-${MAX_PAYLOAD_BYTES} bytes`);
  }
  const header = Uint8Array.of(
    (VERSION << 4) | (flags & 0x0f),
    messageId & 0xff,
    (payloadLength >> 8) & 0xff,
    payloadLength & 0xff,
    0,
  );
  header[4] = crc8(header.subarray(0, 4));
  return header;
}

export function parseHeader(header) {
  if (header.length !== HEADER_BYTES) return null;
  if (crc8(header.subarray(0, 4)) !== header[4]) return null;
  const version = (header[0] >> 4) & 0x0f;
  if (version !== VERSION) return null;
  const flags = header[0] & 0x0f;
  const messageId = header[1];
  const payloadLength = (header[2] << 8) | header[3];
  if (payloadLength > MAX_PAYLOAD_BYTES) return null;
  return { version, flags, messageId, payloadLength };
}

/**
 * Build a complete packet from a string.
 * Returns the header/body symbols separately and interleaved for transmission.
 */
export function buildPacket(text, { messageId = randomMessageId(), flags = FLAG_TEXT } = {}) {
  const payload = textEncoder.encode(text);
  if (payload.length > MAX_PAYLOAD_BYTES) {
    throw new Error(`message is ${payload.length} bytes; limit is ${MAX_PAYLOAD_BYTES}`);
  }
  const header = makeHeader({ messageId, flags, payloadLength: payload.length });
  const headerData = bytesToNibbles(header);
  headerData.push(0);
  const headerSymbols = rsEncode(headerData);

  const checksum = crc16(Uint8Array.from([...header, ...payload]));
  const bodyBytes = Uint8Array.from([
    ...payload,
    (checksum >> 8) & 0xff,
    checksum & 0xff,
  ]);
  const bodyNibbles = bytesToNibbles(bodyBytes);
  while (bodyNibbles.length % BLOCK_DATA_SYMBOLS !== 0) bodyNibbles.push(0);

  const blocks = [];
  for (let i = 0; i < bodyNibbles.length; i += BLOCK_DATA_SYMBOLS) {
    blocks.push(rsEncode(bodyNibbles.slice(i, i + BLOCK_DATA_SYMBOLS)));
  }
  const bodySymbols = interleave(blocks);

  return {
    text,
    payload,
    header,
    headerSymbols,
    blocks,
    bodySymbols,
    messageId,
    flags,
    symbols: [...headerSymbols, ...bodySymbols],
    airtimeSeconds:
      (CALL_MS + CALL_GAP_MS) / 1000 +
      (SYNC_SYMBOLS.length + headerSymbols.length + bodySymbols.length) * SYMBOL_SECONDS,
  };
}

export function decodeHeaderSymbols(symbols) {
  if (symbols.length !== CODEWORD_SYMBOLS) return null;
  const corrected = rsDecode(symbols);
  if (!corrected) return null;
  const header = nibblesToBytes(corrected.slice(0, 10));
  const parsed = parseHeader(header);
  if (!parsed) return null;
  return { ...parsed, header, corrected };
}

export function decodeBodySymbols(symbols, header) {
  const blocks = bodyBlockCount(header.payloadLength);
  const expected = blocks * CODEWORD_SYMBOLS;
  if (symbols.length !== expected) {
    return { ok: false, reason: `expected ${expected} body syllables, got ${symbols.length}` };
  }
  const interleavedBlocks = deinterleave(symbols, blocks);
  const nibbles = [];
  for (let i = 0; i < interleavedBlocks.length; i += 1) {
    const corrected = rsDecode(interleavedBlocks[i]);
    if (!corrected) {
      return { ok: false, reason: `block ${i + 1} of ${blocks} was unreadable` };
    }
    for (let j = 0; j < BLOCK_DATA_SYMBOLS; j += 1) nibbles.push(corrected[j]);
  }

  const raw = nibblesToBytes(nibbles.slice(0, (header.payloadLength + 2) * 2));
  const payload = raw.slice(0, header.payloadLength);
  const receivedChecksum = (raw[header.payloadLength] << 8) | raw[header.payloadLength + 1];
  const expectedChecksum = crc16(
    Uint8Array.from([...header.header, ...payload]),
  );
  if (receivedChecksum !== expectedChecksum) {
    return { ok: false, reason: "checksum did not match" };
  }

  return {
    ok: true,
    payload,
    text: textDecoder.decode(payload),
    checksum: receivedChecksum,
  };
}

export function decodePacketSymbols(symbols) {
  if (symbols.length < SYNC_SYMBOLS.length + CODEWORD_SYMBOLS) {
    return { ok: false, reason: "frame is too short" };
  }
  const withoutSync = symbols.slice(SYNC_SYMBOLS.length);
  const header = decodeHeaderSymbols(withoutSync.slice(0, CODEWORD_SYMBOLS));
  if (!header) return { ok: false, reason: "head was unreadable" };
  const body = decodeBodySymbols(withoutSync.slice(CODEWORD_SYMBOLS), header);
  if (!body.ok) return { ok: false, reason: body.reason, header };
  return { ok: true, header, ...body };
}

export const PROTOCOL = Object.freeze({
  name: "Lilt",
  version: VERSION,
  toneFreqs: TONE_FREQS,
  symbolMs: SYMBOL_MS,
  callMs: CALL_MS,
  callGapMs: CALL_GAP_MS,
  dataRateBps: (4 * BLOCK_DATA_SYMBOLS * 1000) / (CODEWORD_SYMBOLS * SYMBOL_MS),
  maxPayloadBytes: MAX_PAYLOAD_BYTES,
});
