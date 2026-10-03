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
}

export const DEFAULTS = {
  heartbeatSeconds: 30,
  authTimeoutMs: 5000,
  pushCoalesceSeconds: 5 * 60,
  expoPushUrl: 'https://exp.host/--/api/v2/push/send'
} as const

export interface Config {
  heartbeatMs: number
  authTimeoutMs: number
  pushCoalesceMs: number
  expoPushUrl: string
}

function positive(raw: string | undefined, fallback: number): number {
  const n = raw === undefined ? NaN : Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export function configOf(env: Env): Config {
  return {
    heartbeatMs: positive(env.HEARTBEAT_SECONDS, DEFAULTS.heartbeatSeconds) * 1000,
    authTimeoutMs: positive(env.AUTH_TIMEOUT_MS, DEFAULTS.authTimeoutMs),
    pushCoalesceMs: positive(env.PUSH_COALESCE_SECONDS, DEFAULTS.pushCoalesceSeconds) * 1000,
    expoPushUrl: env.EXPO_PUSH_URL || DEFAULTS.expoPushUrl
  }
}
