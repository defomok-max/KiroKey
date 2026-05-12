import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { refreshAccount } from "./auth.js";
import type { AuthMethod, KiroAccount } from "./types.js";

const KIRO_AUTH_ENDPOINT = "https://prod.us-east-1.auth.desktop.kiro.dev";
const BUILDER_ID_START_URL = "https://view.awsapps.com/start";
const DEFAULT_REGION = "us-east-1";
const SOCIAL_CALLBACK_PATH = "/oauth/callback";
const SOCIAL_DEFAULT_PORT = 9876;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const POLLING_MARGIN_MS = 3000;
const USER_AGENT = "kiro-router";
const AWS_DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

const AWS_SCOPES = [
  "codewhisperer:completions",
  "codewhisperer:analysis",
  "codewhisperer:conversations",
  "codewhisperer:transformations",
  "codewhisperer:taskassist",
];

type SocialProvider = "Google" | "Github" | "Cognito";

export interface LinkAccountOptions {
  method: "google" | "github" | "builder-id" | "idc";
  label?: string;
  region?: string;
  startUrl?: string;
  openBrowser?: boolean;
  timeoutMs?: number;
  cacheDir?: string;
  callbackPort?: number;
  out?: Pick<NodeJS.WriteStream, "write">;
}

export interface LinkAccountResult {
  account: KiroAccount;
  path: string;
}

interface TokenPayload {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  authMethod: AuthMethod;
  provider?: string;
  region?: string;
  startUrl?: string;
  clientId?: string;
  clientSecret?: string;
  profileArn?: string;
}

interface SocialTokenResponse {
  accessToken?: unknown;
  refreshToken?: unknown;
  expiresIn?: unknown;
  profileArn?: unknown;
}

interface AwsClientRegistration {
  clientId: string;
  clientSecret: string;
  clientIdIssuedAt?: number;
  clientSecretExpiresAt?: number;
}

interface AwsDeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri?: string;
  verificationUriComplete?: string;
  expiresIn?: number;
  interval?: number;
}

interface AwsTokenResponse {
  accessToken?: string;
  refreshToken?: string;
  expiresIn?: number;
}

export async function linkAccount(options: LinkAccountOptions): Promise<LinkAccountResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cacheDir = options.cacheDir ?? defaultCacheDir();
  const openBrowser = options.openBrowser ?? true;

  const token =
    options.method === "google" || options.method === "github"
      ? await runSocialFlow(options, timeoutMs, openBrowser)
      : await runAwsDeviceFlow(options, timeoutMs, openBrowser);

  const account = await accountFromToken(token, options.label);
  const path = await saveLinkedToken(cacheDir, account.id, token);
  account.sourcePath = path;
  return { account, path };
}

export function defaultCacheDir(): string {
  return join(homedir(), ".aws", "sso", "cache");
}

export function linkedAccountId(token: Pick<TokenPayload, "refreshToken" | "authMethod" | "provider">): string {
  const fingerprint = createHash("sha256").update(token.refreshToken).digest("hex").slice(0, 16);
  const method = sanitizeIdPart(token.provider || token.authMethod);
  return `linked:${method}:${fingerprint}`;
}

export function tokenPathForAccount(cacheDir: string, accountId: string): string {
  return join(cacheDir, `${safeFileName(accountId)}.json`);
}

async function accountFromToken(token: TokenPayload, label?: string): Promise<KiroAccount> {
  const account: KiroAccount = {
    id: linkedAccountId(token),
    label: label || extractLabel(token) || token.provider || token.authMethod,
    authMethod: token.authMethod,
    refreshToken: token.refreshToken,
    accessToken: token.accessToken,
    expiresAt: Date.parse(token.expiresAt) || 0,
    region: token.region || DEFAULT_REGION,
    clientId: token.clientId ?? null,
    clientSecret: token.clientSecret ?? null,
    profileArn: token.profileArn ?? null,
    sourcePath: null,
    state: "healthy",
    lastError: null,
    coolingUntil: 0,
    failureCount: 0,
    requestCount: 0,
    successCount: 0,
    priority: 100,
    disabled: false,
  };

  const refreshed = account.authMethod === "social" ? await refreshAccount(account) : null;
  if (!refreshed) return account;
  account.accessToken = refreshed.accessToken;
  account.refreshToken = refreshed.refreshToken;
  account.expiresAt = Date.now() + refreshed.expiresIn * 1000;
  if (refreshed.profileArn) account.profileArn = refreshed.profileArn;
  token.accessToken = account.accessToken;
  token.refreshToken = account.refreshToken;
  token.expiresAt = new Date(account.expiresAt).toISOString();
  if (account.profileArn) token.profileArn = account.profileArn;
  return account;
}

async function saveLinkedToken(cacheDir: string, accountId: string, token: TokenPayload): Promise<string> {
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  await chmod(cacheDir, 0o700).catch(() => undefined);
  const path = tokenPathForAccount(cacheDir, accountId);
  await writeFile(path, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600).catch(() => undefined);
  return path;
}

async function runSocialFlow(
  options: LinkAccountOptions,
  timeoutMs: number,
  openBrowser: boolean
): Promise<TokenPayload> {
  const provider = socialProvider(options.method);
  const state = randomBase64Url(16);
  const codeVerifier = randomBase64Url(32);
  const codeChallenge = sha256Base64Url(codeVerifier);
  const callback = await startCallbackServer(state, options.callbackPort ?? SOCIAL_DEFAULT_PORT, timeoutMs);
  const url = new URL(`${KIRO_AUTH_ENDPOINT}/login`);
  url.searchParams.set("idp", provider);
  url.searchParams.set("redirect_uri", callback.redirectUri);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "select_account");

  options.out?.write(`Open this URL to link ${provider}: ${url.toString()}\n`);
  if (openBrowser) openBrowserUrl(url.toString());

  try {
    const result = await callback.wait();
    if (result.error) throw new Error(`login failed: ${result.error}`);
    if (!result.code) throw new Error("login failed: callback did not include code");
    const token = await exchangeSocialCode(result.code, codeVerifier, callback.redirectUri);
    const expiresAt = new Date(Date.now() + expiresInSeconds(token.expiresIn) * 1000).toISOString();
    return {
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresAt,
      authMethod: "social",
      provider,
      region: DEFAULT_REGION,
      profileArn: token.profileArn,
    };
  } finally {
    await callback.close();
  }
}

async function exchangeSocialCode(
  code: string,
  codeVerifier: string,
  redirectUri: string
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number; profileArn?: string }> {
  const res = await fetch(`${KIRO_AUTH_ENDPOINT}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/plain, */*",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
    }),
  });
  const body = await safeJson(res);
  if (!res.ok) throw new Error(`token exchange failed: status=${res.status}`);
  return {
    accessToken: requiredString(body.accessToken, "accessToken"),
    refreshToken: requiredString(body.refreshToken, "refreshToken"),
    expiresIn: expiresInSeconds(body.expiresIn),
    profileArn: typeof body.profileArn === "string" ? body.profileArn : undefined,
  };
}

async function runAwsDeviceFlow(
  options: LinkAccountOptions,
  timeoutMs: number,
  openBrowser: boolean
): Promise<TokenPayload> {
  const region = validateRegion(options.region ?? process.env.AWS_SSO_REGION ?? DEFAULT_REGION);
  const startUrl = options.method === "idc" ? requiredStartUrl(options.startUrl) : BUILDER_ID_START_URL;
  const oidc = `https://oidc.${region}.amazonaws.com`;
  const client = await registerAwsClientForStartUrl(oidc, startUrl);
  const device = await startAwsDeviceAuthorization(oidc, client, startUrl);
  const verificationUrl = device.verificationUriComplete || device.verificationUri;
  if (!verificationUrl) throw new Error("device authorization response missing verification URL");

  options.out?.write(`Open this URL and approve the code ${device.userCode}: ${verificationUrl}\n`);
  if (openBrowser) openBrowserUrl(verificationUrl);

  const tokens = await pollAwsDeviceToken(oidc, client, device, timeoutMs);
  return {
    accessToken: requiredString(tokens.accessToken, "accessToken"),
    refreshToken: requiredString(tokens.refreshToken, "refreshToken"),
    expiresAt: new Date(Date.now() + expiresInSeconds(tokens.expiresIn) * 1000).toISOString(),
    authMethod: options.method === "idc" ? "idc" : "builder-id",
    provider: options.method === "idc" ? "IAM Identity Center" : "AWS Builder ID",
    region,
    startUrl,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
  };
}

async function registerAwsClientForStartUrl(
  oidc: string,
  startUrl: string
): Promise<AwsClientRegistration> {
  const res = await fetch(`${oidc}/client/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({
      clientName: "kiro-router",
      clientType: "public",
      scopes: AWS_SCOPES,
      grantTypes: [AWS_DEVICE_GRANT, "refresh_token"],
      issuerUrl: startUrl,
    }),
  });
  const body = await safeJson(res);
  if (!res.ok) throw new Error(`OIDC client registration failed: status=${res.status}`);
  return {
    clientId: requiredString(body.clientId, "clientId"),
    clientSecret: requiredString(body.clientSecret, "clientSecret"),
    clientIdIssuedAt: optionalNumber(body.clientIdIssuedAt),
    clientSecretExpiresAt: optionalNumber(body.clientSecretExpiresAt),
  };
}

async function startAwsDeviceAuthorization(
  oidc: string,
  client: AwsClientRegistration,
  startUrl: string
): Promise<AwsDeviceAuthorization> {
  const res = await fetch(`${oidc}/device_authorization`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      startUrl,
    }),
  });
  const body = await safeJson(res);
  if (!res.ok) throw new Error(`device authorization failed: status=${res.status}`);
  return {
    deviceCode: requiredString(body.deviceCode, "deviceCode"),
    userCode: requiredString(body.userCode, "userCode"),
    verificationUri:
      typeof body.verificationUri === "string" && body.verificationUri ? body.verificationUri : undefined,
    verificationUriComplete:
      typeof body.verificationUriComplete === "string" && body.verificationUriComplete
        ? body.verificationUriComplete
        : undefined,
    expiresIn: optionalNumber(body.expiresIn),
    interval: optionalNumber(body.interval),
  };
}

async function pollAwsDeviceToken(
  oidc: string,
  client: AwsClientRegistration,
  device: AwsDeviceAuthorization,
  timeoutMs: number
): Promise<AwsTokenResponse> {
  let interval = Math.max(1, device.interval ?? 5);
  const deadline = Date.now() + Math.min(timeoutMs, (device.expiresIn ?? 600) * 1000);
  for (;;) {
    if (Date.now() > deadline) throw new Error("authentication timed out");
    const res = await fetch(`${oidc}/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        grantType: AWS_DEVICE_GRANT,
        deviceCode: device.deviceCode,
      }),
    });
    const body = await safeJson(res);
    if (res.ok) return body;
    if (body.error === "authorization_pending") {
      await sleep(interval * 1000 + POLLING_MARGIN_MS);
      continue;
    }
    if (body.error === "slow_down") {
      interval += 5;
      await sleep(interval * 1000 + POLLING_MARGIN_MS);
      continue;
    }
    throw new Error(
      `authentication failed: ${typeof body.error_description === "string" ? body.error_description : body.error || res.status}`
    );
  }
}

type CallbackServer = {
  redirectUri: string;
  wait: () => Promise<{ code?: string; error?: string }>;
  close: () => Promise<void>;
};

function startCallbackServer(
  expectedState: string,
  preferredPort: number,
  timeoutMs: number
): Promise<CallbackServer> {
  return new Promise<CallbackServer>((resolve, reject) => {
    const server = createServer();
    const done = deferred<{ code?: string; error?: string }>();
    const timer = setTimeout(() => done.reject(new Error("authentication timed out")), timeoutMs);
    timer.unref();

    server.on("request", (req, res) => {
      handleCallbackRequest(req, res, expectedState, done);
    });
    server.on("error", reject);
    server.listen(preferredPort, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "string" || address === null) {
        reject(new Error("failed to bind callback server"));
        return;
      }
      const port = address.port;
      resolve({
        redirectUri: `http://localhost:${port}${SOCIAL_CALLBACK_PATH}`,
        wait: () => done.promise,
        close: () =>
          new Promise<void>((closeResolve) => {
            clearTimeout(timer);
            server.close(() => closeResolve());
          }),
      });
    });
  }).catch((err) => {
    if (preferredPort !== 0) return startCallbackServer(expectedState, 0, timeoutMs);
    throw err;
  });
}

function handleCallbackRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedState: string,
  done: Deferred<{ code?: string; error?: string }>
): void {
  const url = new URL(req.url || "/", "http://localhost");
  if (url.pathname !== SOCIAL_CALLBACK_PATH) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("not found");
    return;
  }
  const error = url.searchParams.get("error");
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (error) {
    writeCallbackHtml(res, "Login failed", "KiroKey did not link this account.");
    done.resolve({ error });
    return;
  }
  if (state !== expectedState) {
    writeCallbackHtml(res, "Login failed", "Invalid OAuth state. You can close this window.");
    done.resolve({ error: "state mismatch" });
    return;
  }
  writeCallbackHtml(res, "Login successful", "Account linked. You can close this window.");
  done.resolve({ code: code ?? undefined });
}

function writeCallbackHtml(res: ServerResponse, title: string, message: string): void {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(
    title
  )}</title></head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(
    message
  )}</p><script>window.close();</script></body></html>`;
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
  });
  res.end(html);
}

function socialProvider(method: LinkAccountOptions["method"]): SocialProvider {
  if (method === "google") return "Google";
  if (method === "github") return "Github";
  throw new Error(`unsupported social method: ${method}`);
}

function openBrowserUrl(url: string): void {
  const command =
    process.platform === "win32"
      ? "cmd"
      : process.platform === "darwin"
        ? "open"
        : process.env.BROWSER || "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
}

async function safeJson(res: Response): Promise<Record<string, unknown>> {
  try {
    const text = await res.text();
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function requiredString(value: unknown, name: string): string {
  if (typeof value === "string" && value) return value;
  throw new Error(`response missing ${name}`);
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function expiresInSeconds(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 3600;
  return Math.min(Math.floor(value), 24 * 60 * 60);
}

function extractLabel(token: TokenPayload): string | null {
  const email = tryExtractEmailFromJwt(token.accessToken);
  if (email) return email;
  if (token.startUrl && token.startUrl !== BUILDER_ID_START_URL) return token.startUrl;
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
    ) as { email?: unknown; preferred_username?: unknown };
    return (
      (typeof decoded.email === "string" ? decoded.email : null) ||
      (typeof decoded.preferred_username === "string" ? decoded.preferred_username : null)
    );
  } catch {
    return null;
  }
}

function randomBase64Url(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function sha256Base64Url(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function validateRegion(region: string): string {
  if (!/^[a-z]{2}-[a-z-]+-\d+$/.test(region)) throw new Error(`invalid AWS region: ${region}`);
  return region;
}

function requiredStartUrl(startUrl?: string): string {
  if (!startUrl) throw new Error("--start-url is required for IAM Identity Center");
  const parsed = new URL(startUrl);
  if (parsed.protocol !== "https:") throw new Error("--start-url must be an https URL");
  return parsed.toString();
}

function sanitizeIdPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "account";
}

function safeFileName(value: string): string {
  return basename(value.replace(/[^a-zA-Z0-9_.:-]+/g, "_"));
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolveFn: (value: T) => void = () => undefined;
  let rejectFn: (err: Error) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  return { promise, resolve: resolveFn, reject: rejectFn };
}

export const LINK_ACCOUNT_INTERNALS = {
  AWS_SCOPES,
  BUILDER_ID_START_URL,
  SOCIAL_CALLBACK_PATH,
  tokenPathForAccount,
  linkedAccountId,
};
