/**
 * Read-only / control admin endpoints:
 *   GET  /health                         — basic liveness + account summary
 *   GET  /admin/accounts                 — full account state (excluding tokens)
 *   GET  /admin/stats                    — aggregate counters across accounts
 *   POST /admin/refresh                  — trigger an immediate refresh sweep
 *   POST /admin/reload                   — rescan ~/.aws/sso/cache + manifest
 *   POST /admin/accounts/:id/reset       — clear cooldown / failure state
 *   POST /admin/accounts/:id/disable     — mark account disabled
 *   POST /admin/accounts/:id/enable      — re-enable a disabled account
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import type { AccountManager } from "../kiro/accountManager.js";
import { sendJson, sendError } from "../http/util.js";

function redact(token: string | null): string | null {
  // Show only last 4 characters — enough to identify in logs without giving
  // useful entropy. Returns *** + 4 chars (e.g. "***aBcD").
  if (!token) return null;
  if (token.length < 8) return "******";
  return `***${token.slice(-4)}`;
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

/**
 * Aggregate stats across all accounts. Useful for dashboards / scraping.
 */
export function handleStats(_req: IncomingMessage, res: ServerResponse, manager: AccountManager): void {
  const list = manager.list();
  const now = Date.now();
  const totalRequests = list.reduce((s, a) => s + a.requestCount, 0);
  const totalSuccess = list.reduce((s, a) => s + a.successCount, 0);
  const totalFailures = list.reduce((s, a) => s + a.failureCount, 0);
  const healthy = list.filter((a) => !a.disabled && a.state === "healthy" && a.coolingUntil <= now).length;
  const cooling = list.filter((a) => a.coolingUntil > now).length;
  const terminal = list.filter((a) => a.state === "terminal").length;
  const disabled = list.filter((a) => a.disabled).length;
  sendJson(res, 200, {
    status: healthy > 0 ? "ok" : "degraded",
    strategy: manager.strategy,
    accounts: {
      total: list.length,
      healthy,
      cooling,
      terminal,
      disabled,
    },
    requests: {
      total: totalRequests,
      success: totalSuccess,
      failures: totalFailures,
      successRate: totalRequests > 0 ? totalSuccess / totalRequests : null,
    },
    per_account: list.map((a) => ({
      id: a.id,
      state: a.state,
      requestCount: a.requestCount,
      successCount: a.successCount,
      failureCount: a.failureCount,
      disabled: a.disabled,
    })),
    now: new Date(now).toISOString(),
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

export function handleDisable(
  _req: IncomingMessage,
  res: ServerResponse,
  manager: AccountManager,
  accountId: string
): void {
  const ok = manager.setDisabled(accountId, true);
  if (!ok) return sendError(res, 404, "not_found", `unknown account: ${accountId}`);
  handleAccounts(_req, res, manager);
}

export function handleEnable(
  _req: IncomingMessage,
  res: ServerResponse,
  manager: AccountManager,
  accountId: string
): void {
  const ok = manager.setDisabled(accountId, false);
  if (!ok) return sendError(res, 404, "not_found", `unknown account: ${accountId}`);
  handleAccounts(_req, res, manager);
}
