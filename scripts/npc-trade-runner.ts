import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { npcTradeAgentToken } from "../lib/game/npc-auth";
import { decideNpcTrade, normalizeNpcTradeStrategy, type NpcTradeInput, type NpcTradeStrategy } from "../lib/game/npc-trade";
import type { NpcTradeServerMessage } from "../lib/game/npc-trade-protocol";
import { NPC_POPULATION, npcStableKey } from "../lib/game/npc-seed";

const requestedCount = Number.parseInt(process.env.NPC_TRADE_COUNT ?? String(NPC_POPULATION), 10);
const count = Math.max(1, Math.min(NPC_POPULATION, Number.isFinite(requestedCount) ? requestedCount : NPC_POPULATION));
const intervalMs = Math.max(60_000, Number.parseInt(process.env.NPC_TRADE_INTERVAL_MS ?? "300000", 10) || 300_000);
const serverUrl = process.env.NPC_SERVER_URL ?? `ws://127.0.0.1:${process.env.PORT ?? 3000}/ws`;
const strategyUrl = process.env.NPC_TRADE_STRATEGY_URL;

class TradeActor {
  private socket: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private stopped = false;
  private externalAttempted = false;

  constructor(private readonly index: number) {}
  get playerId() { return npcStableKey(this.index); }

  start() { this.connect(); }
  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.socket?.close(1001, "NPC trade runner stopping");
  }

  private connect() {
    if (this.stopped) return;
    const socket = new WebSocket(serverUrl, {
      headers: { authorization: `Bearer ${npcTradeAgentToken(this.playerId)}` },
    });
    this.socket = socket;
    socket.on("open", () => {
      this.reconnectAttempts = 0;
      socket.send(JSON.stringify({ type: "agent.trade.strategy.get", requestId: randomUUID() }));
    });
    socket.on("message", (raw) => void this.receive(raw.toString()));
    socket.on("close", () => {
      this.socket = null;
      if (this.stopped) return;
      this.reconnectAttempts += 1;
      this.timer = setTimeout(() => this.connect(), Math.min(1_000 * 2 ** Math.min(5, this.reconnectAttempts), 30_000));
    });
    socket.on("error", () => socket.close());
  }

  private send(value: object) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(value));
  }

  private async externalStrategy(current: NpcTradeStrategy) {
    if (!strategyUrl || this.externalAttempted) return null;
    this.externalAttempted = true;
    try {
      const response = await fetch(strategyUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          stableKey: this.playerId,
          availableUnderlyings: ["rice", "tea", "silk", "salt", "wood", "iron", "paper", "medicine", "oil", "copper"],
          limits: { maxOrderQuantity: 20, maxOpenOrders: 20, cashReserveWen: 10_000_000 },
          currentVersion: current.version,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return null;
      const text = await response.text();
      if (Buffer.byteLength(text) > 32 * 1024) return null;
      return normalizeNpcTradeStrategy(JSON.parse(text) as unknown);
    } catch {
      return null;
    }
  }

  private scheduleCycle() {
    if (this.timer) clearTimeout(this.timer);
    const now = Date.now();
    const slot = Math.floor(now / intervalMs) + 1;
    const stagger = Math.floor((this.index * intervalMs) / count);
    const next = slot * intervalMs + stagger;
    this.timer = setTimeout(() => {
      this.send({ type: "agent.trade.context.create", requestId: randomUUID(), cycleKey: `${slot}:${this.playerId}` });
    }, Math.max(1_000, next - now));
  }

  private async receive(raw: string) {
    let message: NpcTradeServerMessage;
    try { message = JSON.parse(raw) as NpcTradeServerMessage; } catch { return; }
    if (message.type === "agent.trade.strategy") {
      const current = normalizeNpcTradeStrategy(message.strategy);
      const external = await this.externalStrategy(current);
      if (external) {
        this.send({ type: "agent.trade.strategy.install", requestId: randomUUID(), strategy: external });
        return;
      }
      this.send({
        type: "agent.trade.context.create", requestId: randomUUID(),
        cycleKey: `${Math.floor(Date.now() / intervalMs)}:${this.playerId}`,
      });
      return;
    }
    if (message.type === "agent.trade.context") {
      const strategy = normalizeNpcTradeStrategy(message.strategy);
      const output = decideNpcTrade(strategy, message.input as NpcTradeInput, message.rngSeed);
      this.send({
        type: "agent.trade.decision.submit", requestId: randomUUID(),
        decisionId: message.decisionId, output,
      });
      return;
    }
    if (message.type === "agent.trade.decision.result" || message.type === "error") this.scheduleCycle();
  }
}

const actors = Array.from({ length: count }, (_, index) => new TradeActor(index));
actors.forEach((actor, index) => setTimeout(() => actor.start(), index * 25));
console.log(`[npc-trade-runner] starting ${count} restricted actors against ${serverUrl}`);

function shutdown() {
  actors.forEach((actor) => actor.stop());
  setTimeout(() => process.exit(0), 250);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
