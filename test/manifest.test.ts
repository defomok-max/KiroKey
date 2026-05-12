import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { discoverFromAwsSsoCache } from "../src/kiro/manifest.js";

test("discoverFromAwsSsoCache parses numeric expiresAt seconds", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kiro-cache-"));
  try {
    await writeFile(
      join(dir, "kiro-auth-token.json"),
      JSON.stringify({
        refreshToken: "aorAAAAAG-test-token",
        expiresAt: 1_700_000_000,
        accessToken: "header.payload.sig",
      })
    );
    const accounts = await discoverFromAwsSsoCache(dir);
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].expiresAt, 1_700_000_000_000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("discoverFromAwsSsoCache derives expiresAt from expiresIn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kiro-cache-"));
  const observedAt = new Date("2025-01-01T00:00:00.000Z");
  try {
    const path = join(dir, "kiro-auth-token.json");
    await writeFile(
      path,
      JSON.stringify({
        refreshToken: "aorAAAAAG-test-token",
        expiresIn: 60,
      })
    );
    await utimes(path, observedAt, observedAt);
    const accounts = await discoverFromAwsSsoCache(dir);
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].expiresAt, observedAt.getTime() + 60_000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
