import { NextResponse } from "next/server";
import { getGameDatabase } from "@/lib/game/database";

export const runtime = "nodejs";

export function GET() {
  try {
    const database = getGameDatabase();
    const row = database.prepare("SELECT 1 AS ok").get() as { ok: number };
    return NextResponse.json({ status: row.ok === 1 ? "ok" : "degraded", database: row.ok === 1 ? "ready" : "unknown" }, {
      status: row.ok === 1 ? 200 : 503,
      headers: { "cache-control": "no-store" },
    });
  } catch {
    return NextResponse.json({ status: "unavailable", database: "unavailable" }, {
      status: 503,
      headers: { "cache-control": "no-store" },
    });
  }
}
