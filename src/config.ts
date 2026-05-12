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

export type RoutingStrategy = "round-robin" | "least-used" | "priority";

const ROUTING_STRATEGIES: ReadonlySet<RoutingStrategy> = new Set([
  "round-robin",
  "least-used",
  "priority",
]);

export interface Config {
  port: number;
  host: string;
  apiKey: string | null;
  kiroTokenDir: string;
  kiroRefreshToken: string | null;
  kiroProfileArn: string | null;
  refreshLeadSeconds: number;
  logLevel: "error" | "warn" | "info" | "debug";
  strategy: RoutingStrategy;
  maxAttempts: number | null;
  corsOrigin: string;
  warnings: string[];
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
  const apiKey = envKey ?? readStoredPassword();

  const warnings: string[] = [];

  const strategyRaw = str("KIRO_STRATEGY", "round-robin").toLowerCase();
  let strategy: RoutingStrategy = "round-robin";
  if (ROUTING_STRATEGIES.has(strategyRaw as RoutingStrategy)) {
    strategy = strategyRaw as RoutingStrategy;
  } else if (process.env.KIRO_STRATEGY) {
    warnings.push(
      `Unknown KIRO_STRATEGY="${process.env.KIRO_STRATEGY}". Falling back to "round-robin". Valid: round-robin, least-used, priority.`
    );
  }

  const maxAttemptsRaw = process.env.KIRO_MAX_ATTEMPTS;
  let maxAttempts: number | null = null;
  if (maxAttemptsRaw && maxAttemptsRaw.trim() !== "") {
    const parsed = Number.parseInt(maxAttemptsRaw, 10);
    if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 50) {
      maxAttempts = parsed;
    } else {
      warnings.push(
        `Ignoring KIRO_MAX_ATTEMPTS="${maxAttemptsRaw}" — must be an integer in [1, 50].`
      );
    }
  }

  return {
    port: num("PORT", 11437),
    host: str("HOST", "0.0.0.0"),
    apiKey,
    kiroTokenDir: str("KIRO_TOKEN_DIR", join(homedir(), ".aws", "sso", "cache")),
    kiroRefreshToken: strOrNull("KIRO_REFRESH_TOKEN"),
    kiroProfileArn: strOrNull("KIRO_PROFILE_ARN"),
    refreshLeadSeconds: num("KIRO_REFRESH_LEAD_SECONDS", 300),
    logLevel,
    strategy,
    maxAttempts,
    corsOrigin: str("CORS_ORIGIN", "*"),
    warnings,
  };
}
