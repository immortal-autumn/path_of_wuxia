import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openGameDatabase, type GameDatabase } from "../lib/game/database";
import { MarketEngine } from "../lib/game/market";
import { npcAgentToken, npcTradeAgentToken } from "../lib/game/npc-auth";
import { resolveNpcAgentDirective } from "../lib/game/npc-schedule";
import { decideNpcTrade } from "../lib/game/npc-trade";
import { NpcTradeAgentService } from "../lib/game/npc-trade-service";
import { GameService } from "../lib/game/service";

describe("restricted reproducible NPC trade agents", () => {
  let db: GameDatabase;
  let clock: Date;

  beforeEach(() => {
    db = openGameDatabase(":memory:");
    clock = new Date("2026-08-04T04:00:00.000Z");
  });

  afterEach(() => db.close());

  it("seeds separate gameplay and market-trade credentials", () => {
    const service = new GameService(db, () => new Date(clock), () => 0);
    expect(service.getAgentIdentityByToken(npcAgentToken("npc-001"))?.scope).toBe("gameplay");
    expect(service.getAgentIdentityByToken(npcTradeAgentToken("npc-001"))?.scope).toBe("market-trade");
    expect(service.getPlayerByAgentToken(npcTradeAgentToken("npc-001"))).toBeNull();
    expect(db.prepare(`
      SELECT scope,COUNT(*) AS count FROM agent_credentials GROUP BY scope ORDER BY scope
    `).all()).toEqual([
      { scope: "gameplay", count: 240 },
      { scope: "market-trade", count: 240 },
    ]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM npc_trade_strategies WHERE active=1").get()).toEqual({ count: 240 });
  });

  it("persists immutable strategy/input/seed/output and replays a decision exactly once", () => {
    const agents = new NpcTradeAgentService(db, () => new Date(clock));
    const firstStrategy = agents.ensureStrategy("npc-001");
    expect(agents.ensureStrategy("npc-001")).toEqual(firstStrategy);
    expect(db.prepare("SELECT COUNT(*) AS count FROM npc_trade_strategies WHERE player_id='npc-001' AND active=1").get())
      .toEqual({ count: 1 });

    const context = agents.createContext("npc-001", "cycle-1");
    expect(agents.createContext("npc-001", "cycle-1").decisionId).toBe(context.decisionId);
    const output = decideNpcTrade(context.strategy, context.input, context.rngSeed);
    const result = agents.submitDecision("npc-001", context.decisionId, output);
    expect(["executed", "skipped"]).toContain(result.status);
    expect(agents.submitDecision("npc-001", context.decisionId, output).status).toBe(result.status);
    const persisted = db.prepare(`
      SELECT strategy_hash,input_snapshot_hash,rng_seed,output_json,output_hash,status
      FROM npc_trade_decisions WHERE id=?
    `).get(context.decisionId) as Record<string, unknown>;
    expect(persisted.strategy_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(persisted.input_snapshot_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(persisted.rng_seed).toMatch(/^[a-f0-9]{64}$/);
    expect(persisted.output_json).toBeTruthy();
    expect(persisted.output_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(() => agents.submitDecision("npc-001", context.decisionId, { type: "hold", reason: "no-market" }))
      .toThrow("无法由已存输入复演");
  });

  it("keeps exactly 100 active instruments and makes cancellation request replay harmless", () => {
    const engine = new MarketEngine(db, () => new Date(clock));
    engine.snapshot("npc-001");
    expect(db.prepare("SELECT COUNT(*) AS count FROM market_contracts WHERE status='active'").get()).toEqual({ count: 100 });
    clock = new Date(clock.getTime() + 31 * 86_400_000);
    engine.snapshot("npc-001");
    expect(db.prepare("SELECT COUNT(*) AS count FROM market_contracts WHERE status='active'").get()).toEqual({ count: 100 });

    const market = engine.snapshot("npc-001");
    const spot = market.contracts.find((contract) => contract.kind === "spot")!;
    engine.placeOrder("npc-001", "resting-order", spot.id, "buy", 1, 1);
    const orderId = engine.snapshot("npc-001").orders.find((order) => order.contractId === spot.id)!.id;
    expect(engine.cancelOrder("npc-001", "cancel-order", orderId).message).toContain("已取消");
    expect(engine.cancelOrder("npc-001", "cancel-order", orderId).message).toContain("已经取消");
  });

  it("advances minute marks through the location-independent settlement service", () => {
    const service = new GameService(db, () => new Date(clock), () => 0);
    service.settleMarket();
    expect(db.prepare("SELECT COUNT(*) AS count FROM market_ticks").get()).toEqual({ count: 10 });
    clock = new Date(clock.getTime() + 60_000);
    service.settleMarket();
    expect(db.prepare("SELECT COUNT(*) AS count FROM market_ticks").get()).toEqual({ count: 20 });
  });

  it("reserves cash across instruments so retail and another order cannot spend it twice", () => {
    const engine = new MarketEngine(db, () => new Date(clock));
    const service = new GameService(db, () => new Date(clock), () => 0);
    const market = engine.snapshot("npc-001");
    const spots = market.contracts.filter((contract) => contract.kind === "spot");
    const cash = service.getPlayer("npc-001").cashWen;
    engine.placeOrder("npc-001", "reserve-most-cash", spots[0].id, "buy", 1, cash - 1);
    expect(() => engine.placeOrder("npc-001", "overcommit-cash", spots[1].id, "buy", 1, 2))
      .toThrow("钱贯不足");
    const assignment = db.prepare("SELECT shop_id FROM npc_assignments WHERE player_id='npc-001'")
      .get() as { shop_id: string };
    const stock = db.prepare(`
      SELECT item_definition_id FROM shop_stock WHERE shop_id=? AND quantity>0 AND buy_price_wen>1 ORDER BY item_definition_id LIMIT 1
    `).get(assignment.shop_id) as { item_definition_id: string };
    expect(() => service.buyFromShop(
      "npc-001", "reserved-retail", assignment.shop_id, stock.item_definition_id, 1,
    )).toThrow("市场订单或保证金预留");
  });
});

describe("Kaifeng law and delayed NPC return", () => {
  let db: GameDatabase;
  let service: GameService;
  let clock: Date;

  beforeEach(() => {
    db = openGameDatabase(":memory:");
    clock = new Date("2026-08-04T04:00:00.000Z");
    service = new GameService(db, () => new Date(clock), () => 0);
  });

  afterEach(() => db.close());

  it("adds assault/defeat/robbery law incidents, refuses shops, and settles surrender atomically", () => {
    const player = service.createSession().player;
    const npcId = "npc-001";
    const location = service.getPlayer(npcId).currentLocation;
    db.prepare("UPDATE players SET current_location=? WHERE id=?").run(location, player.id);
    db.prepare("UPDATE players SET hp=1 WHERE id=?").run(npcId);
    const shopId = (db.prepare("SELECT shop_id FROM npc_assignments WHERE player_id=?").get(npcId) as { shop_id: string }).shop_id;
    const shopBefore = db.prepare("SELECT till_wen FROM shops WHERE id=?").get(shopId);
    const stockBefore = db.prepare("SELECT SUM(quantity) AS quantity FROM shop_stock WHERE shop_id=?").get(shopId);

    const combat = service.startCombat(player.id, npcId);
    expect(service.getLawState(player.id).wantedPoints).toBe(20);
    expect(service.inspectShop(player.id, shopId)).toMatchObject({ serviceAvailable: false });
    service.chooseCombatAction(player.id, combat.combatId, "attack");
    expect(service.getLawState(player.id).wantedPoints).toBe(70);
    expect(() => service.buyFromShop(player.id, "wanted-buy", shopId, "rice", 1)).toThrow("拒绝");
    const loot = service.getLootPiles(location)[0];
    service.takeLoot(player.id, loot.id);
    expect(service.getLawState(player.id)).toMatchObject({ wantedPoints: 120, shopRefused: true, pursuitActive: true });
    expect(() => service.respawnPlayer(npcId)).toThrow("十分钟后");
    expect(service.settleDueNpcRespawns()).toEqual([]);

    clock = new Date(clock.getTime() + 10 * 60_000);
    expect(service.settleDueNpcRespawns()).toEqual([npcId]);
    expect(service.getPlayer(npcId)).toMatchObject({ defeated: false });
    expect(db.prepare("SELECT till_wen FROM shops WHERE id=?").get(shopId)).toEqual(shopBefore);
    expect(db.prepare("SELECT SUM(quantity) AS quantity FROM shop_stock WHERE shop_id=?").get(shopId)).toEqual(stockBefore);

    db.prepare("UPDATE players SET current_location='kaifeng-prefecture-main-hall' WHERE id=?").run(player.id);
    const beforeCash = service.getPlayer(player.id).cashWen;
    expect(service.getLawState(player.id)).toMatchObject({ canSurrender: true, fineWen: 12_000 });
    const surrendered = service.surrenderToLaw(player.id, "surrender-1");
    expect(surrendered.player.law.wantedPoints).toBe(0);
    expect(surrendered.player.cashWen).toBe(beforeCash - 12_000);
    expect(service.surrenderToLaw(player.id, "surrender-1").player.cashWen).toBe(beforeCash - 12_000);
    expect(db.prepare("SELECT COUNT(*) AS count FROM law_settlements WHERE player_id=?").get(player.id)).toEqual({ count: 1 });
  });

  it("decays one wanted point per complete hour and refuses retail at the exact threshold", () => {
    const player = service.createSession().player;
    db.prepare(`
      INSERT OR REPLACE INTO player_law_state(player_id,wanted_points,decay_anchor_at,last_crime_at,updated_at)
      VALUES (?,20,?,?,?)
    `).run(player.id, clock.toISOString(), clock.toISOString(), clock.toISOString());
    expect(service.getLawState(player.id)).toMatchObject({ wantedPoints: 20, shopRefused: true });
    clock = new Date(clock.getTime() + 59 * 60_000 + 59_000);
    expect(service.getLawState(player.id).wantedPoints).toBe(20);
    clock = new Date(clock.getTime() + 1_000);
    expect(service.getLawState(player.id)).toMatchObject({ wantedPoints: 19, shopRefused: false });
  });

  it("does not criminalize human opponents or conduct outside Kaifeng", () => {
    const first = service.createSession().player;
    const second = service.createSession().player;
    service.startCombat(first.id, second.id);
    expect(service.getLawState(first.id).wantedPoints).toBe(0);

    const outsider = service.createSession().player;
    db.prepare("UPDATE players SET current_location='home-front-garden' WHERE id IN (?,?)")
      .run(outsider.id, "npc-001");
    service.startCombat(outsider.id, "npc-001");
    expect(service.getLawState(outsider.id).wantedPoints).toBe(0);
  });

  it("privately directs constables to pursue at 50 and stop at 49", () => {
    const player = service.createSession().player;
    const constableId = "npc-169";
    const location = service.getPlayer(constableId).currentLocation;
    db.prepare("UPDATE players SET current_location=? WHERE id=?").run(location, player.id);
    db.prepare(`
      INSERT OR REPLACE INTO player_law_state(player_id,wanted_points,decay_anchor_at,last_crime_at,updated_at)
      VALUES (?,50,?,?,?)
    `).run(player.id, clock.toISOString(), clock.toISOString(), clock.toISOString());
    expect(resolveNpcAgentDirective(db, constableId, [player.id, constableId], clock)).toMatchObject({
      kind: "combat", targetPlayerId: player.id, activity: "追缉通缉者",
    });
    db.prepare("UPDATE player_law_state SET wanted_points=49 WHERE player_id=?").run(player.id);
    expect(resolveNpcAgentDirective(db, constableId, [player.id, constableId], clock)).not.toMatchObject({ kind: "combat" });
  });
});
