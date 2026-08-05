import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getGameService, SESSION_COOKIE } from "@/lib/game/service";
import MapEditorShell from "./map-editor-shell";

export default async function MapEditorPage() {
  const cookieStore = await cookies();
  const service = getGameService();
  const player = service.getPlayerBySessionToken(cookieStore.get(SESSION_COOKIE)?.value);
  if (!player) redirect("/api/session?returnTo=/map-editor");
  if (!service.canEditWorld(player.id)) redirect("/?notice=editor-forbidden");

  return (
    <MapEditorShell
      player={player}
      initialViewport={service.getMapViewport("world-root", 0, 0, 1, 1)}
      initialLocks={service.getActiveLocks()}
    />
  );
}
