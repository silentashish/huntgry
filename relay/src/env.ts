/**
 * Bindings and tunables of the relay Worker (wrangler.toml `[vars]`, `wrangler secret put ADMIN_TOKEN`).
 * Every tunable has the ADR default; tests lower them to run in seconds.
 */
export interface Env {
  ROOM: DurableObjectNamespace
  /** `wrangler secret put ADMIN_TOKEN`; required by `POST /rooms`. Unset: room creation is refused. */
  ADMIN_TOKEN?: string
  /** The desktop's `status` heartbeat period; it counts as offline after two missed ones. Default 30. */
  HEARTBEAT_SECONDS?: string
  /** A socket that has not sent its `auth` frame within this time is closed. Default 5000. */
  AUTH_TIMEOUT_MS?: string
  /** At most one push per category per device in this window. Default 300. */
  PUSH_COALESCE_SECONDS?: string
  /** Expo push endpoint; tests point it at a fake. */
  EXPO_PUSH_URL?: string
  /** Expo receipts endpoint. */
  EXPO_RECEIPTS_URL?: string
  /** How long after a push its receipt is looked up (Expo suggests about 15 min). Default 900. */
  PUSH_RECEIPT_DELAY_SECONDS?: string
  /** Waits before each retry of a transiently failed push, comma-separated seconds; their count is the retry budget. Default "30,120,480". */
  PUSH_RETRY_DELAYS_SECONDS?: string
}

export const DEFAULTS = {
  heartbeatSeconds: 30,
  authTimeoutMs: 5000,
  pushCoalesceSeconds: 5 * 60,
  expoPushUrl: 'https://exp.host/--/api/v2/push/send',
  expoReceiptsUrl: 'https://exp.host/--/api/v2/push/getReceipts',
  pushReceiptDelaySeconds: 15 * 60,
  pushRetryDelaysSeconds: [30, 120, 480]
} as const

export interface Config {
  heartbeatMs: number
  authTimeoutMs: number
  pushCoalesceMs: number
  expoPushUrl: string
  expoReceiptsUrl: string
  pushReceiptDelayMs: number
  /** One entry per retry: the wait before it. */
  pushRetryDelaysMs: number[]
}

function positive(raw: string | undefined, fallback: number): number {
  const n = raw === undefined ? NaN : Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** `"30,120,480"` → `[30, 120, 480]`; anything malformed falls back to the default; `""` means no retries. */
function delays(raw: string | undefined, fallback: readonly number[]): number[] {
  if (raw === undefined) return [...fallback]
  if (raw.trim() === '') return []
  const parts = raw.split(',').map((p) => Number(p.trim()))
  return parts.length <= 10 && parts.every((n) => Number.isFinite(n) && n > 0) ? parts : [...fallback]
}

export function configOf(env: Env): Config {
  return {
    heartbeatMs: positive(env.HEARTBEAT_SECONDS, DEFAULTS.heartbeatSeconds) * 1000,
    authTimeoutMs: positive(env.AUTH_TIMEOUT_MS, DEFAULTS.authTimeoutMs),
    pushCoalesceMs: positive(env.PUSH_COALESCE_SECONDS, DEFAULTS.pushCoalesceSeconds) * 1000,
    expoPushUrl: env.EXPO_PUSH_URL || DEFAULTS.expoPushUrl,
    expoReceiptsUrl: env.EXPO_RECEIPTS_URL || DEFAULTS.expoReceiptsUrl,
    pushReceiptDelayMs: positive(env.PUSH_RECEIPT_DELAY_SECONDS, DEFAULTS.pushReceiptDelaySeconds) * 1000,
    pushRetryDelaysMs: delays(env.PUSH_RETRY_DELAYS_SECONDS, DEFAULTS.pushRetryDelaysSeconds).map((s) => s * 1000)
  }
}
