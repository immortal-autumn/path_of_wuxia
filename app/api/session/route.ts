import { NextResponse, type NextRequest } from "next/server";
import { getGameService, SESSION_COOKIE, SESSION_MAX_AGE } from "@/lib/game/service";

export const runtime = "nodejs";

export function GET(request: NextRequest) {
  const service = getGameService();
  const existing = service.getPlayerBySessionToken(request.cookies.get(SESSION_COOKIE)?.value);
  const identity = existing ? null : service.createSession();
  const returnTo = request.nextUrl.searchParams.get("returnTo");
  const safeReturnTo = returnTo?.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/";
  const response = NextResponse.redirect(new URL(safeReturnTo, request.url));

  if (identity) {
    const forwardedProtocol = request.headers.get("x-forwarded-proto");
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
