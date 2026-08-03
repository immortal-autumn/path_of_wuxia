import type { GameSnapshot } from "./types";

export type NpcDecision =
  | { type: "move"; locationId: string }
  | { type: "action.start"; actionId: string }
  | { type: "qinggong.start"; destinationId: string }
  | { type: "combat.choose"; combatId: string; choice: "attack" | "power" | "defend" | "flee" }
  | { type: "combat.respawn" }
  | { type: "loot.take"; lootPileId: string }
  | { type: "chat.send"; content: string };

export type NpcControllerContext = { actorId: string; snapshot: GameSnapshot; serverTime: string };

export interface NpcController {
  decide(context: NpcControllerContext): Promise<NpcDecision | null>;
}

function validDecision(value: unknown): value is NpcDecision {
  if (!value || typeof value !== "object" || !("type" in value)) return false;
  const decision = value as Record<string, unknown>;
  if (decision.type === "move") return typeof decision.locationId === "string";
  if (decision.type === "action.start") return typeof decision.actionId === "string";
  if (decision.type === "qinggong.start") return typeof decision.destinationId === "string";
  if (decision.type === "combat.respawn") return true;
  if (decision.type === "loot.take") return typeof decision.lootPileId === "string";
  if (decision.type === "chat.send") return typeof decision.content === "string" && decision.content.length >= 1 && decision.content.length <= 120;
  return decision.type === "combat.choose" && typeof decision.combatId === "string"
    && ["attack", "power", "defend", "flee"].includes(String(decision.choice));
}

export class UtilityNpcController implements NpcController {
  constructor(private readonly random: () => number = Math.random) {}

  async decide({ snapshot }: NpcControllerContext): Promise<NpcDecision | null> {
    if (snapshot.self.defeated) return { type: "combat.respawn" };
    if (snapshot.combat) {
      if (!snapshot.combat.selfTurn) return null;
      const healthRatio = snapshot.self.hp / Math.max(1, snapshot.self.maxHp);
      if (healthRatio < 0.25) return { type: "combat.choose", combatId: snapshot.combat.id, choice: "flee" };
      const choice = this.random() < 0.2 ? "defend" : this.random() < 0.25 ? "power" : "attack";
      return { type: "combat.choose", combatId: snapshot.combat.id, choice };
    }
    if (snapshot.actionState.current || snapshot.actionState.queued.length > 0) return null;
    if (snapshot.lootPiles.length > 0 && this.random() < 0.3) return { type: "loot.take", lootPileId: snapshot.lootPiles[0].id };

    const needActions: Array<[boolean, string[]]> = [
      [snapshot.self.needs.hydration < 30, ["action-drink-water"]],
      [snapshot.self.needs.satiety < 30, ["action-eat-meal"]],
      [snapshot.self.needs.fatigue > 75, ["action-sleep", "action-rest"]],
      [snapshot.self.needs.bladder > 75, ["action-use-toilet"]],
      [snapshot.self.needs.hygiene < 25, ["action-wash", "action-bathe"]],
    ];
    for (const [needed, ids] of needActions) {
      if (!needed) continue;
      const action = snapshot.actionState.available.find((candidate) => ids.includes(candidate.id) && candidate.available);
      if (action) return { type: "action.start", actionId: action.id };
    }
    const available = snapshot.actionState.available.filter((action) => action.available && !action.adult && action.durationSeconds <= 3600);
    if (available.length > 0 && this.random() < 0.55) {
      return { type: "action.start", actionId: available[Math.floor(this.random() * available.length)].id };
    }
    const neighbors = snapshot.routes.flatMap((route) => {
      if (route.fromLocation === snapshot.self.currentLocation) return [route.toLocation];
      if (route.toLocation === snapshot.self.currentLocation) return [route.fromLocation];
      return [];
    });
    if (neighbors.length > 0) return { type: "move", locationId: neighbors[Math.floor(this.random() * neighbors.length)] };
    return null;
  }
}

export class HttpNpcController implements NpcController {
  constructor(private readonly endpoint: string) {}

  async decide(context: NpcControllerContext): Promise<NpcDecision | null> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(context),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`External NPC controller returned ${response.status}.`);
    const value = await response.json() as unknown;
    if (value === null) return null;
    if (!validDecision(value)) throw new Error("External NPC controller returned a disallowed command.");
    return value;
  }
}

export function createNpcController() {
  return process.env.NPC_CONTROLLER_URL
    ? new HttpNpcController(process.env.NPC_CONTROLLER_URL)
    : new UtilityNpcController();
}
