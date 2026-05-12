/**
 * Kiro / AWS CodeWhisperer API client.
 *
 * Endpoint: POST https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse
 * Auth: Bearer <accessToken>
 * Body: Kiro `conversationState` payload (see ./request.ts)
 * Response: AWS EventStream binary (CRC32-validated) on success, JSON on error.
 *
 * We use a keep-alive https.Agent so the TLS handshake is amortized across
 * many requests — this is one of the main reasons kiro-router is materially
 * faster than the Next.js/edge OmniRoute path which doesn't pool sockets.
 */

import { Agent, request as httpsRequest } from "node:https";
import { connect as tlsConnect } from "node:tls";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";

const HOST = "codewhisperer.us-east-1.amazonaws.com";
const PATH = "/generateAssistantResponse";

const KEEP_ALIVE_AGENT = new Agent({
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxSockets: 32,
  maxFreeSockets: 8,
  scheduling: "lifo",
});

/**
 * Open a TLS connection to CodeWhisperer and immediately drop it into the
 * keep-alive pool. Called at server start so the first real request doesn't
 * pay for DNS + TCP + TLS handshake. Best-effort: failures are swallowed
 * and logged at debug level by the caller.
 */
export function warmUpstream(timeoutMs = 4000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const sock = tlsConnect({
      host: HOST,
      port: 443,
      servername: HOST,
      ALPNProtocols: ["http/1.1"],
    });
    const timer = setTimeout(() => {
      sock.destroy(new Error("warm-up timeout"));
    }, timeoutMs);
    sock.once("secureConnect", () => {
      clearTimeout(timer);
      sock.end();
      resolve();
    });
    sock.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export interface KiroResponse {
  /** HTTP status code from upstream. */
  status: number;
  /** Headers from upstream. */
  headers: Record<string, string>;
  /** Body as a Node Readable. For non-2xx responses, callers can read text. */
  body: Readable;
}

/**
 * POST a request to CodeWhisperer. The body must be a JSON-serializable
 * object — caller is responsible for shaping it as a valid Kiro payload.
 */
export function postKiro(opts: {
  accessToken: string;
  payload: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<KiroResponse> {
  const bodyBytes = Buffer.from(JSON.stringify(opts.payload));
  return new Promise<KiroResponse>((resolve, reject) => {
    let abort: (() => void) | null = null;
    const cleanup = () => {
      if (opts.signal && abort) {
        opts.signal.removeEventListener("abort", abort);
        abort = null;
      }
    };
    const req = httpsRequest(
      {
        host: HOST,
        path: PATH,
        method: "POST",
        agent: KEEP_ALIVE_AGENT,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/vnd.amazon.eventstream",
          "Content-Length": bodyBytes.length,
          Authorization: `Bearer ${opts.accessToken}`,
          "X-Amz-Target": "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
          "User-Agent": "AWS-SDK-JS/3.0.0 kiro-ide/1.0.0",
          "X-Amz-User-Agent": "aws-sdk-js/3.0.0 kiro-ide/1.0.0",
          "Amz-Sdk-Request": "attempt=1; max=3",
          "Amz-Sdk-Invocation-Id": randomUUID(),
          "x-amzn-bedrock-cache-control": "enable",
          "anthropic-beta": "prompt-caching-2024-07-31",
        },
      },
      (res) => {
        res.once("close", cleanup);
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (Array.isArray(v)) headers[k.toLowerCase()] = v.join(", ");
          else if (typeof v === "string") headers[k.toLowerCase()] = v;
        }
        resolve({
          status: res.statusCode ?? 0,
          headers,
          body: res,
        });
      }
    );

    req.on("error", (err) => {
      cleanup();
      reject(err);
    });

    req.setTimeout(opts.timeoutMs ?? 120_000, () => {
      req.destroy(new Error("upstream timeout"));
    });

    if (opts.signal) {
      abort = () => req.destroy(new Error("aborted"));
      if (opts.signal.aborted) abort();
      else opts.signal.addEventListener("abort", abort, { once: true });
    }

    req.write(bodyBytes);
    req.end();
  });
}

/** Drain a Readable to a string (used for error bodies). */
export async function readAsText(body: Readable, max = 32 * 1024): Promise<string> {
  let total = 0;
  const parts: Buffer[] = [];
  for await (const chunk of body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBufferView["buffer"]);
    parts.push(buf);
    total += buf.length;
    if (total >= max) break;
  }
  return Buffer.concat(parts).toString("utf-8");
}
