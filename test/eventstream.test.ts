import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ByteQueue,
  buildFrame,
  crc32,
  drainFrames,
  parseEventFrame,
} from "../src/kiro/eventstream.js";

const enc = new TextEncoder();

test("crc32 matches known value for empty input", () => {
  assert.equal(crc32(new Uint8Array()), 0);
});

test("crc32 matches the well-known '123456789' check value", () => {
  // CRC-32/ISO-HDLC of "123456789" is 0xCBF43926.
  assert.equal(crc32(enc.encode("123456789")), 0xcbf43926);
});

test("parseEventFrame round-trips a simple string-headers frame", () => {
  const payload = enc.encode(JSON.stringify({ content: "hello world" }));
  const frame = buildFrame(
    { ":event-type": "assistantResponseEvent", ":content-type": "application/json" },
    payload
  );
  const parsed = parseEventFrame(frame);
  assert.ok(parsed, "parsed frame must be non-null");
  assert.equal(parsed!.headers[":event-type"], "assistantResponseEvent");
  assert.equal(parsed!.headers[":content-type"], "application/json");
  assert.deepEqual(parsed!.payload, { content: "hello world" });
});

test("parseEventFrame returns null when prelude CRC is corrupted", () => {
  const payload = enc.encode("{}");
  const frame = buildFrame({ ":event-type": "x" }, payload);
  // Corrupt the prelude CRC (bytes 8..12).
  frame[8] ^= 0xff;
  const parsed = parseEventFrame(frame);
  assert.equal(parsed, null);
});

test("parseEventFrame returns null when message CRC is corrupted", () => {
  const payload = enc.encode("{}");
  const frame = buildFrame({ ":event-type": "x" }, payload);
  frame[frame.length - 1] ^= 0xff;
  const parsed = parseEventFrame(frame);
  assert.equal(parsed, null);
});

test("drainFrames yields multiple frames from a single buffer", () => {
  const f1 = buildFrame(
    { ":event-type": "assistantResponseEvent" },
    enc.encode(JSON.stringify({ content: "alpha" }))
  );
  const f2 = buildFrame(
    { ":event-type": "assistantResponseEvent" },
    enc.encode(JSON.stringify({ content: "beta" }))
  );
  const queue = new ByteQueue();
  // Push both in a single chunk.
  const combined = new Uint8Array(f1.length + f2.length);
  combined.set(f1, 0);
  combined.set(f2, f1.length);
  queue.push(combined);
  const frames = drainFrames(queue);
  assert.equal(frames.length, 2);
  assert.deepEqual(frames[0].payload, { content: "alpha" });
  assert.deepEqual(frames[1].payload, { content: "beta" });
  assert.equal(queue.length, 0);
});

test("drainFrames handles frame split across many chunks", () => {
  const payload = enc.encode(JSON.stringify({ content: "split-test-content" }));
  const frame = buildFrame({ ":event-type": "assistantResponseEvent" }, payload);
  const queue = new ByteQueue();
  // Push the frame one byte at a time.
  for (let i = 0; i < frame.length; i++) {
    queue.push(frame.subarray(i, i + 1));
    // Only emit when fully assembled.
    if (i < frame.length - 1) {
      const peeked = drainFrames(queue);
      assert.equal(peeked.length, 0, `should not parse partial frame at byte ${i}`);
    }
  }
  const frames = drainFrames(queue);
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0].payload, { content: "split-test-content" });
});

test("drainFrames skips a corrupted frame and continues with the next", () => {
  const good = buildFrame(
    { ":event-type": "assistantResponseEvent" },
    enc.encode(JSON.stringify({ content: "ok" }))
  );
  const bad = buildFrame(
    { ":event-type": "x" },
    enc.encode(JSON.stringify({ content: "nope" }))
  );
  bad[bad.length - 1] ^= 0xff; // break message CRC
  const queue = new ByteQueue();
  const combined = new Uint8Array(bad.length + good.length);
  combined.set(bad, 0);
  combined.set(good, bad.length);
  queue.push(combined);
  let badCount = 0;
  const frames = drainFrames(queue, () => badCount++);
  assert.equal(frames.length, 1);
  assert.equal(badCount, 1);
  assert.deepEqual(frames[0].payload, { content: "ok" });
});

test("drainFrames resynchronizes after invalid frame length", () => {
  const good = buildFrame(
    { ":event-type": "assistantResponseEvent" },
    enc.encode(JSON.stringify({ content: "recovered" }))
  );
  const queue = new ByteQueue();
  const combined = new Uint8Array(1 + good.length);
  combined[0] = 0xff;
  combined.set(good, 1);
  queue.push(combined);
  let badCount = 0;
  const frames = drainFrames(queue, () => badCount++);
  assert.equal(frames.length, 1);
  assert.equal(badCount, 1);
  assert.deepEqual(frames[0].payload, { content: "recovered" });
});
