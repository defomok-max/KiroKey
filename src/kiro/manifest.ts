/**
 * Persistent manifest of Kiro accounts at ~/.kiro-router/accounts.json.
 * Atomic writes via tmpfile + rename so Kiro IDE and kiro-router never
 * see a torn file.
 */

import { readFile, writeFile, mkdir, rename, readdir, stat, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";

import { log } from "../logger.js";
import type { KiroAccount } from "./types.js";

const MANIFEST_DIR = join(homedir(), ".kiro-router");
const MANIFEST_PATH = join(MANIFEST_DIR, "accounts.json");

interface ManifestFile {
  version: 1;
  accounts: KiroAccount[];
}

export async function ensureManifestDir(): Promise<void> {
  await mkdir(MANIFEST_DIR, { recursive: true, mode: 0o700 });
  await chmod(MANIFEST_DIR, 0o700).catch((err) =>
    log.debug("manifest: chmod failed", { path: MANIFEST_DIR, err: (err as Error).message })
  );
}

export async function loadManifest(): Promise<KiroAccount[]> {
  if (!existsSync(MANIFEST_PATH)) return [];
  try {
    const raw = await readFile(MANIFEST_PATH, "utf-8");
    const parsed = JSON.parse(raw) as ManifestFile;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.accounts)) {
      log.warn("manifest: invalid shape, ignoring", { path: MANIFEST_PATH });
      return [];
    }
    return parsed.accounts.map(normalizeAccount);
  } catch (err) {
    log.error("manifest: failed to read", {
      path: MANIFEST_PATH,
      err: (err as Error).message,
    });
    return [];
  }
}

export async function saveManifest(accounts: KiroAccount[]): Promise<void> {
  await ensureManifestDir();
  const payload: ManifestFile = { version: 1, accounts: accounts.map(sanitizeForManifest) };
  const tmp = `${MANIFEST_PATH}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
  await rename(tmp, MANIFEST_PATH);
  await chmod(MANIFEST_PATH, 0o600).catch((err) =>
    log.debug("manifest: chmod failed", { path: MANIFEST_PATH, err: (err as Error).message })
  );
}

function sanitizeForManifest(account: KiroAccount): KiroAccount {
  return {
    ...account,
    lastError:
      account.lastError
        ?.replace(/aorAAAAAG[A-Za-z0-9._-]+/g, "[redacted-refresh-token]")
        .replace(/eyJ[A-Za-z0-9._-]+/g, "[redacted-jwt]") ?? null,
  };
}

function normalizeAccount(a: Partial<KiroAccount>): KiroAccount {
  const state =
    a.state === "healthy" ||
    a.state === "refreshing" ||
    a.state === "cooling" ||
    a.state === "expired" ||
    a.state === "terminal"
      ? a.state
      : "healthy";
  return {
    id: a.id || randomUUID(),
    label: a.label || a.id || "unnamed",
    authMethod: a.authMethod || "builder-id",
    refreshToken: a.refreshToken || "",
    accessToken: a.accessToken ?? null,
    expiresAt: typeof a.expiresAt === "number" && Number.isFinite(a.expiresAt) ? Math.max(0, a.expiresAt) : 0,
    region: a.region || "us-east-1",
    clientId: a.clientId ?? null,
    clientSecret: a.clientSecret ?? null,
    profileArn: a.profileArn ?? null,
    sourcePath: a.sourcePath ?? null,
    state,
    lastError: a.lastError ?? null,
    coolingUntil: typeof a.coolingUntil === "number" && Number.isFinite(a.coolingUntil) ? Math.max(0, a.coolingUntil) : 0,
    failureCount: typeof a.failureCount === "number" && Number.isFinite(a.failureCount) ? Math.max(0, a.failureCount) : 0,
    requestCount: typeof a.requestCount === "number" && Number.isFinite(a.requestCount) ? Math.max(0, a.requestCount) : 0,
    successCount: typeof a.successCount === "number" && Number.isFinite(a.successCount) ? Math.max(0, a.successCount) : 0,
    priority: typeof a.priority === "number" && Number.isFinite(a.priority) ? a.priority : 100,
    disabled: !!a.disabled,
  };
}

/**
 * Scan a directory of AWS SSO cache JSON files and extract any that look like
 * Kiro tokens. Kiro refresh tokens start with `aorAAAAAG`. Returns one
 * KiroAccount per matching file.
 */
export async function discoverFromAwsSsoCache(cacheDir: string): Promise<KiroAccount[]> {
  if (!existsSync(cacheDir)) {
    log.debug("manifest.discover: cache dir does not exist", { cacheDir });
    return [];
  }

  const out: KiroAccount[] = [];
  let entries: string[];
  try {
    entries = await readdir(cacheDir);
  } catch (err) {
    log.warn("manifest.discover: failed to readdir", {
      cacheDir,
      err: (err as Error).message,
    });
    return [];
  }

  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const fullPath = join(cacheDir, entry);
    let observedAtMs = Date.now();
    try {
      const s = await stat(fullPath);
      if (!s.isFile()) continue;
      observedAtMs = s.mtimeMs;
    } catch {
      continue;
    }
    try {
      const raw = await readFile(fullPath, "utf-8");
      const data = JSON.parse(raw);
      const rt: unknown = data?.refreshToken;
      if (typeof rt !== "string" || !rt.startsWith("aorAAAAAG")) continue;
      const id = `aws-sso:${basename(entry, ".json")}`;
      out.push(
        normalizeAccount({
          id,
          label: extractLabel(data) || id,
          authMethod: data.clientId && data.clientSecret ? "builder-id" : "social",
          refreshToken: rt,
          accessToken: typeof data.accessToken === "string" ? data.accessToken : null,
          expiresAt: parseExpiresAt(data, observedAtMs),
          region: typeof data.region === "string" ? data.region : "us-east-1",
          clientId: typeof data.clientId === "string" ? data.clientId : null,
          clientSecret: typeof data.clientSecret === "string" ? data.clientSecret : null,
          profileArn: typeof data.profileArn === "string" ? data.profileArn : null,
          sourcePath: fullPath,
          state: "healthy",
        })
      );
    } catch (err) {
      log.debug("manifest.discover: skipping unreadable file", {
        fullPath,
        err: (err as Error).message,
      });
    }
  }

  return out;
}

function extractLabel(data: Record<string, unknown>): string | null {
  if (typeof data.startUrl === "string") return data.startUrl;
  if (typeof data.email === "string") return data.email;
  if (typeof data.accessToken === "string") {
    const email = tryExtractEmailFromJwt(data.accessToken);
    if (email) return email;
  }
  return null;
}

function tryExtractEmailFromJwt(token: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    let payload = parts[1];
    while (payload.length % 4) payload += "=";
    const decoded = JSON.parse(
      Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8")
    );
    return (
      (typeof decoded.email === "string" ? decoded.email : null) ||
      (typeof decoded.preferred_username === "string" ? decoded.preferred_username : null) ||
      null
    );
  } catch {
    return null;
  }
}

function parseExpiresAt(data: Record<string, unknown>, observedAtMs: number): number {
  if (typeof data.expiresAt === "string") {
    const parsed = Date.parse(data.expiresAt);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (typeof data.expiresAt === "number" && Number.isFinite(data.expiresAt)) {
    return data.expiresAt < 10_000_000_000 ? data.expiresAt * 1000 : data.expiresAt;
  }
  if (typeof data.expiresIn === "number" && Number.isFinite(data.expiresIn)) {
    return observedAtMs + data.expiresIn * 1000;
  }
  return 0;
}

export const MANIFEST_PATHS = { MANIFEST_DIR, MANIFEST_PATH };
