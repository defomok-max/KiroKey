#!/usr/bin/env node
/**
 * kiro-router — main HTTP server.
 *
 * One small file ties everything together so users see the whole control
 * flow in one place.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";

import { loadConfig } from "./config.js";
import { log, setLogLevel } from "./logger.js";
import { AccountManager, type RoutingStrategy } from "./kiro/accountManager.js";
import { warmUpstream } from "./kiro/client.js";
import {
  getAuthBearer,
  authTokenMatches,
  handleCorsPreflight,
  sendError,
  sendJson,
  sendText,
} from "./http/util.js";
import { handleChatCompletions, handleModels } from "./routes/openai.js";
import { handleMessages } from "./routes/anthropic.js";
import {
  handleAccounts,
  handleHealth,
  handleRefresh,
  handleReload,
  handleReset,
} from "./routes/admin.js";

async function main() {
  const cfg = loadConfig();
  setLogLevel(cfg.logLevel);

  const passwordSource = cfg.apiKey
    ? process.env.API_KEY || process.env.PASSWORD
      ? "env"
      : "file"
    : "none";
  const serverMode = process.env.KIRO_SERVER_MODE === "1";
  log.info("kiro-router: starting", {
    port: cfg.port,
    host: cfg.host,
    password: passwordSource,
    tokenDir: cfg.kiroTokenDir,
    refreshLead: cfg.refreshLeadSeconds,
    serverMode,
  });

  // Loud banner when bound to all interfaces without auth — anyone who can
  // reach this machine could consume the user's Kiro subscription.
  const exposedAll = cfg.host === "0.0.0.0" || cfg.host === "::" || cfg.host === "*";
  if (exposedAll && !cfg.apiKey) {
    const banner =
      "\n" +
      "===============================================================================\n" +
      "  WARNING: kiro-router is listening on " +
      cfg.host +
      ":" +
      cfg.port +
      " with NO password set.\n" +
      "  This is an OPEN PROXY — anyone who can reach this machine can use your\n" +
      "  Kiro subscription. Fix one of:\n" +
      "    npm run set-password       (recommended — persistent)\n" +
      "    API_KEY=<secret> npm start (one-shot via env)\n" +
      "    HOST=127.0.0.1 npm start   (bind to localhost only)\n" +
      "===============================================================================\n";
    process.stderr.write(banner);
    log.warn("kiro-router: open proxy mode", {
      host: cfg.host,
      hint: "run `npm run set-password`, or set API_KEY, or set HOST=127.0.0.1",
    });
  }

  if (serverMode && !cfg.apiKey) {
    log.error("kiro-router: API_KEY is required when KIRO_SERVER_MODE=1");
    process.exit(1);
  }

  const strategyRaw = process.env.KIRO_STRATEGY || "round-robin";
  const strategy: RoutingStrategy =
    strategyRaw === "round-robin" || strategyRaw === "least-used" || strategyRaw === "priority"
      ? strategyRaw
      : "round-robin";
  if (strategy !== strategyRaw) {
    log.warn("kiro-router: invalid KIRO_STRATEGY, using round-robin", { value: strategyRaw });
  }
  const manager = new AccountManager({
    cacheDir: cfg.kiroTokenDir,
    overrideRefreshToken: cfg.kiroRefreshToken,
    overrideProfileArn: cfg.kiroProfileArn,
    refreshLeadSeconds: cfg.refreshLeadSeconds,
    strategy,
  });
  await manager.start();

  const list = manager.list();
  if (list.length === 0) {
    log.warn("kiro-router: no accounts found", {
      hint:
        "Login to Kiro IDE first so it writes ~/.aws/sso/cache/kiro-auth-token.json, " +
        "or set KIRO_REFRESH_TOKEN in your environment.",
    });
  } else {
    log.info("kiro-router: accounts loaded", {
      total: list.length,
      ids: list.map((a) => a.id),
      labels: list.map((a) => a.label),
    });
    // Best-effort pre-warm of the upstream TLS connection so the first real
    // chat request doesn't pay for the handshake.
    void warmUpstream().then(
      () => log.debug("upstream: warmed"),
      (err) => log.debug("upstream: warm-up failed", { err: (err as Error).message })
    );
  }

  const server = createServer((req, res) => {
    handle(req, res, manager, cfg.apiKey).catch((err) => {
      log.error("server: unhandled error", { err: (err as Error).message });
      try {
        sendError(res, 500, "internal_error", (err as Error).message);
      } catch {
        /* response already started */
      }
    });
  });

  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;

  server.listen(cfg.port, cfg.host, () => {
    log.info("kiro-router: listening", {
      url: `http://${cfg.host}:${cfg.port}`,
      endpoints: [
        "GET  /health",
        "GET  /v1/models",
        "POST /v1/chat/completions",
        "POST /v1/messages",
        "GET  /admin/accounts",
        "POST /admin/refresh",
        "POST /admin/reload",
        "POST /admin/accounts/:id/reset",
      ],
    });
  });

  const shutdown = async (sig: string) => {
    log.info("server: shutting down", { signal: sig });
    await manager.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  manager: AccountManager,
  apiKey: string | null
): Promise<void> {
  if (handleCorsPreflight(req, res)) return;

  const url = new URL(req.url || "/", "http://localhost");
  const path = url.pathname;
  const method = req.method || "GET";

  // /health does not require auth — make it useful for liveness probes.
  if (path === "/health" && method === "GET") {
    return handleHealth(req, res, manager);
  }
  if (path === "/" && method === "GET") {
    return sendText(
      res,
      200,
      "kiro-router — see /health, /v1/models, /v1/chat/completions, /v1/messages, /admin/accounts"
    );
  }

  // Auth check for everything else.
  if (apiKey) {
    const presented = getAuthBearer(req);
    if (!authTokenMatches(presented, apiKey)) {
      return sendError(res, 401, "unauthorized", "invalid or missing API key");
    }
  }

  if (path === "/v1/models" && method === "GET") {
    return handleModels(req, res);
  }
  if (path === "/v1/chat/completions" && method === "POST") {
    return handleChatCompletions(req, res, manager);
  }
  if (path === "/v1/messages" && method === "POST") {
    return handleMessages(req, res, manager);
  }
  if (path === "/admin/accounts" && method === "GET") {
    return handleAccounts(req, res, manager);
  }
  if (path === "/admin/refresh" && method === "POST") {
    return handleRefresh(req, res, manager);
  }
  if (path === "/admin/reload" && method === "POST") {
    return handleReload(req, res, manager);
  }
  const resetMatch = /^\/admin\/accounts\/([^/]+)\/reset$/.exec(path);
  if (resetMatch && method === "POST") {
    try {
      return handleReset(req, res, manager, decodeURIComponent(resetMatch[1]));
    } catch {
      return sendError(res, 400, "invalid_request", "invalid account id encoding");
    }
  }

  sendError(res, 404, "not_found", `no route for ${method} ${path}`);
}

main().catch((err) => {
  log.error("kiro-router: fatal", { err: (err as Error).message, stack: (err as Error).stack });
  process.exit(1);
});
