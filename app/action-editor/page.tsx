import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getGameService, SESSION_COOKIE } from "@/lib/game/service";
import ActionRuleEditor from "./rule-editor";
import "./action-editor.css";

export default async function ActionEditorPage() {
  const cookieStore = await cookies();
  const service = getGameService();
  const player = service.getPlayerBySessionToken(cookieStore.get(SESSION_COOKIE)?.value);
  if (!player) redirect("/api/session?returnTo=/action-editor");
  if (!service.canEditWorld(player.id)) redirect("/?notice=editor-forbidden");
  return <ActionRuleEditor initialRules={service.getActionRuleSnapshot()} />;
}
