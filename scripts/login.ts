#!/usr/bin/env node
/**
 * kiro-router login (AWS Builder ID device-code OAuth).
 *
 * Drops a kiro-auth-token.json into ~/.aws/sso/cache/ — the same file Kiro
 * IDE writes — so the proxy picks it up automatically via auto-discovery.
 *
 * Usage:
 *   npm run login                            # interactive Builder ID flow
 *   npm run login -- --no-open               # do not try to open browser
 *   npm run login -- --start-url=<url>       # IDC start URL (advanced)
 *   npm run login -- --region=us-east-1      # AWS region (default us-east-1)
 *   npm run login -- --out=/path/file.json   # custom cache path
 *
 * Env overrides:
 *   KIRO_REGION, KIRO_START_URL, KIRO_TOKEN_DIR, KIRO_TOKEN_FILE
 */

import { existsSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const DEFAULT_SCOPES = [
  "codewhisperer:completions",
  "codewhisperer:analysis",
  "codewhisperer:conversations",
  "codewhisperer:transformations",
  "codewhisperer:taskassist",
];

interface Args {
  region: string;
  startUrl: string;
  outPath: string;
  open: boolean;
  scopes: string[];
  label: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (k: string): string | undefined => {
    const pref = `--${k}=`;
    const hit = argv.find((a) => a.startsWith(pref));
    if (hit) return hit.slice(pref.length);
    const idx = argv.indexOf(`--${k}`);
    if (idx >= 0 && argv[idx + 1] && !argv[idx + 1].startsWith("--")) return argv[idx + 1];
    return undefined;
  };
  const noOpen = argv.includes("--no-open") || argv.includes("--no-browser");

  const region = get("region") || process.env.KIRO_REGION || "us-east-1";
  const startUrl = get("start-url") || process.env.KIRO_START_URL || "https://view.awsapps.com/start";

  const explicitOut = get("out");
  const tokenDir = process.env.KIRO_TOKEN_DIR || join(homedir(), ".aws", "sso", "cache");
  const tokenFile = process.env.KIRO_TOKEN_FILE || "kiro-auth-token.json";
  const outPath = explicitOut || join(tokenDir, tokenFile);

  const scopesArg = get("scopes");
  const scopes = scopesArg ? scopesArg.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_SCOPES;

  return {
    region,
    startUrl,
    outPath,
    open: !noOpen,
    scopes,
    label: get("label") || "KiroKey",
  };
}

interface ClientReg {
  clientId: string;
  clientSecret: string;
  clientIdIssuedAt?: number;
  clientSecretExpiresAt?: number;
}

interface DeviceAuth {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

interface TokenResp {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType?: string;
}

async function jsonPost<T>(url: string, body: unknown): Promise<{ ok: boolean; status: number; data: T | null; text: string }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data: T | null = null;
  try {
    data = text ? (JSON.parse(text) as T) : null;
  } catch {
    /* ignored */
  }
  return { ok: res.ok, status: res.status, data, text };
}

async function registerClient(region: string, scopes: string[], clientName: string): Promise<ClientReg> {
  const url = `https://oidc.${region}.amazonaws.com/client/register`;
  const r = await jsonPost<ClientReg>(url, {
    clientName,
    clientType: "public",
    grantTypes: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
    scopes,
    issuerUrl: "https://view.awsapps.com/start",
  });
  if (!r.ok || !r.data?.clientId || !r.data?.clientSecret) {
    throw new Error(`client/register failed: status=${r.status} body=${r.text.slice(0, 400)}`);
  }
  return r.data;
}

async function startDeviceAuth(region: string, client: ClientReg, startUrl: string): Promise<DeviceAuth> {
  const url = `https://oidc.${region}.amazonaws.com/device_authorization`;
  const r = await jsonPost<DeviceAuth>(url, {
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    startUrl,
  });
  if (!r.ok || !r.data?.deviceCode) {
    throw new Error(`device_authorization failed: status=${r.status} body=${r.text.slice(0, 400)}`);
  }
  return r.data;
}

async function pollForToken(region: string, client: ClientReg, dev: DeviceAuth): Promise<TokenResp> {
  const url = `https://oidc.${region}.amazonaws.com/token`;
  const deadline = Date.now() + dev.expiresIn * 1000;
  let interval = Math.max(1, dev.interval || 5);
  while (Date.now() < deadline) {
    const r = await jsonPost<TokenResp & { error?: string }>(url, {
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      deviceCode: dev.deviceCode,
      grantType: "urn:ietf:params:oauth:grant-type:device_code",
    });
    if (r.ok && r.data?.accessToken && r.data?.refreshToken) {
      return r.data;
    }
    const err = (r.data?.error || "").toLowerCase();
    if (err === "authorization_pending" || /authorization_pending/i.test(r.text)) {
      await sleep(interval * 1000);
      continue;
    }
    if (err === "slow_down" || /slow_down/i.test(r.text)) {
      interval += 5;
      await sleep(interval * 1000);
      continue;
    }
    throw new Error(`token poll failed: status=${r.status} body=${r.text.slice(0, 400)}`);
  }
  throw new Error("device code expired before authorization completed");
}

function openInBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
      ? "cmd"
      : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* swallow; we already printed the URL */
  }
}

function isoFromExpiresIn(expiresIn: number): string {
  return new Date(Date.now() + expiresIn * 1000).toISOString();
}

async function main(): Promise<void> {
  const args = parseArgs();

  const oidcBase = `https://oidc.${args.region}.amazonaws.com`;
  console.log(`kiro-router login`);
  console.log(`  region:    ${args.region}`);
  console.log(`  endpoint:  ${oidcBase}`);
  console.log(`  startUrl:  ${args.startUrl}`);
  console.log(`  out:       ${args.outPath}`);
  console.log("");

  process.stdout.write("Registering OIDC client... ");
  const client = await registerClient(args.region, args.scopes, args.label);
  console.log("ok");

  process.stdout.write("Requesting device code...   ");
  const dev = await startDeviceAuth(args.region, client, args.startUrl);
  console.log("ok");
  console.log("");
  console.log("Open this URL in your browser to finish login:");
  console.log("");
  console.log("    " + dev.verificationUriComplete);
  console.log("");
  console.log("User code (if asked):  " + dev.userCode);
  console.log(
    `Polling every ${dev.interval || 5}s, expires in ${Math.round(dev.expiresIn / 60)} min.`
  );

  if (args.open) openInBrowser(dev.verificationUriComplete);

  const tok = await pollForToken(args.region, client, dev);
  console.log("");
  console.log("Login complete. Saving token...");

  const out = {
    startUrl: args.startUrl,
    region: args.region,
    accessToken: tok.accessToken,
    refreshToken: tok.refreshToken,
    expiresAt: isoFromExpiresIn(tok.expiresIn),
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    registrationExpiresAt: client.clientSecretExpiresAt
      ? new Date(client.clientSecretExpiresAt * 1000).toISOString()
      : undefined,
    scopes: args.scopes,
  };

  const dir = args.outPath.replace(/[^/\\]+$/, "");
  if (dir && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  await writeFile(args.outPath, JSON.stringify(out, null, 2) + "\n", { mode: 0o600 });

  console.log(`Wrote ${args.outPath} (mode 0600).`);
  console.log("");
  console.log("You're set. Start the proxy:");
  console.log("  npm start            (or:  npm run start:dist)");
  console.log("");
  console.log("The server auto-discovers tokens in ~/.aws/sso/cache.");
}

main().catch((err) => {
  console.error("kiro-router login failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
