import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { getGameService, SESSION_COOKIE, SESSION_MAX_AGE } from "@/lib/game/service";

export const runtime = "nodejs";

function trustedExternalIdentity(request: NextRequest) {
  const expectedSecret = process.env.OIDC_PROXY_SECRET;
  const suppliedSecret = request.headers.get("x-wuxia-proxy-secret");
  if (!expectedSecret || !suppliedSecret) return null;
  const expected = Buffer.from(expectedSecret);
  const supplied = Buffer.from(suppliedSecret);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
  const subject = request.headers.get("x-wuxia-oidc-sub")?.trim();
  if (!subject) return null;
  const roleValue = request.headers.get("x-wuxia-oidc-role")?.trim().toLowerCase();
  const role = roleValue === "admin" || roleValue === "editor" ? roleValue : "player";
  return { provider: request.headers.get("x-wuxia-oidc-provider")?.trim() || "oidc", subject, role } as const;
}

export function GET(request: NextRequest) {
  const service = getGameService();
  const existing = service.getPlayerBySessionToken(request.cookies.get(SESSION_COOKIE)?.value);
  const external = trustedExternalIdentity(request);
  const identity = existing ? null : external
    ? service.createExternalSession(external.provider, external.subject, external.role)
    : service.createSession();
  const returnTo = request.nextUrl.searchParams.get("returnTo");
  const forwardedProtocol = request.headers.get("x-forwarded-proto") ?? request.nextUrl.protocol.replace(":", "");
  const forwardedHost = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? request.nextUrl.host;
  const publicOrigin = process.env.PUBLIC_ORIGIN?.replace(/\/$/, "") ?? `${forwardedProtocol}://${forwardedHost}`;
  let destination = new URL("/", publicOrigin);
  if (returnTo && !/[\\\u0000-\u001f\u007f]/.test(returnTo)) {
    try {
      const candidate = new URL(returnTo, publicOrigin);
      if (candidate.origin === destination.origin && candidate.pathname.startsWith("/")) destination = candidate;
    } catch {
      // Invalid or external return targets fall back to the home page.
    }
  }
  const response = NextResponse.redirect(destination);

  if (identity) {
    response.cookies.set(SESSION_COOKIE, identity.token, {
      httpOnly: true,
      sameSite: "lax",
      secure: request.nextUrl.protocol === "https:" || forwardedProtocol === "https",
      path: "/",
      maxAge: SESSION_MAX_AGE,
      priority: "high",
    });
  }

  return response;
}
