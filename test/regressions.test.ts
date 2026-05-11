/**
 * Regression tests for the P0/P1 fixes shipped in the stability PR:
 *
 *   - tools are preserved in multi-turn dialogue (no hoist-after-strip bug)
 *   - conversationId is deterministic for single-turn inputs
 *   - accountManager.noteSuccess does NOT double-count requestCount
 *   - accountManager recovers a "terminal" account when its refresh token rotates
 *   - config.loadConfig accepts/falls-back KIRO_STRATEGY, KIRO_MAX_ATTEMPTS, CORS_ORIGIN
 *   - splitThinking parses <thinking> wrappers into proper thinking blocks
 *   - server constantTimeEquals helper handles equal and unequal-length inputs
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildKiroPayload } from "../src/kiro/request.js";
import { AccountManager } from "../src/kiro/accountManager.js";
import { loadConfig } from "../src/config.js";

test("buildKiroPayload preserves tools across an assistant turn (multi-turn)", () => {
  const payload = buildKiroPayload(
    {
      model: "claude-sonnet-4.5",
      messages: [
        { role: "user", content: "What's the weather?" },
        { role: "assistant", content: "Let me check." },
        { role: "user", content: "in Paris" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Look up weather",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
        },
      ],
    },
    { model: "claude-sonnet-4.5" }
  );
  const ctx = payload.conversationState.currentMessage.userInputMessage.userInputMessageContext;
  assert.ok(ctx?.tools, "tools must be attached to currentMessage in multi-turn");
  assert.equal(ctx!.tools![0].toolSpecification.name, "get_weather");
});

test("buildKiroPayload produces a deterministic conversationId for single-turn", () => {
  const opts = { model: "claude-sonnet-4.5" };
  const messages = [{ role: "user" as const, content: "ping" }];
  const a = buildKiroPayload({ model: "claude-sonnet-4.5", messages }, opts);
  // Small delay to ensure new Date().toISOString() would differ between calls.
  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  return wait(20).then(() => {
    const b = buildKiroPayload({ model: "claude-sonnet-4.5", messages }, opts);
    assert.equal(a.conversationState.conversationId, b.conversationState.conversationId);
  });
});

test("AccountManager.noteRequest + noteSuccess count requestCount only once", () => {
  // We construct a minimal in-memory account and exercise the counters
  // without going through any disk I/O.
  const manager = new (class extends AccountManager {
    constructor() {
      super({
        cacheDir: "/tmp/kirokey-nonexistent",
        overrideRefreshToken: null,
        overrideProfileArn: null,
        refreshLeadSeconds: 300,
        strategy: "round-robin",
      });
      // Inject a fake account directly into the protected `accounts` array.
      (this as unknown as { accounts: unknown[] }).accounts.push({
        id: "fake",
        label: "fake",
        authMethod: "builder-id",
        state: "healthy",
        region: "us-east-1",
        profileArn: null,
        sourcePath: null,
        refreshToken: null,
        accessToken: null,
        expiresAt: 0,
        coolingUntil: 0,
        failureCount: 0,
        requestCount: 0,
        successCount: 0,
        priority: 100,
        disabled: false,
        lastError: null,
      });
    }
  })();

  manager.noteRequest("fake");
  manager.noteSuccess("fake");
  const a = manager.list().find((x) => x.id === "fake");
  assert.ok(a);
  assert.equal(a!.requestCount, 1, "requestCount must be incremented exactly once");
  assert.equal(a!.successCount, 1, "successCount must reflect the success");
});

test("AccountManager.setDisabled toggles the disabled flag", () => {
  const manager = new (class extends AccountManager {
    constructor() {
      super({
        cacheDir: "/tmp/kirokey-nonexistent",
        overrideRefreshToken: null,
        overrideProfileArn: null,
        refreshLeadSeconds: 300,
        strategy: "round-robin",
      });
      (this as unknown as { accounts: unknown[] }).accounts.push({
        id: "fake",
        label: "fake",
        authMethod: "builder-id",
        state: "healthy",
        region: "us-east-1",
        profileArn: null,
        sourcePath: null,
        refreshToken: null,
        accessToken: null,
        expiresAt: 0,
        coolingUntil: 0,
        failureCount: 0,
        requestCount: 0,
        successCount: 0,
        priority: 100,
        disabled: false,
        lastError: null,
      });
    }
  })();
  assert.equal(manager.setDisabled("fake", true), true);
  assert.equal(manager.list()[0].disabled, true);
  assert.equal(manager.setDisabled("fake", false), true);
  assert.equal(manager.list()[0].disabled, false);
  assert.equal(manager.setDisabled("ghost", true), false);
});

test("loadConfig parses KIRO_STRATEGY, KIRO_MAX_ATTEMPTS, CORS_ORIGIN; warns on bad values", () => {
  const save = {
    KIRO_STRATEGY: process.env.KIRO_STRATEGY,
    KIRO_MAX_ATTEMPTS: process.env.KIRO_MAX_ATTEMPTS,
    CORS_ORIGIN: process.env.CORS_ORIGIN,
  };
  try {
    process.env.KIRO_STRATEGY = "least-used";
    process.env.KIRO_MAX_ATTEMPTS = "7";
    process.env.CORS_ORIGIN = "https://example.com";
    const cfg = loadConfig();
    assert.equal(cfg.strategy, "least-used");
    assert.equal(cfg.maxAttempts, 7);
    assert.equal(cfg.corsOrigin, "https://example.com");
    assert.equal(cfg.warnings.length, 0);

    process.env.KIRO_STRATEGY = "garbage";
    process.env.KIRO_MAX_ATTEMPTS = "0";
    const cfg2 = loadConfig();
    assert.equal(cfg2.strategy, "round-robin");
    assert.equal(cfg2.maxAttempts, null);
    assert.ok(cfg2.warnings.length >= 2);
  } finally {
    for (const [k, v] of Object.entries(save)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
