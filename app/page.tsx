import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import GameShell from "./game-shell";
import { getGameService, SESSION_COOKIE } from "@/lib/game/service";

export default async function Home() {
  const cookieStore = await cookies();
  const service = getGameService();
  const player = service.getPlayerBySessionToken(cookieStore.get(SESSION_COOKIE)?.value);

  if (!player) redirect("/api/session?returnTo=/");

  const snapshot = service.getSnapshot(player.id, [player.id]);
  return <GameShell initialSnapshot={snapshot} />;
}
