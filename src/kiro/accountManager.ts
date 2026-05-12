/**
 * AccountManager — the multi-account orchestrator.
 *
 * Responsibilities:
 *   - Auto-discover Kiro accounts from ~/.aws/sso/cache and merge with the
 *     persistent ~/.kiro-router/accounts.json manifest.
 *   - Pick an account for an outgoing request using a configurable strategy
 *     (round-robin / least-used / priority), respecting cool-downs and
 *     terminal states.
 *   - Refresh tokens proactively (background timer) and reactively (on 401).
 *   - Persist updates atomically.
 *   - Hot-reload (filesystem watcher on the cache dir).
 *
 * The manager is intentionally a single in-process object — kiro-router is a
 * lightweight local daemon, not a distributed system. We use an in-memory
 * mutex per account to serialize refreshes.
 */

import { watch, type FSWatcher } from "node:fs";
import { setInterval as nodeSetInterval, clearInterval as nodeClearInterval } from "node:timers";

import { log } from "../logger.js";
import { isExpiring, refreshAccount, RefreshError } from "./auth.js";
import { discoverFromAwsSsoCache, loadManifest, saveManifest } from "./manifest.js";
import { linkAccount, type LinkAccountOptions } from "./linkAccount.js";
import type { KiroAccount } from "./types.js";

export type RoutingStrategy = "round-robin" | "least-used" | "priority";

export interface AccountManagerOptions {
  /** Cache dir from which to auto-discover (e.g. ~/.aws/sso/cache). */
  cacheDir: string;
  /** Optional override refresh token (for headless / Docker setups). */
  overrideRefreshToken?: string | null;
  /** Optional override profile ARN (for IDC). */
  overrideProfileArn?: string | null;
  /** Refresh this many seconds before token expiry. */
  refreshLeadSeconds: number;
  /** Routing strategy. */
  strategy: RoutingStrategy;
  /** How often the proactive refresher wakes up (ms). */
  refresherIntervalMs?: number;
  /** Persist updates back to disk. Default true. */
  persistOnUpdate?: boolean;
}

export class AccountManager {
  private accounts: KiroAccount[] = [];
  private readonly opts: Required<Omit<AccountManagerOptions, "overrideRefreshToken" | "overrideProfileArn">> & {
    overrideRefreshToken: string | null;
    overrideProfileArn: string | null;
  };
  private refresherTimer: NodeJS.Timeout | null = null;
  private watcher: FSWatcher | null = null;
  /** Promises in-flight per account.id, so concurrent requests wait on one refresh. */
  private inflightRefresh = new Map<string, Promise<void>>();
  /** Round-robin cursor. */
  private rrCursor = 0;
  /** Set to true after initial load completes. */
  private ready = false;

  constructor(options: AccountManagerOptions) {
    this.opts = {
      cacheDir: options.cacheDir,
      overrideRefreshToken: options.overrideRefreshToken ?? null,
      overrideProfileArn: options.overrideProfileArn ?? null,
      refreshLeadSeconds: options.refreshLeadSeconds,
      strategy: options.strategy,
      refresherIntervalMs: options.refresherIntervalMs ?? 30_000,
      persistOnUpdate: options.persistOnUpdate ?? true,
    };
  }

  private accountRef(accountId: string): KiroAccount | null {
    return this.accounts.find((a) => a.id === accountId) ?? null;
  }

  /** Load manifest + discover from cache. Starts the background refresher. */
  async start(): Promise<void> {
    await this.reload();

    // Proactive refresher.
    this.refresherTimer = nodeSetInterval(() => {
      this.proactiveRefresh().catch((err) =>
        log.error("refresher: tick failed", { err: (err as Error).message })
      );
    }, this.opts.refresherIntervalMs);
    // Don't keep the process alive just for this timer.
    this.refresherTimer.unref();

    // Hot reload: watch the cache dir for changes (added/removed files).
    try {
      this.watcher = watch(this.opts.cacheDir, { persistent: false }, () => {
        // Debounce via timer.
        this.scheduleReload();
      });
    } catch (err) {
      log.debug("watch: failed to watch cache dir (ok if missing)", {
        cacheDir: this.opts.cacheDir,
        err: (err as Error).message,
      });
    }

    // Initial proactive pass (don't block startup if it fails).
    this.proactiveRefresh().catch((err) =>
      log.warn("refresher: initial pass failed", { err: (err as Error).message })
    );

    this.ready = true;
  }

  async stop(): Promise<void> {
    if (this.refresherTimer) {
      nodeClearInterval(this.refresherTimer);
      this.refresherTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }
  }

  private reloadTimer: NodeJS.Timeout | null = null;
  private scheduleReload(): void {
    if (this.reloadTimer) return;
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null;
      this.reload().catch((err) =>
        log.error("reload: failed", { err: (err as Error).message })
      );
    }, 750);
    this.reloadTimer.unref();
  }

  /**
   * Merge manifest + cache-dir discovery. Cache-dir wins for refresh token
   * (the user may have logged in again in Kiro IDE) — but persisted state
   * (cool-downs, counters) is preserved per-id.
   */
  async reload(): Promise<void> {
    const [fromManifest, fromCache] = await Promise.all([
      loadManifest(),
      discoverFromAwsSsoCache(this.opts.cacheDir),
    ]);

    const byId = new Map<string, KiroAccount>();
    for (const a of fromManifest) byId.set(a.id, a);

    for (const discovered of fromCache) {
      const existing = byId.get(discovered.id);
      if (existing) {
        // Refresh token from disk wins (Kiro IDE may have re-logged in).
        existing.refreshToken = discovered.refreshToken;
        if (discovered.clientId) existing.clientId = discovered.clientId;
        if (discovered.clientSecret) existing.clientSecret = discovered.clientSecret;
        if (discovered.region) existing.region = discovered.region;
        if (discovered.profileArn) existing.profileArn = discovered.profileArn;
        existing.sourcePath = discovered.sourcePath;
        if (discovered.label && existing.label === existing.id) {
          existing.label = discovered.label;
        }
        // If we were terminal because of a dead refresh token, clear it.
        if (existing.state === "terminal" && existing.refreshToken !== discovered.refreshToken) {
          existing.state = "healthy";
          existing.lastError = null;
          existing.failureCount = 0;
        }
      } else {
        byId.set(discovered.id, discovered);
      }
    }

    // Environment override (highest precedence): synthetic account "env".
    if (this.opts.overrideRefreshToken) {
      const id = "env";
      const env: KiroAccount = byId.get(id) ?? {
        id,
        label: "env",
        authMethod: "imported",
        refreshToken: this.opts.overrideRefreshToken,
        accessToken: null,
        expiresAt: 0,
        region: "us-east-1",
        clientId: null,
        clientSecret: null,
        profileArn: this.opts.overrideProfileArn,
        sourcePath: null,
        state: "healthy",
        lastError: null,
        coolingUntil: 0,
        failureCount: 0,
        requestCount: 0,
        successCount: 0,
        priority: 50,
        disabled: false,
      };
      env.refreshToken = this.opts.overrideRefreshToken;
      if (this.opts.overrideProfileArn) env.profileArn = this.opts.overrideProfileArn;
      byId.set(id, env);
    }

    const list = Array.from(byId.values());
    list.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));

    const before = this.accounts.length;
    this.accounts = list;
    log.info("accounts: reloaded", {
      total: list.length,
      added: list.length - before,
      ids: list.map((a) => a.id),
    });

    if (this.opts.persistOnUpdate) {
      await saveManifest(this.accounts).catch((err) =>
        log.error("accounts: persist failed", { err: (err as Error).message })
      );
    }
  }

  /** Snapshot of current accounts (defensive copy). */
  list(): KiroAccount[] {
    return this.accounts.map((a) => ({ ...a }));
  }

  async link(options: Omit<LinkAccountOptions, "cacheDir">): Promise<KiroAccount> {
    const result = await linkAccount({ ...options, cacheDir: this.opts.cacheDir });
    await this.reload();
    return result.account;
  }

  isReady(): boolean {
    return this.ready;
  }

  /** Find candidate accounts that are usable right now. */
  private candidates(now = Date.now()): KiroAccount[] {
    return this.accounts.filter((a) => {
      if (a.disabled) return false;
      if (a.state === "terminal") return false;
      if (a.coolingUntil > now) return false;
      return !!a.refreshToken;
    });
  }

  /**
   * Pick an account according to the configured strategy. Returns null when
   * no usable account is available.
   */
  pick(excludeIds: ReadonlySet<string> = new Set()): KiroAccount | null {
    const now = Date.now();
    const candidates = this.candidates(now).filter((a) => !excludeIds.has(a.id));
    if (candidates.length === 0) return null;

    switch (this.opts.strategy) {
      case "priority": {
        // Already sorted by priority in reload().
        return candidates[0];
      }
      case "least-used": {
        let best = candidates[0];
        for (const c of candidates) {
          if (c.requestCount < best.requestCount) best = c;
        }
        return best;
      }
      case "round-robin":
      default: {
        if (this.rrCursor >= candidates.length) this.rrCursor = 0;
        const picked = candidates[this.rrCursor];
        this.rrCursor = (this.rrCursor + 1) % candidates.length;
        return picked;
      }
    }
  }

  /** Get a fresh access token for the given account, refreshing if needed. */
  async ensureToken(account: KiroAccount): Promise<string> {
    const current = this.accountRef(account.id);
    if (!current) {
      throw new Error(`account ${account.id} no longer exists`);
    }
    if (!isExpiring(current, this.opts.refreshLeadSeconds) && current.accessToken) {
      return current.accessToken;
    }
    await this.refreshOne(current);
    if (!current.accessToken) {
      throw new Error(`account ${current.id} has no access token after refresh`);
    }
    return current.accessToken;
  }

  /** Refresh an account and return the access token stored after refresh. */
  async refreshAndGetToken(account: KiroAccount): Promise<string> {
    await this.refreshOne(account);
    const current = this.accountRef(account.id);
    if (!current?.accessToken) {
      throw new Error(`account ${account.id} has no access token after refresh`);
    }
    return current.accessToken;
  }

  /** Refresh exactly one account, deduping concurrent callers. */
  async refreshOne(account: KiroAccount): Promise<void> {
    const accountId = account.id;
    const existing = this.inflightRefresh.get(accountId);
    if (existing) return existing;

    const p = (async () => {
      let current = this.accountRef(accountId);
      if (current === null) {
        throw new Error(`account ${accountId} no longer exists`);
      }
      const previousState = current.state;
      current.state = "refreshing";
      try {
        const result = await refreshAccount(current);
        current = this.accountRef(accountId);
        if (current === null) {
          throw new Error(`account ${accountId} no longer exists`);
        }
        current.accessToken = result.accessToken;
        current.refreshToken = result.refreshToken;
        current.expiresAt = Date.now() + result.expiresIn * 1000;
        if (result.profileArn) current.profileArn = result.profileArn;
        current.state = "healthy";
        current.lastError = null;
        current.failureCount = 0;
        log.info("refresh: success", {
          id: current.id,
          expiresIn: result.expiresIn,
        });
      } catch (err) {
        const e = err as Error;
        const refreshErr = err instanceof RefreshError ? err : null;
        const failed = this.accountRef(accountId);
        if (failed === null) {
          throw e;
        }
        failed.failureCount += 1;
        failed.lastError = e.message;
        failed.state = refreshErr?.terminal ? "terminal" : "expired";
        log.error("refresh: failed", {
          id: failed.id,
          state: failed.state,
          previousState,
          status: refreshErr?.status,
          err: e.message,
        });
        throw e;
      } finally {
        if (this.opts.persistOnUpdate) {
          await saveManifest(this.accounts).catch((err) =>
            log.warn("refresh: persist failed", { err: (err as Error).message })
          );
        }
        this.inflightRefresh.delete(accountId);
      }
    })();

    this.inflightRefresh.set(accountId, p);
    return p;
  }

  /** Walk all healthy accounts and refresh any whose token is expiring. */
  async proactiveRefresh(): Promise<void> {
    const lead = this.opts.refreshLeadSeconds;
    const targets = this.accounts.filter(
      (a) => !a.disabled && a.state !== "terminal" && isExpiring(a, lead)
    );
    if (targets.length === 0) return;
    log.debug("refresher: refreshing accounts", {
      count: targets.length,
      ids: targets.map((t) => t.id),
    });
    // Refresh in parallel; swallow failures (already logged).
    await Promise.allSettled(targets.map((a) => this.refreshOne(a)));
  }

  /** Mark an account as cooling for N seconds (e.g. on 429). */
  cool(accountId: string, seconds: number, reason: string): void {
    const a = this.accounts.find((x) => x.id === accountId);
    if (!a) return;
    a.coolingUntil = Date.now() + seconds * 1000;
    a.state = "cooling";
    a.lastError = `cooling ${seconds}s: ${reason}`;
    log.warn("account: cooling", { id: a.id, seconds, reason });
    if (this.opts.persistOnUpdate) {
      void saveManifest(this.accounts).catch((err) =>
        log.warn("account: persist failed", { err: (err as Error).message })
      );
    }
  }

  /** Reset an account back to healthy (operator action). */
  reset(accountId: string): boolean {
    const a = this.accounts.find((x) => x.id === accountId);
    if (!a) return false;
    a.state = "healthy";
    a.lastError = null;
    a.coolingUntil = 0;
    a.failureCount = 0;
    if (this.opts.persistOnUpdate) {
      void saveManifest(this.accounts).catch((err) =>
        log.warn("account: persist failed", { err: (err as Error).message })
      );
    }
    return true;
  }

  /** Note a successful request against an account. */
  noteSuccess(accountId: string): void {
    const a = this.accounts.find((x) => x.id === accountId);
    if (!a) return;
    a.successCount += 1;
    if (a.state === "cooling" && a.coolingUntil <= Date.now()) {
      a.state = "healthy";
    }
    if (this.opts.persistOnUpdate) {
      void saveManifest(this.accounts).catch((err) =>
        log.warn("account: persist failed", { err: (err as Error).message })
      );
    }
  }

  noteRequest(accountId: string): void {
    const a = this.accounts.find((x) => x.id === accountId);
    if (!a) return;
    a.requestCount += 1;
  }

  get strategy(): RoutingStrategy {
    return this.opts.strategy;
  }
}
