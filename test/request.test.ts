import { test } from "node:test";
import assert from "node:assert/strict";

import { buildKiroPayload } from "../src/kiro/request.js";
import { loadConfig } from "../src/config.js";

test("buildKiroPayload moves the last user turn to currentMessage", () => {
  const payload = buildKiroPayload(
    {
      model: "claude-sonnet-4.5",
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi!" },
        { role: "user", content: "Tell me a joke" },
      ],
    },
    { model: "claude-sonnet-4.5" }
  );
  assert.equal(payload.conversationState.chatTriggerType, "MANUAL");
  // currentMessage must be a user turn containing the last user content.
  assert.ok(
    payload.conversationState.currentMessage.userInputMessage.content.includes(
      "Tell me a joke"
    )
  );
  // History should NOT contain the last user message anymore.
  const historyJoined = JSON.stringify(payload.conversationState.history);
  assert.ok(!historyJoined.includes("Tell me a joke"));
  // Model id should be set on currentMessage.
  assert.equal(
    payload.conversationState.currentMessage.userInputMessage.modelId,
    "claude-sonnet-4.5"
  );
});

test("buildKiroPayload sets a deterministic conversationId for cache stability", () => {
  const opts = { model: "claude-sonnet-4.5" };
  const messages = [
    { role: "user" as const, content: "Same first message" },
    { role: "assistant" as const, content: "ack" },
    { role: "user" as const, content: "Then this" },
  ];
  const a = buildKiroPayload({ model: "claude-sonnet-4.5", messages }, opts);
  const b = buildKiroPayload({ model: "claude-sonnet-4.5", messages }, opts);
  assert.equal(a.conversationState.conversationId, b.conversationState.conversationId);
});

test("buildKiroPayload attaches OpenAI tools to currentMessage as Bedrock toolSpec", () => {
  const payload = buildKiroPayload(
    {
      model: "claude-sonnet-4.5",
      messages: [{ role: "user", content: "do a thing" }],
      tools: [
        {
          type: "function",
          function: {
            name: "do_thing",
            description: "Does a thing",
            parameters: { type: "object", properties: { x: { type: "string" } }, required: ["x"] },
          },
        },
      ],
    },
    { model: "claude-sonnet-4.5" }
  );
  const ctx = payload.conversationState.currentMessage.userInputMessage.userInputMessageContext;
  assert.ok(ctx?.tools);
  assert.equal(ctx!.tools![0].toolSpecification.name, "do_thing");
  assert.equal(ctx!.tools![0].toolSpecification.description, "Does a thing");
  assert.deepEqual(ctx!.tools![0].toolSpecification.inputSchema.json.required, ["x"]);
});

test("buildKiroPayload converts assistant tool_calls + user tool_result", () => {
  const payload = buildKiroPayload(
    {
      model: "claude-sonnet-4.5",
      messages: [
        { role: "user", content: "Search for cats" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "search", arguments: JSON.stringify({ q: "cats" }) },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "10 results" },
        { role: "user", content: "Tell me about the first one" },
      ],
    },
    { model: "claude-sonnet-4.5" }
  );

  // History should contain the assistant turn with toolUses. The user
  // tool-result and the new user prompt are merged into the final user turn
  // (currentMessage) — that is the format Kiro/Bedrock expects so a single
  // user turn carries both the tool result and the follow-up question.
  assert.ok(payload.conversationState.history.length >= 1);
  const asst = payload.conversationState.history.find(
    (e) => "assistantResponseMessage" in e
  ) as { assistantResponseMessage: { toolUses?: unknown[] } } | undefined;
  assert.ok(asst?.assistantResponseMessage.toolUses);
  assert.equal(
    (asst!.assistantResponseMessage.toolUses![0] as { name: string }).name,
    "search"
  );
  const toolResults =
    payload.conversationState.currentMessage.userInputMessage.userInputMessageContext
      ?.toolResults;
  assert.ok(toolResults && toolResults.length === 1);
  assert.equal((toolResults![0] as { toolUseId: string }).toolUseId, "call_1");
  assert.ok(
    payload.conversationState.currentMessage.userInputMessage.content.includes(
      "Tell me about the first one"
    )
  );
});

test("loadConfig rejects invalid port and negative refresh lead", () => {
  const oldPort = process.env.PORT;
  const oldLead = process.env.KIRO_REFRESH_LEAD_SECONDS;
  try {
    process.env.PORT = "99999";
    process.env.KIRO_REFRESH_LEAD_SECONDS = "-5";
    const cfg = loadConfig();
    assert.equal(cfg.port, 11437);
    assert.equal(cfg.refreshLeadSeconds, 300);
  } finally {
    if (oldPort === undefined) delete process.env.PORT;
    else process.env.PORT = oldPort;
    if (oldLead === undefined) delete process.env.KIRO_REFRESH_LEAD_SECONDS;
    else process.env.KIRO_REFRESH_LEAD_SECONDS = oldLead;
  }
});

test("loadConfig rejects partially numeric values", () => {
  const oldPort = process.env.PORT;
  try {
    process.env.PORT = "123abc";
    assert.equal(loadConfig().port, 11437);
  } finally {
    if (oldPort === undefined) delete process.env.PORT;
    else process.env.PORT = oldPort;
  }
});

test("loadConfig uses server defaults without reading local token cache", () => {
  const oldServerMode = process.env.KIRO_SERVER_MODE;
  const oldTokenDir = process.env.KIRO_TOKEN_DIR;
  try {
    process.env.KIRO_SERVER_MODE = "1";
    delete process.env.KIRO_TOKEN_DIR;
    assert.equal(loadConfig().kiroTokenDir, "/data/aws-sso-cache");
  } finally {
    if (oldServerMode === undefined) delete process.env.KIRO_SERVER_MODE;
    else process.env.KIRO_SERVER_MODE = oldServerMode;
    if (oldTokenDir === undefined) delete process.env.KIRO_TOKEN_DIR;
    else process.env.KIRO_TOKEN_DIR = oldTokenDir;
  }
});

test("buildKiroPayload preserves image placeholders", () => {
  const payload = buildKiroPayload(
    {
      model: "claude-sonnet-4.5",
      messages: [{ role: "user", content: [{ type: "image", source: { type: "base64" } }] }],
    },
    { model: "claude-sonnet-4.5" }
  );
  assert.match(payload.conversationState.currentMessage.userInputMessage.content, /\[image omitted\]$/);
});
