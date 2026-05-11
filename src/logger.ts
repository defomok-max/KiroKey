/**
 * Tiny structured logger. No deps.
 */

type Level = "error" | "warn" | "info" | "debug";

const LEVELS: Record<Level, number> = { error: 0, warn: 1, info: 2, debug: 3 };

let currentLevel: number = LEVELS.info;

export function setLogLevel(level: Level): void {
  currentLevel = LEVELS[level];
}

function emit(level: Level, msg: string, meta?: Record<string, unknown>): void {
  if (LEVELS[level] > currentLevel) return;
  const line: Record<string, unknown> = {
    t: new Date().toISOString(),
    level,
    msg,
  };
  if (meta) Object.assign(line, meta);
  const out = JSON.stringify(line);
  if (level === "error" || level === "warn") {
    console.error(out);
  } else {
    console.log(out);
  }
}

export const log = {
  error: (msg: string, meta?: Record<string, unknown>) => emit("error", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => emit("warn", msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => emit("info", msg, meta),
  debug: (msg: string, meta?: Record<string, unknown>) => emit("debug", msg, meta),
};
