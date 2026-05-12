/**
 * kiro-router configuration loader.
 * Reads from process.env. No .env file parsing — keep deps zero.
 * Users can `source .env` or use a runner like `dotenv-cli` if desired.
 *
 * The API key (a.k.a. "password") can be supplied two ways:
 *   1. API_KEY env var — highest priority, useful for CI/Docker.
 *   2. ~/.kiro-router/password file — persisted, easy for daily use.
 *      Managed by `npm run set-password` / `./start.sh --set-password`.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MIN_PORT = 1;
const MAX_PORT = 65535;

export interface Config {
  port: number;
  host: string;
  apiKey: string | null;
  kiroTokenDir: string;
  kiroRefreshToken: string | null;
  kiroProfileArn: string | null;
  refreshLeadSeconds: number;
  logLevel: "error" | "warn" | "info" | "debug";
}

function bool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (!raw) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function num(key: string, fallback: number, opts?: { min?: number; max?: number }): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) return fallback;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed)) return fallback;
  if (opts?.min !== undefined && parsed < opts.min) return fallback;
  if (opts?.max !== undefined && parsed > opts.max) return fallback;
  return parsed;
}

function str(key: string, fallback: string): string {
  const raw = process.env[key];
  return raw && raw.trim() !== "" ? raw : fallback;
}

function strOrNull(key: string): string | null {
  const raw = process.env[key];
  return raw && raw.trim() !== "" ? raw : null;
}

/** Default location of the persistent password file. */
export const passwordFilePath = (): string => join(homedir(), ".kiro-router", "password");

/** Read the persisted password (if any) from disk. Errors are swallowed. */
function readStoredPassword(): string | null {
  try {
    const raw = readFileSync(passwordFilePath(), "utf-8").trim();
    return raw === "" ? null : raw;
  } catch {
    return null;
  }
}

export function loadConfig(): Config {
  const logLevelRaw = str("LOG_LEVEL", "info").toLowerCase();
  const logLevel: Config["logLevel"] =
    logLevelRaw === "error" ||
    logLevelRaw === "warn" ||
    logLevelRaw === "info" ||
    logLevelRaw === "debug"
      ? logLevelRaw
      : "info";

  // Password resolution priority: env (API_KEY or PASSWORD) > persisted file.
  // PASSWORD is an alias of API_KEY so users have a familiar name to type.
  const envKey = strOrNull("API_KEY") || strOrNull("PASSWORD");
  const serverMode = bool("KIRO_SERVER_MODE", false);
  const apiKey = envKey ?? (serverMode ? null : readStoredPassword());

  return {
    port: num("PORT", 11437, { min: MIN_PORT, max: MAX_PORT }),
    host: str("HOST", "0.0.0.0"),
    apiKey,
    kiroTokenDir: str(
      "KIRO_TOKEN_DIR",
      serverMode ? "/data/aws-sso-cache" : join(homedir(), ".aws", "sso", "cache")
    ),
    kiroRefreshToken: strOrNull("KIRO_REFRESH_TOKEN"),
    kiroProfileArn: strOrNull("KIRO_PROFILE_ARN"),
    refreshLeadSeconds: num("KIRO_REFRESH_LEAD_SECONDS", 300, { min: 0 }),
    logLevel,
  };
}
