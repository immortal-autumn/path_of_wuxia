import { isIP } from "node:net";

export const INTERNAL_CLIENT_ADDRESS_HEADER = "x-wuxia-client-address";
export const SESSION_RATE_WINDOW_MS = 60_000;
export const SESSION_RATE_LIMIT = 30;
export const SESSION_RATE_MAX_KEYS = 10_000;

type HeaderReader = Pick<Headers, "get">;

function normalizedIp(value: string | null | undefined) {
  const candidate = value?.trim();
  if (!candidate || candidate.length > 120 || isIP(candidate) === 0) return null;
  return candidate;
}

export function trustProxyHeaders(environment: Readonly<Record<string, string | undefined>> = process.env) {
  const value = environment.TRUST_PROXY?.trim().toLowerCase();
  return value === "1" || value === "true";
}

export function requestClientAddress(headers: HeaderReader, trustProxy = trustProxyHeaders()) {
  if (trustProxy) {
    const forwarded = headers.get("x-forwarded-for")?.split(",", 1)[0];
    const proxyAddress = normalizedIp(forwarded) ?? normalizedIp(headers.get("x-real-ip"));
    if (proxyAddress) return proxyAddress;
  }
  return normalizedIp(headers.get(INTERNAL_CLIENT_ADDRESS_HEADER)) ?? "unknown";
}

type SessionAttempt = { windowStartedAt: number; count: number };

export class SessionCreationLimiter {
  private readonly attempts = new Map<string, SessionAttempt>();
  private nextSweepAt = 0;

  constructor(
    private readonly limit = SESSION_RATE_LIMIT,
    private readonly windowMs = SESSION_RATE_WINDOW_MS,
    private readonly maxKeys = SESSION_RATE_MAX_KEYS,
  ) {
    if (limit < 1 || windowMs < 1 || maxKeys < 1) throw new RangeError("Invalid session limiter configuration");
  }

  get size() {
    return this.attempts.size;
  }

  allow(key: string, now = Date.now()) {
    if (now >= this.nextSweepAt) this.sweep(now);
    const current = this.attempts.get(key);
    if (!current || now - current.windowStartedAt >= this.windowMs) {
      if (!current) this.ensureCapacity();
      this.attempts.set(key, { windowStartedAt: now, count: 1 });
      return true;
    }
    current.count += 1;
    return current.count <= this.limit;
  }

  private sweep(now: number) {
    for (const [key, attempt] of this.attempts) {
      if (now - attempt.windowStartedAt >= this.windowMs) this.attempts.delete(key);
    }
    this.nextSweepAt = now + this.windowMs;
  }

  private ensureCapacity() {
    while (this.attempts.size >= this.maxKeys) {
      const oldestKey = this.attempts.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      this.attempts.delete(oldestKey);
    }
  }
}
