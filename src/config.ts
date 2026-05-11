/**
 * kiro-router configuration loader.
 * Reads from process.env. No .env file parsing — keep deps zero.
 * Users can `source .env` or use a runner like `dotenv-cli` if desired.
 */

import { homedir } from "node:os";
import { join } from "node:path";

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

function num(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function str(key: string, fallback: string): string {
  const raw = process.env[key];
  return raw && raw.trim() !== "" ? raw : fallback;
}

function strOrNull(key: string): string | null {
  const raw = process.env[key];
  return raw && raw.trim() !== "" ? raw : null;
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

  return {
    port: num("PORT", 11437),
    host: str("HOST", "127.0.0.1"),
    apiKey: strOrNull("API_KEY"),
    kiroTokenDir: str("KIRO_TOKEN_DIR", join(homedir(), ".aws", "sso", "cache")),
    kiroRefreshToken: strOrNull("KIRO_REFRESH_TOKEN"),
    kiroProfileArn: strOrNull("KIRO_PROFILE_ARN"),
    refreshLeadSeconds: num("KIRO_REFRESH_LEAD_SECONDS", 300),
    logLevel,
  };
}
