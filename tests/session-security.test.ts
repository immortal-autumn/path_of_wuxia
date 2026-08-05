import { describe, expect, it } from "vitest";
import {
  INTERNAL_CLIENT_ADDRESS_HEADER,
  requestClientAddress,
  SessionCreationLimiter,
  trustProxyHeaders,
} from "../lib/game/session-security";

describe("session creation security", () => {
  it("uses the server connection address and ignores spoofed proxy headers by default", () => {
    const headers = new Headers({
      [INTERNAL_CLIENT_ADDRESS_HEADER]: "127.0.0.1",
      "x-forwarded-for": "198.51.100.42",
      "x-real-ip": "203.0.113.9",
    });
    expect(requestClientAddress(headers, false)).toBe("127.0.0.1");
  });

  it("accepts a valid leftmost proxy address only when proxy trust is explicit", () => {
    const headers = new Headers({
      [INTERNAL_CLIENT_ADDRESS_HEADER]: "10.0.0.8",
      "x-forwarded-for": "198.51.100.42, 10.0.0.8",
    });
    expect(requestClientAddress(headers, true)).toBe("198.51.100.42");
    expect(trustProxyHeaders({ TRUST_PROXY: "true" })).toBe(true);
    expect(trustProxyHeaders({ TRUST_PROXY: "false" })).toBe(false);
  });

  it("falls back safely when address headers are absent or malformed", () => {
    expect(requestClientAddress(new Headers({ "x-forwarded-for": "not-an-ip" }), true)).toBe("unknown");
    expect(requestClientAddress(new Headers({
      [INTERNAL_CLIENT_ADDRESS_HEADER]: "::ffff:127.0.0.1",
      "x-forwarded-for": "not-an-ip",
    }), true)).toBe("::ffff:127.0.0.1");
  });

  it("enforces a fixed window, expires stale keys, and bounds cardinality", () => {
    const limiter = new SessionCreationLimiter(2, 1_000, 2);
    expect(limiter.allow("first", 0)).toBe(true);
    expect(limiter.allow("first", 1)).toBe(true);
    expect(limiter.allow("first", 2)).toBe(false);
    expect(limiter.allow("second", 3)).toBe(true);
    expect(limiter.allow("third", 4)).toBe(true);
    expect(limiter.size).toBe(2);
    expect(limiter.allow("first", 5)).toBe(true);
    expect(limiter.size).toBe(2);
    expect(limiter.allow("fresh", 1_005)).toBe(true);
    expect(limiter.size).toBe(1);
  });
});
