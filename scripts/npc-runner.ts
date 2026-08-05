import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { npcAgentToken } from "../lib/game/npc-auth";
import { createNpcController, type NpcController, type NpcDecision } from "../lib/game/npc-controller";
import type { NpcScheduleDirective } from "../lib/game/npc-schedule";
import { NPC_POPULATION, npcStableKey } from "../lib/game/npc-seed";
import type { ServerMessage } from "../lib/game/protocol";
import type { GameSnapshot } from "../lib/game/types";

const requestedCount = Number.parseInt(process.env.NPC_COUNT ?? String(NPC_POPULATION), 10);
const count = Math.max(1, Math.min(NPC_POPULATION, Number.isFinite(requestedCount) ? requestedCount : NPC_POPULATION));
const serverUrl = process.env.NPC_SERVER_URL ?? `ws://127.0.0.1:${process.env.PORT ?? 3000}/ws`;
const actors = new Set<NpcActor>();
type NpcDirectiveMessage = { type: "npc.directive"; directive: NpcScheduleDirective };

function stableJitter(index: number, phase: number, range: number) {
  if (range <= 1) return 0;
  let value = Math.imul(index + 1, 0x45d9f3b) ^ Math.imul(phase + 1, 0x119de1f3);
  value ^= value >>> 16;
  value = Math.imul(value, 0x45d9f3b);
  value ^= value >>> 16;
  return (value >>> 0) % range;
}

export function gameplayActorStartupDelayMs(index: number, population: number) {
  const safePopulation = Math.max(1, Math.floor(population));
  const safeIndex = Math.max(0, Math.min(safePopulation - 1, Math.floor(index)));
  const windowMs = Math.min(30_000, Math.max(2_000, safePopulation * 125));
  const slotMs = Math.max(1, Math.floor(windowMs / safePopulation));
  return Math.min(windowMs - 1, safeIndex * slotMs + stableJitter(safeIndex, 0, slotMs));
}

export function gameplayActorReconnectDelayMs(index: number, attempts: number, population: number) {
  const safePopulation = Math.max(1, Math.floor(population));
  const safeIndex = Math.max(0, Math.min(safePopulation - 1, Math.floor(index)));
  const safeAttempts = Math.max(1, Math.floor(attempts));
  const backoffMs = Math.min(1_000 * 2 ** Math.min(safeAttempts, 5), 30_000);
  const spreadWindowMs = Math.min(10_000, Math.max(1_000, safePopulation * 40));
  const slotMs = Math.max(1, Math.floor(spreadWindowMs / safePopulation));
  const stableOffsetMs = safeIndex * slotMs;
  return backoffMs + stableOffsetMs + stableJitter(safeIndex, safeAttempts, Math.min(250, Math.max(25, slotMs)));
}

class NpcActor {
  private socket: WebSocket | null = null;
  private snapshot: GameSnapshot | null = null;
  private directive: NpcScheduleDirective | null = null;
  private thinkTimer: ReturnType<typeof setTimeout> | null = null;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private awaitingSyncRequestId: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private stopped = false;

  constructor(private readonly index: number, private readonly mind: NpcController) {}

  get stableKey() { return npcStableKey(this.index); }

  start() {
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.thinkTimer) clearTimeout(this.thinkTimer);
    if (this.syncTimer) clearTimeout(this.syncTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close(1001, "NPC runner stopping");
  }

  private connect() {
    if (this.stopped) return;
    const socket = new WebSocket(serverUrl, { headers: { authorization: `Bearer ${npcAgentToken(this.stableKey)}` } });
    this.socket = socket;
    socket.on("open", () => { this.reconnectAttempts = 0; });
    socket.on("message", (raw) => this.receive(raw.toString()));
    socket.on("close", () => {
      this.socket = null;
      this.snapshot = null;
      this.directive = null;
      this.awaitingSyncRequestId = null;
      if (this.syncTimer) clearTimeout(this.syncTimer);
      this.syncTimer = null;
      if (this.stopped) return;
      this.reconnectAttempts += 1;
      const delay = gameplayActorReconnectDelayMs(this.index, this.reconnectAttempts, count);
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    });
    socket.on("error", () => socket.close());
  }

  private receive(raw: string) {
    let message: ServerMessage | NpcDirectiveMessage;
    try { message = JSON.parse(raw) as ServerMessage | NpcDirectiveMessage; } catch { return; }
    if (message.type === "npc.directive") {
      this.directive = message.directive;
      this.scheduleThink();
      return;
    }
    if (message.type === "snapshot") this.snapshot = message.snapshot;
    else if (this.snapshot && message.type === "self.updated") this.snapshot = { ...this.snapshot, self: message.player };
    else if (this.snapshot && message.type === "action.updated") this.snapshot = { ...this.snapshot, actionState: message.actionState };
    else if (this.snapshot && message.type === "inventory.updated") this.snapshot = { ...this.snapshot, inventory: message.inventory };
    else if (this.snapshot && message.type === "social.updated") this.snapshot = { ...this.snapshot, social: message.social };
    if ((message.type === "ack" || message.type === "error") && message.requestId === this.awaitingSyncRequestId) {
      this.awaitingSyncRequestId = null;
      if (this.syncTimer) clearTimeout(this.syncTimer);
      this.syncTimer = null;
      if (message.type === "ack") void this.decideFromFreshState();
      else this.scheduleThink();
      return;
    }
    if (["snapshot", "ack", "error", "action.updated"].includes(message.type)) this.scheduleThink();
  }

  private scheduleThink() {
    if (this.awaitingSyncRequestId) return;
    if (this.thinkTimer) clearTimeout(this.thinkTimer);
    const busy = this.snapshot?.actionState.current || (this.snapshot?.actionState.queued.length ?? 0) > 0;
    const delay = busy ? 30_000 : 8_000 + Math.floor(Math.random() * 12_000);
    this.thinkTimer = setTimeout(() => this.requestFreshState(), delay);
  }

  private requestFreshState() {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return this.scheduleThink();
    const requestId = randomUUID();
    this.awaitingSyncRequestId = requestId;
    socket.send(JSON.stringify({ type: "sync", requestId }));
    this.syncTimer = setTimeout(() => {
      if (this.awaitingSyncRequestId !== requestId) return;
      this.awaitingSyncRequestId = null;
      this.syncTimer = null;
      this.scheduleThink();
    }, 5_000);
  }

  private scheduledDecision(snapshot: GameSnapshot): NpcDecision | null {
    const directive = this.directive;
    if (!directive || directive.kind === "hold") return null;
    if (directive.kind === "move") return { type: "move", locationId: directive.locationId };
    if (directive.kind === "combat") return { type: "combat.start", targetPlayerId: directive.targetPlayerId };
    const action = snapshot.actionState.available.find((candidate) => (
      candidate.id === directive.actionId && candidate.available
    ));
    return action ? { type: "action.start", actionId: action.id } : null;
  }

  private async decideFromFreshState() {
    const socket = this.socket;
    const snapshot = this.snapshot;
    if (!socket || socket.readyState !== WebSocket.OPEN || !snapshot) return this.scheduleThink();
    try {
      let decision: NpcDecision | null;
      if (snapshot.self.defeated || snapshot.combat) {
        decision = await this.mind.decide({ actorId: snapshot.self.id, snapshot, serverTime: snapshot.world.serverTime });
      } else if (snapshot.actionState.current || snapshot.actionState.queued.length > 0) {
        decision = null;
      } else if (this.directive) {
        decision = this.scheduledDecision(snapshot);
      } else {
        decision = await this.mind.decide({ actorId: snapshot.self.id, snapshot, serverTime: snapshot.world.serverTime });
      }
      if (decision) socket.send(JSON.stringify({ ...decision, requestId: randomUUID() }));
    } catch (error) {
      console.error(`[npc-runner] controller error for ${this.stableKey}:`, error instanceof Error ? error.message : error);
    }
    this.scheduleThink();
  }
}

if (!process.env.VITEST) {
  const controller = createNpcController();
  for (let index = 0; index < count; index += 1) {
    const actor = new NpcActor(index, controller);
    actors.add(actor);
    setTimeout(() => actor.start(), gameplayActorStartupDelayMs(index, count));
  }

  console.log(`[npc-runner] starting ${count} isolated actors against ${serverUrl}`);

  const shutdown = () => {
    for (const actor of actors) actor.stop();
    setTimeout(() => process.exit(0), 250);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
