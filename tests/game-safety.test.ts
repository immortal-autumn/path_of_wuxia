import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openGameDatabase, type GameDatabase } from "../lib/game/database";
import { clientMessageSchema } from "../lib/game/protocol";
import { GameService } from "../lib/game/service";

describe("combat consent and economy safety", () => {
  let db: GameDatabase;
  let service: GameService;
  let clock: Date;

  beforeEach(() => {
    db = openGameDatabase(":memory:");
    clock = new Date("2026-08-03T12:00:00.000Z");
    service = new GameService(db, () => new Date(clock), () => 0);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    db.close();
  });

  it("accepts the duel protocol and atomically starts a no-loot human duel", () => {
    expect(clientMessageSchema.parse({
      type: "interaction.request", requestId: "duel-request", targetPlayerId: "target", requestType: "duel",
    })).toMatchObject({ type: "interaction.request", requestType: "duel" });

    const attacker = service.createSession().player;
    const defender = service.createSession().player;
    db.prepare("UPDATE players SET current_location='loumen-road' WHERE id IN (?,?)").run(attacker.id, defender.id);
    expect(() => service.startCombat(attacker.id, defender.id)).toThrow("请先发起切磋");

    db.prepare(`
      INSERT INTO item_instances(id,definition_id,owner_player_id,quantity,quality,durability,affixes_json,bound,created_at,updated_at)
      VALUES ('duel-rice','rice',?,2,2,0,'[]',0,?,?)
    `).run(defender.id, clock.toISOString(), clock.toISOString());
    db.prepare("UPDATE players SET hp=1 WHERE id=?").run(defender.id);

    service.requestInteraction(attacker.id, defender.id, "duel");
    const request = service.getSocialState(defender.id).incomingRequests[0];
    const accepted = service.respondInteraction(defender.id, request.id, true, [attacker.id, defender.id]);
    expect(accepted.message).toContain("点到即止");
    const combat = service.getCombatState(attacker.id)!;
    expect(combat.opponentId).toBe(defender.id);
    expect(db.prepare("SELECT status,json_extract(payload_json,'$.combatId') AS combat_id FROM interaction_requests WHERE id=?").get(request.id))
      .toEqual({ status: "accepted", combat_id: combat.id });

    service.chooseCombatAction(attacker.id, combat.id, "attack");
    expect(service.getCombatState(attacker.id)).toBeNull();
    expect(service.getPlayer(defender.id)).toMatchObject({ hp: 1, cashWen: 20_000, defeated: false });
    expect(db.prepare("SELECT owner_player_id FROM item_instances WHERE id='duel-rice'").get())
      .toEqual({ owner_player_id: defender.id });
    expect(db.prepare("SELECT COUNT(*) AS count FROM loot_piles").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM law_incidents WHERE reference_id=?").get(combat.id))
      .toEqual({ count: 0 });
  });

  it("blocks hostile attacks in safe places and protects new humans for one hour", () => {
    const npc = service.getPlayer("npc-001");
    const newcomer = service.createSession().player;
    db.prepare("UPDATE players SET current_location='home-entrance' WHERE id IN (?,?)").run(npc.id, newcomer.id);
    expect(() => service.startCombat(npc.id, newcomer.id)).toThrow("属于安全地点");

    db.prepare("UPDATE players SET current_location='loumen-road' WHERE id IN (?,?)").run(npc.id, newcomer.id);
    expect(() => service.startCombat(npc.id, newcomer.id)).toThrow("一小时新手保护期");

    clock = new Date(clock.getTime() + 60 * 60_000);
    expect(service.startCombat(npc.id, newcomer.id).combatId).toBeTruthy();
  });

  it("restricts production anonymous wealth transfer while preserving demo and OIDC play", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ANONYMOUS_ECONOMY", "false");
    const first = service.createSession().player;
    const second = service.createSession().player;
    expect(() => service.requestTrade(first.id, second.id)).toThrow("匿名试玩角色不能进行玩家交易");

    const marketLocation = db.prepare(`
      SELECT location_id FROM location_facilities
      WHERE facility_type='market' AND is_active=1 ORDER BY location_id LIMIT 1
    `).get() as { location_id: string };
    db.prepare("UPDATE players SET current_location=? WHERE id=?").run(marketLocation.location_id, first.id);
    expect(() => service.placeMarketOrder(first.id, "anonymous-order", "spot-rice", "buy", 1, 1))
      .toThrow("匿名试玩角色不能在市易行会下单");

    db.prepare(`
      INSERT INTO loot_piles(id,location_id,silver,cash_wen,source_player_id,created_at,updated_at)
      VALUES ('other-loot',?,0,100,?,?,?)
    `).run(marketLocation.location_id, second.id, clock.toISOString(), clock.toISOString());
    expect(() => service.takeLoot(first.id, "other-loot")).toThrow("匿名试玩角色不能拾取他人的战利品");

    vi.stubEnv("ANONYMOUS_ECONOMY", "true");
    db.prepare("UPDATE players SET current_location='home-entrance' WHERE id IN (?,?)").run(first.id, second.id);
    expect(service.requestTrade(first.id, second.id).message).toContain("交易请求");

    vi.stubEnv("ANONYMOUS_ECONOMY", "false");
    const externalA = service.createExternalSession("oidc", "external-a", "player").player;
    const externalB = service.createExternalSession("oidc", "external-b", "player").player;
    expect(service.requestTrade(externalA.id, externalB.id).message).toContain("交易请求");
    db.prepare("UPDATE players SET current_location=? WHERE id=?").run(marketLocation.location_id, externalA.id);
    const contract = service.getMarketSnapshot(externalA.id).contracts.find((item) => item.kind === "spot")!;
    expect(service.placeMarketOrder(externalA.id, "external-order", contract.id, "buy", 1, 1).market.orders)
      .toEqual(expect.arrayContaining([expect.objectContaining({ contractId: contract.id })]));
  });
});
