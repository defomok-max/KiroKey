/**
 * Token refresh against AWS SSO OIDC and Kiro Cognito.
 *
 * Two refresh flows, matching how Kiro IDE itself works:
 *
 *   1. AWS SSO OIDC (Builder ID / IDC) — requires {clientId, clientSecret}
 *      POST https://oidc.<region>.amazonaws.com/token
 *      body: { clientId, clientSecret, refreshToken, grantType: "refresh_token" }
 *
 *   2. Social (Google/GitHub via AWS Cognito) — no clientId/clientSecret
 *      POST https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken
 *      body: { refreshToken }
 *
 * The response contains a fresh accessToken (Bearer for CodeWhisperer), a
 * possibly-rotated refreshToken, and expiresIn (seconds).
 */

import { log } from "../logger.js";
import type { KiroAccount, RefreshResult } from "./types.js";

const SOCIAL_REFRESH_URL = "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken";
const REFRESH_TIMEOUT_MS = 30_000;

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), REFRESH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

function expiresInSeconds(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 3600;
  return Math.min(Math.floor(value), 24 * 60 * 60);
}

export async function refreshAccount(account: KiroAccount): Promise<RefreshResult> {
  if (!account.refreshToken) {
    throw new Error("no refresh token");
  }

  // AWS SSO OIDC path (Builder ID / IDC).
  if (account.clientId && account.clientSecret) {
    const region = account.region || "us-east-1";
    const url = `https://oidc.${region}.amazonaws.com/token`;
    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        clientId: account.clientId,
        clientSecret: account.clientSecret,
        refreshToken: account.refreshToken,
        grantType: "refresh_token",
        ...(account.authMethod === "idc" ? { scope: ["openid"] } : {}),
      }),
    });
    if (!res.ok) {
      const body = await safeText(res);
      throw classifyRefreshError(res.status, body);
    }
    const data = (await res.json()) as Record<string, unknown>;
    return {
      accessToken: must(data.accessToken, "accessToken"),
      refreshToken:
        typeof data.refreshToken === "string" && data.refreshToken
          ? data.refreshToken
          : account.refreshToken,
      expiresIn: expiresInSeconds(data.expiresIn),
    };
  }

  // Social/Cognito path.
  const res = await fetchWithTimeout(SOCIAL_REFRESH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ refreshToken: account.refreshToken }),
  });
  if (!res.ok) {
    const body = await safeText(res);
    throw classifyRefreshError(res.status, body);
  }
  const data = (await res.json()) as Record<string, unknown>;
  return {
    accessToken: must(data.accessToken, "accessToken"),
    refreshToken:
      typeof data.refreshToken === "string" && data.refreshToken
        ? data.refreshToken
        : account.refreshToken,
    expiresIn: expiresInSeconds(data.expiresIn),
    profileArn: typeof data.profileArn === "string" ? data.profileArn : undefined,
  };
}

function must(v: unknown, name: string): string {
  if (typeof v === "string" && v) return v;
  throw new Error(`refresh: response missing ${name}`);
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return `<unreadable body, status=${res.status}>`;
  }
}

/** Error class with a `terminal` flag so callers can stop retrying. */
export class RefreshError extends Error {
  terminal: boolean;
  status: number;
  body: string;

  constructor(message: string, opts: { terminal: boolean; status: number; body: string }) {
    super(message);
    this.terminal = opts.terminal;
    this.status = opts.status;
    this.body = opts.body;
  }
}

function classifyRefreshError(status: number, body: string): RefreshError {
  // AWS returns `InvalidGrantException` when the refresh token is dead.
  // Cognito returns 400 with `invalid_grant`.
  const terminal =
    /InvalidGrantException|invalid_grant|expired refresh token|invalid_request/i.test(body) ||
    status === 400 ||
    status === 401 ||
    status === 403;
  log.debug("refresh: error response", { status, body: body.slice(0, 400) });
  return new RefreshError(`refresh failed: status=${status}`, {
    terminal,
    status,
    body: body.slice(0, 1000),
  });
}

/** Compute when we should pre-emptively refresh this account. */
export function refreshAt(account: KiroAccount, leadSeconds: number): number {
  if (!account.expiresAt) return 0;
  return account.expiresAt - leadSeconds * 1000;
}

/** True when access token is about to expire (or already has). */
export function isExpiring(account: KiroAccount, leadSeconds: number, now = Date.now()): boolean {
  if (!account.accessToken) return true;
  if (!account.expiresAt) return true;
  return account.expiresAt - now <= leadSeconds * 1000;
}
