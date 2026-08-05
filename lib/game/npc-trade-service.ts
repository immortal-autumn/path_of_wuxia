import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { inTransaction } from "./database";
import { MarketEngine } from "./market";
import {
  canonicalJson,
  decideNpcTrade,
  fallbackNpcTradeStrategy,
  normalizeNpcTradeStrategy,
  npcTradeReplaySeed,
  npcTradeStrategyHash,
  type NpcTradeDecision,
  type NpcTradeInput,
} from "./npc-trade";

type StrategyRow = {
  id: string; player_id: string; version: number; source: "builtin" | "http";
  strategy_json: string; strategy_hash: string;
};

type DecisionRow = {
  id: string; player_id: string; strategy_id: string; strategy_hash: string;
  input_snapshot_json: string; input_snapshot_hash: string; rng_seed: string;
  output_json: string | null; output_hash: string | null; request_id: string; status: string;
};

function hashJson(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export class NpcTradeAgentService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private assertTradeActor(playerId: string) {
    if (!this.db.prepare("SELECT 1 FROM npc_profiles WHERE player_id=?").get(playerId)) {
      throw new Error("商贸代理身份不存在。");
    }
  }

  ensureStrategy(playerId: string) {
    this.assertTradeActor(playerId);
    let row = this.db.prepare(`
      SELECT id,player_id,version,source,strategy_json,strategy_hash
      FROM npc_trade_strategies WHERE player_id=? AND active=1
    `).get(playerId) as StrategyRow | undefined;
    if (!row) {
      const strategy = fallbackNpcTradeStrategy(playerId);
      const json = canonicalJson(strategy);
      const hash = npcTradeStrategyHash(strategy);
      const at = this.now().toISOString();
      const version = (this.db.prepare(`
        SELECT COALESCE(MAX(version),0)+1 AS version FROM npc_trade_strategies WHERE player_id=?
      `).get(playerId) as { version: number }).version;
      row = {
        id: `npc-trade-strategy-${playerId}-${version}`, player_id: playerId, version,
        source: "builtin", strategy_json: json, strategy_hash: hash,
      };
      this.db.prepare(`
        INSERT INTO npc_trade_strategies(
          id,player_id,version,schema_version,source,strategy_json,strategy_hash,active,created_at
        ) VALUES (?,?,?,1,'builtin',?,?,1,?)
      `).run(row.id, playerId, version, json, hash, at);
    }
    return {
      id: row.id, version: row.version, source: row.source,
      strategy: normalizeNpcTradeStrategy(JSON.parse(row.strategy_json)), strategyHash: row.strategy_hash,
    };
  }

  installStrategy(playerId: string, strategyValue: unknown) {
    this.assertTradeActor(playerId);
    const strategy = normalizeNpcTradeStrategy(strategyValue);
    const hash = npcTradeStrategyHash(strategy);
    const active = this.ensureStrategy(playerId);
    if (active.strategyHash === hash) return active;
    const at = this.now().toISOString();
    const version = (this.db.prepare(`
      SELECT COALESCE(MAX(version),0)+1 AS version FROM npc_trade_strategies WHERE player_id=?
    `).get(playerId) as { version: number }).version;
    const id = `npc-trade-strategy-${playerId}-${version}`;
    this.db.prepare("UPDATE npc_trade_strategies SET active=0,retired_at=? WHERE player_id=? AND active=1")
      .run(at, playerId);
    this.db.prepare(`
      INSERT INTO npc_trade_strategies(
        id,player_id,version,schema_version,source,strategy_json,strategy_hash,active,created_at
      ) VALUES (?,?,?,1,'http',?,?,1,?)
    `).run(id, playerId, version, canonicalJson(strategy), hash, at);
    return { id, version, source: "http" as const, strategy, strategyHash: hash };
  }

  createContext(playerId: string, cycleKey: string) {
    this.assertTradeActor(playerId);
    const replay = this.db.prepare(`
      SELECT id FROM npc_trade_decisions WHERE player_id=? AND cycle_key=?
    `).get(playerId, cycleKey) as { id: string } | undefined;
    if (replay) return this.readContext(playerId, replay.id);
    const strategy = this.ensureStrategy(playerId);
    const engine = new MarketEngine(this.db, this.now);
    const hasMarket = this.db.prepare("SELECT 1 FROM market_contracts WHERE status='active' LIMIT 1").get();
    if (!hasMarket) engine.settle();
    const market = engine.snapshot(playerId, false);
    const strategyUnderlyings = new Set(strategy.strategy.underlyings);
    const strategyContractIds = new Set(market.contracts
      .filter((contract) => contract.kind === "spot" && strategyUnderlyings.has(contract.underlyingId))
      .map((contract) => contract.id));
    const cash = (this.db.prepare("SELECT cash_wen FROM player_wallets WHERE player_id=?").get(playerId) as { cash_wen: number }).cash_wen;
    const reservedSells = new Map<string, number>();
    for (const order of market.orders) {
      if (order.side === "sell") reservedSells.set(order.contractId, (reservedSells.get(order.contractId) ?? 0) + order.remainingQuantity);
    }
    const input: NpcTradeInput = {
      actorId: playerId,
      asOf: market.asOf,
      availableCashWen: Math.max(0, cash - market.reservedMarginWen),
      clearingDebtWen: market.clearingDebtWen,
      quotes: market.contracts.filter((contract) => strategyContractIds.has(contract.id)).map((contract) => ({
        contractId: contract.id, underlyingId: contract.underlyingId, kind: contract.kind,
        markPriceWen: contract.markPriceWen, bestBidWen: contract.bestBidWen, bestAskWen: contract.bestAskWen,
      })),
      positions: market.positions.filter((position) => strategyContractIds.has(position.contractId)).map((position) => ({
        contractId: position.contractId,
        quantity: Math.max(0, position.quantity - (reservedSells.get(position.contractId) ?? 0)),
      })),
      openOrders: market.orders.map((order) => ({
        id: order.id, contractId: order.contractId, side: order.side,
        limitPriceWen: order.limitPriceWen, remainingQuantity: order.remainingQuantity, createdAt: order.createdAt,
      })),
    };
    const sequence = (this.db.prepare(`
      SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM npc_trade_decisions WHERE player_id=?
    `).get(playerId) as { sequence: number }).sequence;
    const decisionId = randomUUID();
    const inputJson = canonicalJson(input);
    const rngSeed = npcTradeReplaySeed(playerId, strategy.strategyHash, input);
    const at = this.now().toISOString();
    this.db.prepare(`
      INSERT INTO npc_trade_decisions(
        id,player_id,sequence,cycle_key,strategy_id,strategy_hash,input_snapshot_json,input_snapshot_hash,
        rng_seed,request_id,status,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?)
    `).run(
      decisionId, playerId, sequence, cycleKey, strategy.id, strategy.strategyHash,
      inputJson, hashJson(input), rngSeed, `npc-trade:${decisionId}`, at,
    );
    return { decisionId, strategy: strategy.strategy, strategyHash: strategy.strategyHash, input, rngSeed };
  }

  private readContext(playerId: string, decisionId: string) {
    const row = this.db.prepare(`
      SELECT decision.id,decision.player_id,decision.strategy_id,decision.strategy_hash,
        decision.input_snapshot_json,decision.input_snapshot_hash,decision.rng_seed,
        decision.output_json,decision.output_hash,decision.request_id,decision.status,
        strategy.strategy_json
      FROM npc_trade_decisions decision JOIN npc_trade_strategies strategy ON strategy.id=decision.strategy_id
      WHERE decision.id=? AND decision.player_id=?
    `).get(decisionId, playerId) as (DecisionRow & { strategy_json: string }) | undefined;
    if (!row) throw new Error("商贸决策记录不存在。");
    return {
      decisionId: row.id,
      strategy: normalizeNpcTradeStrategy(JSON.parse(row.strategy_json)),
      strategyHash: row.strategy_hash,
      input: JSON.parse(row.input_snapshot_json) as NpcTradeInput,
      rngSeed: row.rng_seed,
    };
  }

  submitDecision(playerId: string, decisionId: string, outputValue: unknown) {
    const row = this.db.prepare(`
      SELECT decision.id,decision.player_id,decision.strategy_id,decision.strategy_hash,
        decision.input_snapshot_json,decision.input_snapshot_hash,decision.rng_seed,
        decision.output_json,decision.output_hash,decision.request_id,decision.status,
        strategy.strategy_json
      FROM npc_trade_decisions decision JOIN npc_trade_strategies strategy ON strategy.id=decision.strategy_id
      WHERE decision.id=? AND decision.player_id=?
    `).get(decisionId, playerId) as (DecisionRow & { strategy_json: string }) | undefined;
    if (!row) throw new Error("商贸决策记录不存在。");
    const strategy = normalizeNpcTradeStrategy(JSON.parse(row.strategy_json));
    const input = JSON.parse(row.input_snapshot_json) as NpcTradeInput;
    if (npcTradeStrategyHash(strategy) !== row.strategy_hash || hashJson(input) !== row.input_snapshot_hash) {
      throw new Error("商贸决策审计哈希不一致。");
    }
    const expected = decideNpcTrade(strategy, input, row.rng_seed);
    if (canonicalJson(expected) !== canonicalJson(outputValue)) throw new Error("提交的商贸决策无法由已存输入复演。");
    const output = expected as NpcTradeDecision;
    const outputJson = canonicalJson(output);
    const outputHash = hashJson(output);
    const at = this.now().toISOString();
    if (row.output_json) {
      if (row.output_json !== outputJson) throw new Error("商贸决策输出已经改变。");
      if (row.status !== "ready") return { decisionId, status: row.status, message: "这项商贸决策已经处理。" };
    }
    if (output.type === "hold") {
      inTransaction(this.db, () => {
        this.db.prepare(`
          UPDATE npc_trade_decisions SET output_json=?,output_hash=?,status='skipped',decided_at=COALESCE(decided_at,?),executed_at=?
          WHERE id=?
        `).run(outputJson, outputHash, at, at, decisionId);
      });
      return { decisionId, status: "skipped", message: "本轮商贸代理选择观望。" };
    }
    try {
      inTransaction(this.db, () => {
        this.db.prepare(`
          UPDATE npc_trade_decisions SET output_json=?,output_hash=?,status='ready',decided_at=COALESCE(decided_at,?) WHERE id=?
        `).run(outputJson, outputHash, at, decisionId);
        const engine = new MarketEngine(this.db, this.now);
        if (output.type === "market.order.place") {
          engine.placeOrder(playerId, row.request_id, output.contractId, output.side, output.limitPriceWen, output.quantity);
        } else {
          engine.cancelOrder(playerId, row.request_id, output.orderId);
        }
        this.db.prepare("UPDATE npc_trade_decisions SET status='executed',executed_at=? WHERE id=?").run(at, decisionId);
      });
      return { decisionId, status: "executed", message: "商贸决策已经按普通市场规则执行。" };
    } catch (error) {
      const message = error instanceof Error ? error.message : "市场拒绝商贸决策。";
      inTransaction(this.db, () => {
        this.db.prepare(`
          UPDATE npc_trade_decisions SET output_json=?,output_hash=?,status='rejected',error_text=?,
            decided_at=COALESCE(decided_at,?),executed_at=? WHERE id=?
        `).run(outputJson, outputHash, message, at, at, decisionId);
      });
      throw error;
    }
  }

  recoverReadyDecisions() {
    const rows = this.db.prepare(`
      SELECT id,player_id,output_json FROM npc_trade_decisions WHERE status='ready' ORDER BY created_at,id LIMIT 240
    `).all() as Array<{ id: string; player_id: string; output_json: string }>;
    for (const row of rows) {
      try { this.submitDecision(row.player_id, row.id, JSON.parse(row.output_json)); } catch { /* rejection is persisted */ }
    }
    return rows.length;
  }
}
