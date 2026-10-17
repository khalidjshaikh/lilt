import assert from "node:assert/strict";
import test from "node:test";

import { runAcousticLoopback } from "../scripts/acoustic-loopback.js";

const enabled = process.env.LILT_ACOUSTIC === "1";

test(
  "a real speaker and microphone carry a packet through the room",
  {
    skip: enabled
      ? false
      : "hardware test; run `npm run test:acoustic` on macOS",
    timeout: 120_000,
  },
  async () => {
    const text = process.env.LILT_ACOUSTIC_TEXT ?? "hello from the room";
    const result = await runAcousticLoopback({
      text,
      messageId: 42,
      quiet: true,
      systemVolume: process.env.LILT_SYSTEM_VOLUME
        ? Number(process.env.LILT_SYSTEM_VOLUME)
        : undefined,
    });

    assert.equal(result.ok, true);
    assert.equal(result.received, text);
    assert.equal(result.messageId, 42);
    assert.ok(result.confidence > 0.5, `confidence ${result.confidence}`);
  },
);
