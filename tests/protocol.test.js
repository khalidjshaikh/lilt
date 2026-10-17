import assert from "node:assert/strict";
import test from "node:test";

import {
  CODEWORD_SYMBOLS,
  MAX_PAYLOAD_BYTES,
  SYNC_SYMBOLS,
  buildPacket,
  crc8,
  crc16,
  decodePacketSymbols,
  deinterleave,
  parseHeader,
  rsDecode,
  rsEncode,
  rsSyndromes,
} from "../src/protocol.js";

test("CRC-8 and CRC-16 match their standard check values", () => {
  const check = new TextEncoder().encode("123456789");
  assert.equal(crc8(check), 0xf4);
  assert.equal(crc16(check), 0x29b1);
});

test("RS(15, 11) produces a zero-syndrome codeword", () => {
  const data = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  const codeword = rsEncode(data);
  assert.equal(codeword.length, CODEWORD_SYMBOLS);
  assert.deepEqual(Array.from(rsSyndromes(codeword)), [0, 0, 0, 0]);
});

test("RS(15, 11) repairs every single-symbol error", () => {
  const data = Uint8Array.from([15, 0, 7, 8, 9, 1, 2, 3, 4, 5, 6]);
  const codeword = rsEncode(data);
  for (let position = 0; position < codeword.length; position += 1) {
    const damaged = Uint8Array.from(codeword);
    damaged[position] ^= (position % 14) + 1;
    assert.deepEqual(rsDecode(damaged), codeword, `position ${position}`);
  }
});

test("RS(15, 11) repairs every pair of symbol errors", () => {
  const data = Uint8Array.from([15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5]);
  const codeword = rsEncode(data);
  for (let first = 0; first < codeword.length; first += 1) {
    for (let second = first + 1; second < codeword.length; second += 1) {
      const damaged = Uint8Array.from(codeword);
      damaged[first] ^= (first % 15) + 1;
      damaged[second] ^= ((second + 4) % 15) + 1;
      assert.deepEqual(
        rsDecode(damaged),
        codeword,
        `positions ${first} and ${second}`,
      );
    }
  }
});

test("a packet round-trips through its symbols", () => {
  const packets = [
    "hello, world",
    "Meet me by the window at seven.",
    "A little unicode: café · 東京 · 🛰️",
    "line one\nline two\nline three",
    " ".repeat(10),
  ];
  for (const text of packets) {
    const packet = buildPacket(text, { messageId: 77 });
    const decoded = decodePacketSymbols([
      ...SYNC_SYMBOLS,
      ...packet.symbols,
    ]);
    assert.equal(decoded.ok, true, decoded.reason);
    assert.equal(decoded.text, text);
    assert.equal(decoded.header.messageId, 77);
    assert.equal(decoded.payload.length, new TextEncoder().encode(text).length);
  }
});

test("the header survives the two errors it is designed to repair", () => {
  const text = "the head is still readable";
  const packet = buildPacket(text, { messageId: 12 });
  const damaged = [...packet.symbols];
  damaged[0] ^= 1;
  damaged[10] ^= 9;
  const decoded = decodePacketSymbols([...SYNC_SYMBOLS, ...damaged]);
  assert.equal(decoded.ok, true, decoded.reason);
  assert.equal(decoded.text, text);
});

test("body interleaving spreads a burst across separate codewords", () => {
  const text = "one two three four five six seven eight nine ten eleven twelve";
  const packet = buildPacket(text, { messageId: 4 });
  const blocks = [...packet.blocks.map((block) => [...block])];
  const interleaved = [...packet.bodySymbols];
  // Break three consecutive transmitted syllables. They belong to three
  // different blocks, so each block only sees one error.
  interleaved[5] ^= 3;
  interleaved[6] ^= 5;
  interleaved[7] ^= 7;
  const back = deinterleave(interleaved, blocks.length);
  for (let i = 0; i < blocks.length; i += 1) {
    const repaired = rsDecode(back[i]);
    assert.deepEqual(repaired, Uint8Array.from(blocks[i]), `block ${i}`);
  }
});

test("a valid codeword carrying the wrong payload is refused by the CRC", () => {
  const first = buildPacket("do not trust a broken seal", { messageId: 5 });
  const second = buildPacket("this body is valid but wrong", { messageId: 5 });
  const blocks = deinterleave(first.bodySymbols, first.blocks.length);
  blocks[0] = second.blocks[0];
  const interleaved = [];
  for (let position = 0; position < CODEWORD_SYMBOLS; position += 1) {
    for (const block of blocks) interleaved.push(block[position]);
  }
  const decoded = decodePacketSymbols([
    ...SYNC_SYMBOLS,
    ...first.headerSymbols,
    ...interleaved,
  ]);
  assert.equal(decoded.ok, false);
  assert.match(decoded.reason, /checksum/);
});

test("header validation rejects a smashed head", () => {
  const packet = buildPacket("a tiny note", { messageId: 1 });
  const damaged = packet.header.map((byte) => byte ^ 0xff);
  assert.equal(parseHeader(damaged), null);
});

test("payload limit is enforced", () => {
  const text = "x".repeat(MAX_PAYLOAD_BYTES + 1);
  assert.throws(() => buildPacket(text));
  const full = buildPacket("x".repeat(MAX_PAYLOAD_BYTES));
  assert.equal(full.payload.length, MAX_PAYLOAD_BYTES);
  assert.equal(full.bodySymbols.length % CODEWORD_SYMBOLS, 0);
});
