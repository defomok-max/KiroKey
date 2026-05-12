/**
 * Read-only admin endpoints:
 *   GET  /health            — basic liveness check + account summary
 *   GET  /admin/accounts    — full account state (excluding tokens)
 *   POST /admin/accounts/link — start browser-based account linking
 *   POST /admin/refresh     — trigger an immediate proactive refresh sweep
 *   POST /admin/reload      — rescan ~/.aws/sso/cache and reload manifest
 *   POST /admin/accounts/:id/reset — clear cooldown / failure state
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import type { AccountManager } from "../kiro/accountManager.js";
import { readJson, sendJson, sendError } from "../http/util.js";

function redact(token: string | null): string | null {
  if (!token) return null;
  const tail = token.length > 8 ? token.slice(-6) : "******";
  return `***${tail}`;
}

export function handleHealth(_req: IncomingMessage, res: ServerResponse, manager: AccountManager): void {
  const list = manager.list();
  const healthy = list.filter((a) => !a.disabled && a.state === "healthy" && a.coolingUntil <= Date.now());
  sendJson(res, 200, {
    status: healthy.length > 0 ? "ok" : "degraded",
    accounts: {
      total: list.length,
      healthy: healthy.length,
      cooling: list.filter((a) => a.coolingUntil > Date.now()).length,
      terminal: list.filter((a) => a.state === "terminal").length,
      disabled: list.filter((a) => a.disabled).length,
    },
    strategy: manager.strategy,
    now: new Date().toISOString(),
  });
}

export function handleAccounts(_req: IncomingMessage, res: ServerResponse, manager: AccountManager): void {
  const list = manager.list().map((a) => ({
    id: a.id,
    label: a.label,
    authMethod: a.authMethod,
    state: a.state,
    region: a.region,
    profileArn: a.profileArn,
    sourcePath: a.sourcePath,
    refreshToken: redact(a.refreshToken),
    accessToken: redact(a.accessToken),
    expiresAt: a.expiresAt ? new Date(a.expiresAt).toISOString() : null,
    expiresInSec: a.expiresAt ? Math.max(0, Math.floor((a.expiresAt - Date.now()) / 1000)) : null,
    coolingUntil: a.coolingUntil ? new Date(a.coolingUntil).toISOString() : null,
    failureCount: a.failureCount,
    requestCount: a.requestCount,
    successCount: a.successCount,
    priority: a.priority,
    disabled: a.disabled,
    lastError: a.lastError,
  }));
  sendJson(res, 200, { accounts: list });
}

export async function handleLinkAccount(
  req: IncomingMessage,
  res: ServerResponse,
  manager: AccountManager
): Promise<void> {
  const body = await readJson(req);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return sendError(res, 400, "invalid_request", "expected JSON object");
  }
  const data = body as Record<string, unknown>;
  const method = data.method;
  if (method !== "google" && method !== "github" && method !== "builder-id" && method !== "idc") {
    return sendError(res, 400, "invalid_request", "method must be google, github, builder-id, or idc");
  }
  const account = await manager.link({
    method,
    label: typeof data.label === "string" ? data.label : undefined,
    startUrl: typeof data.startUrl === "string" ? data.startUrl : undefined,
    region: typeof data.region === "string" ? data.region : undefined,
    openBrowser: typeof data.openBrowser === "boolean" ? data.openBrowser : true,
    timeoutMs: typeof data.timeoutSec === "number" ? data.timeoutSec * 1000 : undefined,
  });
  sendJson(res, 201, {
    account: {
      id: account.id,
      label: account.label,
      authMethod: account.authMethod,
      state: account.state,
      region: account.region,
      sourcePath: account.sourcePath,
      expiresAt: account.expiresAt ? new Date(account.expiresAt).toISOString() : null,
    },
  });
}

export async function handleRefresh(
  _req: IncomingMessage,
  res: ServerResponse,
  manager: AccountManager
): Promise<void> {
  await manager.proactiveRefresh();
  handleAccounts(_req, res, manager);
}

export async function handleReload(
  _req: IncomingMessage,
  res: ServerResponse,
  manager: AccountManager
): Promise<void> {
  await manager.reload();
  handleAccounts(_req, res, manager);
}

export function handleReset(
  _req: IncomingMessage,
  res: ServerResponse,
  manager: AccountManager,
  accountId: string
): void {
  const ok = manager.reset(accountId);
  if (!ok) return sendError(res, 404, "not_found", `unknown account: ${accountId}`);
  handleAccounts(_req, res, manager);
}
