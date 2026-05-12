/**
 * Tiny helpers for the Node http server.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { createHash, timingSafeEqual } from "node:crypto";

const MAX_BODY_BYTES = 32 * 1024 * 1024; // 32 MiB

export class HttpRequestError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function isJsonContentType(value: string): boolean {
  const mediaType = value.split(";", 1)[0].trim().toLowerCase();
  return mediaType === "application/json" || mediaType.endsWith("+json");
}

export async function readJson(req: IncomingMessage): Promise<unknown> {
  const contentType = req.headers["content-type"];
  const contentTypes = Array.isArray(contentType) ? contentType : contentType ? [contentType] : [];
  if (
    req.method !== "GET" &&
    contentTypes.length > 0 &&
    !contentTypes.some(isJsonContentType)
  ) {
    throw new HttpRequestError(415, "unsupported_media_type", "content-type must be application/json");
  }

  const parts: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBufferView["buffer"]);
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      throw new HttpRequestError(413, "request_too_large", `request body too large (>${MAX_BODY_BYTES} bytes)`);
    }
    parts.push(buf);
  }
  if (total === 0) return {};
  const text = Buffer.concat(parts).toString("utf-8");
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new HttpRequestError(400, "invalid_json", `invalid JSON: ${(err as Error).message}`);
  }
}

function safeJsonStringify(body: unknown): string {
  try {
    return JSON.stringify(body);
  } catch {
    return JSON.stringify({
      error: {
        message: "response could not be serialized",
        type: "internal_error",
        code: "internal_error",
      },
    });
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = safeJsonStringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data, "utf-8"),
    "Access-Control-Allow-Origin": "*",
  });
  res.end(data);
}

export function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body, "utf-8"),
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

export function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  extra?: Record<string, unknown>
): void {
  sendJson(res, status, {
    error: {
      message,
      type: code,
      code,
      ...extra,
    },
  });
}

export async function sendSseStream(res: ServerResponse, body: Readable): Promise<void> {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "Access-Control-Allow-Origin": "*",
  });
  try {
    await pipeline(body, res);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ERR_STREAM_PREMATURE_CLOSE") {
      throw err;
    }
  }
}

export function handleCorsPreflight(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method !== "OPTIONS") return false;
  res.writeHead(204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Authorization, Content-Type, X-Api-Key, X-Stainless-Lang, anthropic-version, anthropic-beta, anthropic-dangerous-direct-browser-access",
    "Access-Control-Max-Age": "600",
  });
  res.end();
  return true;
}

export function getAuthBearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization || req.headers["x-api-key"];
  if (typeof h !== "string" || !h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (m) return m[1].trim();
  return h.trim();
}

export function authTokenMatches(presented: string | null, expected: string): boolean {
  if (presented === null) return false;
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}
