import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";

import { buildFrame } from "../src/kiro/eventstream.js";
import { collectKiroAsOpenAIJson, iterateKiroAsOpenAISSE } from "../src/kiro/response.js";
import { openAiSseToAnthropicSse } from "../src/routes/anthropic.js";

const enc = new TextEncoder();

function streamFrames(payloads: Array<{ type: string; payload: unknown }>): Readable {
  return Readable.from(
    payloads.map((p) =>
      buildFrame({ ":event-type": p.type }, enc.encode(JSON.stringify(p.payload)))
    )
  );
}

test("collectKiroAsOpenAIJson preserves reasoning and cache usage", async () => {
  const json = await collectKiroAsOpenAIJson(
    streamFrames([
      { type: "reasoningContentEvent", payload: { content: "thinking" } },
      { type: "assistantResponseEvent", payload: { content: "answer" } },
      {
        type: "metricsEvent",
        payload: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheCreationTokens: 2 },
      },
    ]),
    "claude-sonnet-4.5"
  );
  assert.equal(json.choices[0].message.content, "<thinking>thinking</thinking>answer");
  assert.deepEqual(json.usage, {
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
    cache_read_input_tokens: 3,
    cache_creation_input_tokens: 2,
  });
});

test("iterateKiroAsOpenAISSE emits assistant role for empty streams", async () => {
  const chunks: string[] = [];
  for await (const chunk of iterateKiroAsOpenAISSE(Readable.from([]), "claude-sonnet-4.5")) {
    chunks.push(chunk.toString("utf-8"));
  }
  const finish = JSON.parse(chunks[0].replace(/^data: /, ""));
  assert.deepEqual(finish.choices[0].delta, { role: "assistant" });
  assert.equal(chunks.at(-1), "data: [DONE]\n\n");
});

test("openAiSseToAnthropicSse emits message_start for empty streams", async () => {
  const out: string[] = [];
  const stream = openAiSseToAnthropicSse(
    Readable.from([Buffer.from("data: [DONE]\n\n")]),
    "claude-sonnet-4.5",
    "empty"
  );
  for await (const chunk of stream) out.push(chunk.toString("utf-8"));
  assert.ok(out[0].startsWith("event: message_start\n"));
  assert.ok(out.some((event) => event.startsWith("event: message_stop\n")));
});
