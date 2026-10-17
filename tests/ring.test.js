import assert from "node:assert/strict";
import test from "node:test";

import { SampleRing } from "../src/audio.js";

test("the sample ring preserves order across its wrap point", () => {
  const ring = new SampleRing(1, 4);
  ring.append(Float32Array.from([1, 2, 3]));
  assert.deepEqual(Array.from(ring.slice(0, 3)), [1, 2, 3]);
  ring.append(Float32Array.from([4, 5, 6]));
  assert.equal(ring.total, 6);
  assert.equal(ring.start, 2);
  assert.deepEqual(Array.from(ring.slice(2, 6)), [3, 4, 5, 6]);
  assert.deepEqual(Array.from(ring.slice(0, 6)), [3, 4, 5, 6]);
});

test("the sample ring clips a request that is older than its capacity", () => {
  const ring = new SampleRing(1, 8);
  ring.append(Float32Array.from([1, 2, 3, 4, 5]));
  ring.append(Float32Array.from([6, 7, 8, 9]));
  assert.equal(ring.start, 1);
  assert.deepEqual(Array.from(ring.slice(0, 9)), [2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(Array.from(ring.slice(6, 99)), [7, 8, 9]);
});

test("resetting the ring makes the next append start cleanly", () => {
  const ring = new SampleRing(1, 4);
  ring.append(Float32Array.from([1, 2, 3]));
  ring.buffer.fill(0);
  ring.writeIndex = 0;
  ring.total = 0;
  assert.equal(ring.start, 0);
  assert.equal(ring.slice(0, 1).length, 0);
  ring.append(Float32Array.from([9]));
  assert.deepEqual(Array.from(ring.slice(0, 1)), [9]);
});
