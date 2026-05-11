/**
 * OpenAI-compatible routes:
 *   GET  /v1/models
 *   POST /v1/chat/completions
 *
 * These are the two endpoints that OpenCode, Kilo Code, Cline, Continue,
 * Roo Code, and most "OpenAI-compatible" agent tools talk to.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { log } from "../logger.js";
import { dispatchChat, DispatchFailure } from "../kiro/dispatch.js";
import type { AccountManager } from "../kiro/accountManager.js";
import type { OpenAIChatRequest } from "../kiro/request.js";
import { KIRO_MODELS } from "../kiro/types.js";
import { readJson, sendJson, sendSseStream, sendError } from "../http/util.js";

export async function handleModels(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  sendJson(res, 200, {
    object: "list",
    data: KIRO_MODELS.map((id) => ({
      id,
      object: "model",
      created: 1700000000,
      owned_by: "kiro",
    })),
  });
}

export async function handleChatCompletions(
  req: IncomingMessage,
  res: ServerResponse,
  manager: AccountManager
): Promise<void> {
  let body: OpenAIChatRequest;
  try {
    body = (await readJson(req)) as OpenAIChatRequest;
  } catch (err) {
    return sendError(res, 400, "invalid_request", (err as Error).message);
  }

  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return sendError(res, 400, "invalid_request", "missing messages[]");
  }
  if (typeof body.model !== "string" || !body.model) {
    return sendError(res, 400, "invalid_request", "missing model");
  }
  if (!KIRO_MODELS.includes(body.model as (typeof KIRO_MODELS)[number])) {
    log.debug("openai: unknown model id, forwarding anyway", { model: body.model });
  }

  const wantStream = body.stream !== false;

  const ac = new AbortController();
  req.on("close", () => ac.abort());

  try {
    const result = await dispatchChat({
      request: body,
      manager,
      signal: ac.signal,
    });

    if (wantStream && result.sse) {
      await sendSseStream(res, result.sse);
      return;
    }
    if (result.json) {
      sendJson(res, 200, result.json);
      return;
    }
    sendError(res, 502, "internal_error", "no response from dispatch");
  } catch (err) {
    if (err instanceof DispatchFailure) {
      log.warn("openai: dispatch failed", {
        status: err.status,
        attempts: err.attempts,
      });
      sendError(
        res,
        err.status >= 400 && err.status < 600 ? err.status : 502,
        err.status === 429 ? "rate_limited" : "upstream_error",
        err.message,
        { attempts: err.attempts, body: err.body }
      );
      return;
    }
    log.error("openai: dispatch crashed", { err: (err as Error).message });
    sendError(res, 500, "internal_error", (err as Error).message);
  }
}

// Re-export Readable type for tests
export type { Readable };
