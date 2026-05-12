/**
 * High-level dispatch: takes an OpenAI Chat Completions request, picks a
 * Kiro account, sends it to CodeWhisperer, and returns a Readable that
 * yields OpenAI SSE chunks (or a JSON object for non-streaming).
 *
 * Failover policy:
 *   1. Pick account via AccountManager strategy.
 *   2. Refresh token if expiring; on terminal refresh error, mark account
 *      terminal and pick another.
 *   3. Send request.
 *   4. On HTTP 401/403: refresh once, retry on the SAME account.
 *   5. On HTTP 429: extract Retry-After (or default 30s) → cool this account
 *      for that long → retry on the NEXT account.
 *   6. On HTTP 5xx: short cool-down (10s) → retry on the next account.
 *   7. Up to `maxAttempts` (default = #accounts, capped at 5).
 *
 * The function only "commits" the response stream after we have a 2xx
 * upstream — that way we never half-stream errors back to the client.
 */

import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

import { log } from "../logger.js";
import type { AccountManager } from "./accountManager.js";
import { postKiro, readAsText, type KiroResponse } from "./client.js";
import { buildKiroPayload, type OpenAIChatRequest } from "./request.js";
import {
  collectKiroAsOpenAIJson,
  iterateKiroAsOpenAISSE,
  streamKiroAsOpenAISSE,
} from "./response.js";
import type { KiroAccount } from "./types.js";

export interface DispatchResult {
  /** Account used for the successful request. */
  account: KiroAccount;
  /** Streaming variant: SSE chunks. */
  sse?: Readable;
  /** Non-streaming variant: parsed JSON. */
  json?: Awaited<ReturnType<typeof collectKiroAsOpenAIJson>>;
}

export interface DispatchError {
  status: number;
  body: string;
  account?: KiroAccount;
}

export class DispatchFailure extends Error {
  status: number;
  body: string;
  attempts: Array<{ accountId: string; status: number; reason: string }>;

  constructor(message: string, attempts: DispatchFailure["attempts"], status = 502, body = "") {
    super(message);
    this.status = status;
    this.body = body;
    this.attempts = attempts;
  }
}

/** Best-effort Retry-After header parser. Returns seconds. */
function parseRetryAfter(headers: Record<string, string>): number | null {
  const ra = headers["retry-after"];
  if (!ra) return null;
  const n = Number.parseInt(ra, 10);
  if (Number.isFinite(n) && n >= 0) return n;
  const date = Date.parse(ra);
  if (Number.isFinite(date)) {
    return Math.max(0, Math.ceil((date - Date.now()) / 1000));
  }
  return null;
}

export interface DispatchOptions {
  request: OpenAIChatRequest;
  manager: AccountManager;
  /** Forwarded so client cancellations terminate the upstream socket. */
  signal?: AbortSignal;
  /** Max accounts to try before giving up. Default = candidates.length, capped. */
  maxAttempts?: number;
}

interface DispatchDefaults {
  /** Hard cap on attempts per request. Defaults to 5; overridable via env. */
  maxAttempts: number;
}

const dispatchDefaults: DispatchDefaults = { maxAttempts: 5 };

/** Configure dispatch-level defaults (called from server.ts during startup). */
export function setDispatchDefaults(partial: Partial<DispatchDefaults>): void {
  if (typeof partial.maxAttempts === "number" && partial.maxAttempts >= 1) {
    dispatchDefaults.maxAttempts = Math.min(partial.maxAttempts, 50);
  }
}

export async function dispatchChat(opts: DispatchOptions): Promise<DispatchResult> {
  const { manager, request, signal } = opts;
  const stream = request.stream !== false; /* default to streaming */
  const wantStream = stream;
  const attempts: DispatchFailure["attempts"] = [];
  const excludeIds = new Set<string>();
  const fallbackCap = dispatchDefaults.maxAttempts;
  const maxAttempts = Math.min(
    opts.maxAttempts ?? Math.max(1, manager.list().length),
    fallbackCap
  );

  if (manager.list().length === 0) {
    throw new DispatchFailure(
      "No Kiro accounts configured. Login to Kiro IDE (it will write ~/.aws/sso/cache/kiro-auth-token.json) or set KIRO_REFRESH_TOKEN in the environment.",
      [],
      503
    );
  }

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const account = manager.pick(excludeIds);
    if (!account) break;

    let accessToken: string;
    try {
      accessToken = await manager.ensureToken(account);
    } catch (err) {
      const e = err as Error;
      attempts.push({ accountId: account.id, status: 0, reason: `refresh failed: ${e.message}` });
      excludeIds.add(account.id);
      continue;
    }

    manager.noteRequest(account.id);
    const payload = buildKiroPayload(request, {
      model: request.model,
      profileArn: account.profileArn,
    });

    let response: KiroResponse;
    try {
      response = await postKiro({ accessToken, payload, signal });
    } catch (err) {
      const e = err as Error;
      log.warn("dispatch: transport error", { id: account.id, err: e.message });
      attempts.push({ accountId: account.id, status: 0, reason: `transport: ${e.message}` });
      manager.cool(account.id, 5, `transport: ${e.message}`);
      excludeIds.add(account.id);
      continue;
    }

    if (response.status === 401 || response.status === 403) {
      // Token might be stale even though we thought it was fresh — refresh once
      // and retry on the same account.
      try {
        await manager.refreshOne(account);
        accessToken = account.accessToken || accessToken;
        const retry = await postKiro({ accessToken, payload, signal });
        if (retry.status >= 200 && retry.status < 300) {
          return finalizeSuccess(retry, account, wantStream, request.model, manager);
        }
        const body = await readAsText(retry.body);
        attempts.push({
          accountId: account.id,
          status: retry.status,
          reason: `auth-retry failed: ${body.slice(0, 200)}`,
        });
        if (retry.status === 401 || retry.status === 403) {
          excludeIds.add(account.id);
          continue;
        }
        if (retry.status === 429) {
          const ra = parseRetryAfter(retry.headers) ?? 30;
          manager.cool(account.id, ra, "429");
          excludeIds.add(account.id);
          continue;
        }
        if (retry.status >= 500) {
          manager.cool(account.id, 10, `5xx: ${retry.status}`);
          excludeIds.add(account.id);
          continue;
        }
        // 4xx (other than 401/403/429) → don't retry on other accounts.
        throw new DispatchFailure(
          `kiro upstream error ${retry.status}`,
          attempts,
          retry.status,
          body
        );
      } catch (err) {
        if (err instanceof DispatchFailure) throw err;
        const e = err as Error;
        attempts.push({ accountId: account.id, status: 0, reason: `auth-retry: ${e.message}` });
        excludeIds.add(account.id);
        continue;
      }
    }

    if (response.status === 429) {
      const ra = parseRetryAfter(response.headers) ?? 30;
      const body = await readAsText(response.body);
      log.warn("dispatch: rate-limited", { id: account.id, retryAfter: ra });
      attempts.push({ accountId: account.id, status: 429, reason: body.slice(0, 200) });
      manager.cool(account.id, ra, "429");
      excludeIds.add(account.id);
      continue;
    }

    if (response.status >= 500) {
      const body = await readAsText(response.body);
      log.warn("dispatch: 5xx upstream", { id: account.id, status: response.status });
      attempts.push({ accountId: account.id, status: response.status, reason: body.slice(0, 200) });
      manager.cool(account.id, 10, `5xx: ${response.status}`);
      excludeIds.add(account.id);
      // brief jitter before next account
      await delay(150 + Math.floor(Math.random() * 250));
      continue;
    }

    if (response.status >= 200 && response.status < 300) {
      return finalizeSuccess(response, account, wantStream, request.model, manager);
    }

    // 4xx other than 401/403/429 → surface to client.
    const body = await readAsText(response.body);
    throw new DispatchFailure(
      `kiro upstream error ${response.status}`,
      [...attempts, { accountId: account.id, status: response.status, reason: body.slice(0, 200) }],
      response.status,
      body
    );
  }

  if (attempts.length === 0) {
    throw new DispatchFailure(
      "No usable Kiro accounts (all are cooling, disabled, or terminal). Check /admin/accounts for details, then re-login in Kiro IDE or POST /admin/accounts/:id/reset to clear state.",
      attempts,
      503
    );
  }
  throw new DispatchFailure(
    `all ${attempts.length} kiro account attempt(s) failed`,
    attempts,
    502
  );
}

async function finalizeSuccess(
  response: KiroResponse,
  account: KiroAccount,
  wantStream: boolean,
  model: string,
  manager: AccountManager
): Promise<DispatchResult> {
  if (wantStream) {
    // Wrap the SSE iterator so we can mark success on completion.
    const iter = iterateKiroAsOpenAISSE(response.body, model);
    const sse = Readable.from(
      (async function* () {
        try {
          for await (const ch of iter) yield ch;
          manager.noteSuccess(account.id);
        } catch (err) {
          log.error("finalize: stream error", { err: (err as Error).message });
        }
      })()
    );
    return { account, sse };
  }
  const json = await collectKiroAsOpenAIJson(response.body, model);
  manager.noteSuccess(account.id);
  return { account, json };
}

export { streamKiroAsOpenAISSE };
