/**
 * Shared types for the Kiro router.
 */

/** Auth method for a Kiro account. */
export type AuthMethod = "builder-id" | "idc" | "social" | "imported";

/** Per-account state machine. */
export type AccountState =
  | "healthy" /* Ready for requests. */
  | "refreshing" /* Token refresh in flight. */
  | "cooling" /* Hit rate-limit; cooling_until is in the future. */
  | "expired" /* Access token expired AND refresh failed once; will retry. */
  | "terminal"; /* Refresh token invalid / banned. Won't retry without operator action. */

/** Persisted account record (also used in-memory). */
export interface KiroAccount {
  /** Stable ID for this account (file name or generated). */
  id: string;
  /** Human-readable label (email when discoverable). */
  label: string;
  /** Auth method. AWS SSO (Builder ID / IDC) or social (Cognito). */
  authMethod: AuthMethod;
  /** Long-lived refresh token (starts with `aorAAAAAG`). */
  refreshToken: string;
  /** Current access token, if any. */
  accessToken: string | null;
  /** Unix epoch (ms) when accessToken expires. 0 if unknown. */
  expiresAt: number;
  /** AWS region (e.g. us-east-1). */
  region: string;
  /** Optional clientId from AWS SSO OIDC registration (Builder ID / IDC). */
  clientId: string | null;
  /** Optional clientSecret from AWS SSO OIDC registration. */
  clientSecret: string | null;
  /** Optional profileArn (for IDC enterprise users). */
  profileArn: string | null;
  /** Source file path (when discovered from disk). */
  sourcePath: string | null;
  /** Current state. */
  state: AccountState;
  /** Last error message, if any. */
  lastError: string | null;
  /** Unix epoch (ms) until which this account is in cool-down. */
  coolingUntil: number;
  /** Failure counter for exponential backoff. Reset on success. */
  failureCount: number;
  /** Monotonic request counter for round-robin / least-used routing. */
  requestCount: number;
  /** Monotonic success counter. */
  successCount: number;
  /** Priority (lower = preferred). Default 100. */
  priority: number;
  /** Whether this account has been disabled by the operator. */
  disabled: boolean;
}

/** Outcome from a refresh call. */
export interface RefreshResult {
  accessToken: string;
  /** New refresh token, if rotated. May equal the old one. */
  refreshToken: string;
  expiresIn: number;
  profileArn?: string;
}

/** Standard Kiro model id catalog. */
export const KIRO_MODELS = [
  "claude-haiku-4.5",
  "claude-sonnet-4.5",
  "claude-sonnet-4.6",
  "claude-opus-4.6",
  "claude-opus-4.7",
] as const;

export type KiroModelId = (typeof KIRO_MODELS)[number];
