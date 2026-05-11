/**
 * Tests for the OpenAI SSE adaptor (response.ts).
 *
 * Asserts that:
 *   - normal assistantResponseEvent frames are converted to delta chunks
 *   - upstream `exception` frames are surfaced as an inline error chunk
 *     and the stream still emits a `[DONE]` terminator (finish_reason="error")
 *   - transport errors during the upstream stream cause an error chunk + DONE
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";

import { buildFrame } from "../src/kiro/eventstream.js";
import { iterateKiroAsOpenAISSE } from "../src/kiro/response.js";

const enc = new TextEncoder();

async function collect(it: AsyncIterable<Buffer>): Promise<string> {
  const parts: Buffer[] = [];
  for await (const part of it) parts.push(part);
  return Buffer.concat(parts).toString("utf-8");
}

test("iterateKiroAsOpenAISSE forwards normal content as OpenAI delta chunks", async () => {
  const f1 = buildFrame(
    { ":event-type": "assistantResponseEvent" },
    enc.encode(JSON.stringify({ content: "Hello " }))
  );
  const f2 = buildFrame(
    { ":event-type": "assistantResponseEvent" },
    enc.encode(JSON.stringify({ content: "world" }))
  );
  const stream = Readable.from([Buffer.from(f1), Buffer.from(f2)]);
  const out = await collect(iterateKiroAsOpenAISSE(stream, "claude-sonnet-4.5"));
  assert.ok(out.includes('"content":"Hello "'), "first content delta should be present");
  assert.ok(out.includes('"content":"world"'), "second content delta should be present");
  assert.ok(out.endsWith("data: [DONE]\n\n"), "stream must terminate with [DONE]");
  assert.ok(out.includes('"finish_reason":"stop"'));
});

test("iterateKiroAsOpenAISSE surfaces exception frames as an inline error chunk", async () => {
  const ok = buildFrame(
    { ":event-type": "assistantResponseEvent" },
    enc.encode(JSON.stringify({ content: "partial" }))
  );
  const err = buildFrame(
    { ":event-type": "exception", ":message-type": "exception" },
    enc.encode(JSON.stringify({ message: "kaboom" }))
  );
  const stream = Readable.from([Buffer.from(ok), Buffer.from(err)]);
  const out = await collect(iterateKiroAsOpenAISSE(stream, "claude-sonnet-4.5"));
  assert.ok(out.includes("partial"), "partial content must still be emitted");
  assert.ok(out.includes("kiro-router: upstream error"), "error chunk must explain the failure");
  assert.ok(out.includes("kaboom"), "error message text must be forwarded");
  assert.ok(out.includes('"finish_reason":"error"'), "finish_reason must be 'error'");
  assert.ok(out.endsWith("data: [DONE]\n\n"), "[DONE] must terminate the stream");
});

test("iterateKiroAsOpenAISSE handles a transport error mid-stream", async () => {
  async function* gen(): AsyncIterable<Buffer> {
    const f = buildFrame(
      { ":event-type": "assistantResponseEvent" },
      enc.encode(JSON.stringify({ content: "partial-then-fail" }))
    );
    yield Buffer.from(f);
    throw new Error("connection reset by peer");
  }
  const stream = Readable.from(gen());
  const out = await collect(iterateKiroAsOpenAISSE(stream, "claude-sonnet-4.5"));
  assert.ok(out.includes("partial-then-fail"));
  assert.ok(out.includes("connection reset by peer"));
  assert.ok(out.includes('"finish_reason":"error"'));
  assert.ok(out.endsWith("data: [DONE]\n\n"));
});
