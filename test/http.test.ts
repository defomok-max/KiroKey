import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";

import { HttpRequestError, readJson } from "../src/http/util.js";

function req(body: string, headers: Record<string, string> = {}) {
  const stream = Readable.from(body ? [Buffer.from(body)] : []);
  return Object.assign(stream, {
    method: "POST",
    headers,
  }) as IncomingMessage;
}

test("readJson rejects non-json content types", async () => {
  await assert.rejects(
    readJson(req("{}", { "content-type": "text/plain" })),
    (err) =>
      err instanceof HttpRequestError &&
      err.status === 415 &&
      err.code === "unsupported_media_type"
  );
});

test("readJson reports malformed JSON as invalid_json", async () => {
  await assert.rejects(
    readJson(req("{", { "content-type": "application/json" })),
    (err) =>
      err instanceof HttpRequestError &&
      err.status === 400 &&
      err.code === "invalid_json"
  );
});

test("readJson accepts structured +json content types", async () => {
  const parsed = await readJson(
    req('{"ok":true}', { "content-type": "application/vnd.anthropic+json; charset=utf-8" })
  );
  assert.deepEqual(parsed, { ok: true });
});
