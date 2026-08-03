import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAP_SCHEMA_VERSION, openGameDatabase, type GameDatabase } from "../lib/game/database";
import { directionBetween } from "../lib/game/map";
import { conciseLocationName } from "../lib/game/location-label";
import {
  cultivationForNextLevel,
  deriveStats,
  majorAttributePoints,
  minorAttributePoints,
} from "../lib/game/progression";
import { GameService } from "../lib/game/service";
import { importWorldSeed } from "../lib/game/world-seed";
import { validateWorldMap } from "../lib/game/world-validation";

describe("GameService", () => {
  let db: GameDatabase;
  let service: GameService;
  let clock: Date;
  let roll: number;

  beforeEach(() => {
    db = openGameDatabase(":memory:");
    clock = new Date("2026-08-03T12:00:00.000Z");
    roll = 0;
    service = new GameService(db, () => new Date(clock), () => roll);
  });

  afterEach(() => db.close());

  it("creates concise map labels without changing canonical location names", () => {
    expect(conciseLocationName("嬴长嫚与楼夜秋之家·门厅")).toBe("门厅");
    expect(conciseLocationName("嬴长嫚与楼夜秋之家·入口")).toBe("住宅入口");
    expect(conciseLocationName("京畿路·开封府治所")).toBe("开封府治所");
    expect(conciseLocationName("帕洛斯洞窟·洞窟入口 5001")).toBe("洞窟 5001");
    expect(conciseLocationName("帕洛斯传送点·被遗忘的岛屿教堂遗址")).toBe("被遗忘的岛屿教堂…");
  });

  it("seeds a source-tracked 500+ location world and preserves all ordinary direction slots", () => {
    expect(service.getLayers().map((layer) => layer.id).sort()).toEqual(["home-ground", "world-root"]);
    expect(service.getLocation("home-entrance")).toMatchObject({ layerId: "home-ground", name: "玄关" });
    expect(service.getLocation("home-exterior")).toMatchObject({ layerId: "world-root", name: "嬴长嫚与楼夜秋之家·入口" });
    expect(service.getLocation("loumen-road")).toMatchObject({ layerId: "world-root", name: "楼门路" });
    expect(service.getLocation("song-jingji-1-seat")).toMatchObject({ layerId: "world-root", regionId: "song" });
    expect(service.getLocation("song-hub-hebei-east")).toMatchObject({ gridX: -13, gridY: -27 });
    expect(service.getLocation("song-hub-guangnan-west")).toMatchObject({ gridX: -37, gridY: 50 });
    expect(service.getLocation("palos-fasttravel-1001")).toMatchObject({ layerId: "world-root", regionId: "palos", gridX: 20, gridY: 2 });
    expect(service.getLocation("palos-fasttravel-1057")).toMatchObject({ gridX: 67, gridY: -11 });
    expect(service.getLocation("home-training-room")).toMatchObject({ layerId: "home-ground" });
    expect(service.searchMapLocations("world-root", "楼门路", 10)).toHaveLength(3);
    expect(db.prepare("SELECT COUNT(*) AS count FROM locations WHERE name='楼门路' AND is_active=1").get()).toEqual({ count: 3 });
    const validation = validateWorldMap(db);
    expect(validation.errors).toEqual([]);
    expect(validation.counts).toMatchObject({
      locations: 1342,
      routes: 1373,
      songLocations: 618,
      palosLocations: 510,
      overworldLocations: 1321,
    });
    expect(validation.counts.songLocations).toBeGreaterThanOrEqual(250);
    expect(validation.counts.locations).toBeGreaterThanOrEqual(500);
    expect(validation.counts.reachableLocations).toBe(validation.counts.locations);
    expect(validation.counts.overworldLocations).toBeGreaterThanOrEqual(890);
    expect(db.prepare("SELECT COUNT(*) AS count FROM world_sources WHERE id='source-song-map'").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM locations WHERE is_active=1 AND name='大宋官道'").get()).toEqual({ count: 189 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM locations WHERE is_active=1 AND name='帕洛斯道路'").get()).toEqual({ count: 241 });
    expect((db.prepare("SELECT COUNT(*) AS count FROM location_direction_slots").get() as { count: number }).count).toBeGreaterThan(500);
    expect((db.prepare("SELECT COUNT(*) AS count FROM routes r JOIN locations f ON f.id=r.from_location JOIN locations t ON t.id=r.to_location WHERE r.is_active=1 AND r.route_type<>'normal' AND f.layer_id='world-root' AND t.layer_id='world-root'").get() as { count: number }).count).toBe(0);
    expect(validation.counts.layers).toBe(2);
    expect(service.getTransitions("home-entrance")[0]).toMatchObject({ destinationName: "嬴长嫚与楼夜秋之家·入口", transitionKind: "door" });
  });

  it("reapplies the bundled world seed idempotently", () => {
    const before = db.prepare("SELECT COUNT(*) AS locations FROM locations").get();
    const first = importWorldSeed(db);
    const second = importWorldSeed(db);
    expect(first).toEqual(second);
    expect(db.prepare("SELECT COUNT(*) AS locations FROM locations").get()).toEqual(before);
    expect(validateWorldMap(db).ok).toBe(true);
  });

  it("installs schema-v7 action-system storage without breaking legacy actions", () => {
    const requiredTables = [
      "action_templates", "location_facilities", "location_action_bindings", "action_jobs", "player_needs",
      "skill_definitions", "player_skills", "item_definitions", "item_instances", "recipe_definitions",
      "crop_definitions", "farm_plots", "interaction_requests", "player_relationships", "trade_sessions",
      "combat_sessions", "loot_piles", "npc_profiles", "agent_credentials",
    ];
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((row) => row.name));
    expect(requiredTables.every((table) => tables.has(table))).toBe(true);
    expect(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: MAP_SCHEMA_VERSION });
    expect(db.prepare("SELECT COUNT(*) AS count FROM action_templates WHERE is_active=1 AND category='legacy'").get()).toEqual({ count: 5 });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM location_action_bindings b JOIN action_templates t ON t.id=b.action_template_id
      WHERE b.is_active=1 AND t.category='legacy'
    `).get()).toEqual({ count: 5 });

    const player = service.createSession().player;
    expect(db.prepare("SELECT controller_kind,adult_status,adult_content_enabled FROM players WHERE id=?").get(player.id))
      .toEqual({ controller_kind: "human", adult_status: "unknown", adult_content_enabled: 0 });
    service.move(player.id, "home-exterior");
    service.move(player.id, "loumen-road");
    expect(service.act(player.id, "observe-road").message).toContain("观察街道完成");
    expect(db.prepare("SELECT action_template_id FROM action_logs WHERE player_id=? AND kind='action'").get(player.id))
      .toEqual({ action_template_id: "observe-road" });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("runs one real-time action with eight reorderable queued actions and settles by server time", () => {
    const player = service.createSession().player;
    const initial = service.getActionState(player.id);
    expect(initial.available.map((action) => action.name)).toEqual(expect.arrayContaining(["整理衣装", "观察四周", "凝神聆听"]));
    expect(initial.current).toBeNull();
    expect(initial.maxQueued).toBe(8);

    const started = service.startAction(player.id, "action-observe");
    expect(started.actionState.current).toMatchObject({ name: "观察四周", status: "running" });
    service.startAction(player.id, "action-listen");
    expect(() => service.move(player.id, "home-hall")).toThrow("当前行动尚未完成");
    for (let index = 0; index < 7; index += 1) service.startAction(player.id, "action-listen");
    expect(service.getActionState(player.id).queued).toHaveLength(8);
    expect(() => service.startAction(player.id, "action-listen")).toThrow("等待队列最多只能安排8项行动");

    const reversedIds = service.getActionState(player.id).queued.map((job) => job.id).reverse();
    expect(service.reorderActionQueue(player.id, reversedIds).actionState.queued.map((job) => job.id)).toEqual(reversedIds);
    clock = new Date(clock.getTime() + 60_000);
    expect(service.settleActionQueue(player.id).completed).toBe(1);
    const after = service.getActionState(player.id);
    expect(after.current).toMatchObject({ name: "凝神聆听", status: "running", startedAt: clock.toISOString() });
    expect(service.getPlayer(player.id).skills.find((skill) => skill.id === "perception")?.experience).toBe(8);
    service.cancelAction(player.id, after.current!.id);
    expect(service.getActionState(player.id).current).toMatchObject({ name: "凝神聆听" });
  });

  it("decays needs in real time and applies facility actions after offline completion", () => {
    const player = service.createSession().player;
    service.move(player.id, "home-hall");
    service.move(player.id, "home-main-bedroom");
    const state = service.getActionState(player.id);
    expect(state.available.map((action) => action.name)).toEqual(expect.arrayContaining(["睡眠八小时", "休息一小时"]));
    service.startAction(player.id, "action-sleep");

    clock = new Date(clock.getTime() + 8 * 60 * 60_000);
    expect(service.settleActionQueue(player.id, true)).toMatchObject({ completed: 1, offline: true });
    const completed = service.getActionState(player.id);
    expect(completed.current).toBeNull();
    expect(completed.needs).toMatchObject({ fatigue: 0, satiety: 48, hydration: 27, hygiene: 84, bladder: 75 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM action_logs WHERE player_id=? AND action_template_id='action-sleep'").get(player.id))
      .toEqual({ count: 1 });

    db.prepare(`
      UPDATE player_needs SET satiety=10,hydration=10,hygiene=10,fatigue=90,bladder=90,updated_at=? WHERE player_id=?
    `).run(clock.toISOString(), player.id);
    expect(service.getActionState(player.id).needPenalty).toBe(25);
  });

  it("persists starter inventory, equipment bonuses, consumables and atomic recipe reservations", () => {
    const player = service.createSession().player;
    let inventory = service.getInventoryState(player.id);
    expect(inventory.items.map((item) => item.name)).toEqual(expect.arrayContaining(["棉布衣", "布靴", "木剑", "清水", "家常饭"]));
    const sword = inventory.items.find((item) => item.definitionId === "wooden-sword")!;
    expect(sword).toMatchObject({ bound: true, equippedSlot: "weapon", durability: 80 });
    expect(player.derived.maxAttack).toBe(45);
    service.unequipItem(player.id, sword.id);
    expect(service.getPlayer(player.id).derived.maxAttack).toBe(40);
    service.equipItem(player.id, sword.id);
    expect(service.getPlayer(player.id).derived.maxAttack).toBe(45);

    db.prepare("UPDATE player_needs SET hydration=30,updated_at=? WHERE player_id=?").run(clock.toISOString(), player.id);
    const water = inventory.items.find((item) => item.definitionId === "water-flask")!;
    service.useItem(player.id, water.id);
    expect(service.getPlayer(player.id).needs).toMatchObject({ hydration: 60, bladder: 10 });

    service.move(player.id, "home-hall");
    service.move(player.id, "home-living-room");
    service.move(player.id, "home-dining-room");
    service.move(player.id, "home-kitchen");
    db.prepare(`
      INSERT INTO item_instances(id,definition_id,owner_player_id,quantity,quality,durability,affixes_json,bound,created_at,updated_at)
      VALUES ('test-rice','rice',?,2,1,0,'[]',0,?,?)
    `).run(player.id, clock.toISOString(), clock.toISOString());
    const craft = service.startCraft(player.id, "recipe-simple-meal");
    expect(craft.actionState.current).toMatchObject({ name: "按配方制作", durationSeconds: 1800 });
    expect(service.getInventoryState(player.id).items.find((item) => item.id === "test-rice")?.reservedQuantity).toBe(2);
    service.cancelAction(player.id, craft.actionState.current!.id);
    expect(service.getInventoryState(player.id).items.find((item) => item.id === "test-rice")?.reservedQuantity).toBe(0);

    service.startCraft(player.id, "recipe-simple-meal");
    clock = new Date(clock.getTime() + 30 * 60_000);
    expect(service.settleActionQueue(player.id).completed).toBe(1);
    inventory = service.getInventoryState(player.id);
    expect(inventory.items.find((item) => item.id === "test-rice")).toBeUndefined();
    expect(inventory.items.filter((item) => item.definitionId === "simple-meal").reduce((sum, item) => sum + item.quantity, 0)).toBe(4);
  });

  it("plants and harvests persistent real-time farm plots", () => {
    const player = service.createSession().player;
    service.move(player.id, "home-front-garden");
    let inventory = service.getInventoryState(player.id);
    const plot = inventory.farmPlots[0];
    expect(plot).toMatchObject({ state: "empty", mature: false });
    service.startFarmAction(player.id, plot.id, "plant", "crop-rice");
    clock = new Date(clock.getTime() + 30 * 60_000);
    service.settleActionQueue(player.id);
    inventory = service.getInventoryState(player.id);
    expect(inventory.farmPlots[0]).toMatchObject({ state: "growing", cropName: "水稻", mature: false });
    expect(new Date(inventory.farmPlots[0].maturesAt!).getTime() - clock.getTime()).toBe(120 * 24 * 60 * 60_000);

    db.prepare("UPDATE farm_plots SET matures_at=? WHERE id=?").run(clock.toISOString(), plot.id);
    service.startFarmAction(player.id, plot.id, "harvest");
    clock = new Date(clock.getTime() + 30 * 60_000);
    service.settleActionQueue(player.id);
    inventory = service.getInventoryState(player.id);
    expect(inventory.farmPlots[0]).toMatchObject({ state: "empty", cropId: null });
    expect(inventory.items.filter((item) => item.definitionId === "rice").reduce((sum, item) => sum + item.quantity, 0)).toBe(20);
  });

  it("expands Eagle Eye vision temporarily without revealing locations in exploration history", () => {
    const player = service.createSession().player;
    const before = service.getSnapshot(player.id, [player.id]);
    expect(before.self.visionDepth).toBe(3);
    expect(service.getVisitedMap(player.id).locations).toHaveLength(1);

    service.startAction(player.id, "action-eagle-eye");
    clock = new Date(clock.getTime() + 60_000);
    expect(service.settleActionQueue(player.id).completed).toBe(1);
    const expanded = service.getSnapshot(player.id, [player.id]);
    expect(expanded.self.visionDepth).toBe(4);
    expect(expanded.locations.length).toBeGreaterThan(before.locations.length);
    expect(service.getVisitedMap(player.id).locations).toHaveLength(1);

    clock = new Date(clock.getTime() + 30 * 60_000);
    expect(service.getPlayer(player.id).visionDepth).toBe(3);
  });

  it("keeps observation and listening private and filters private or adult traces", () => {
    const player = service.createSession().player;
    service.startAction(player.id, "action-observe");
    clock = new Date(clock.getTime() + 60_000);
    service.settleActionQueue(player.id);
    expect(service.getPrivateEvents(player.id)[0].content).toContain("观察结果：");
    expect(service.getPrivateEvents(player.id)[0].content).toContain("surroundings");
    expect(db.prepare("SELECT COUNT(*) AS count FROM world_events WHERE player_id=? AND event_type='action'").get(player.id)).toEqual({ count: 0 });

    const traceTime = clock.toISOString();
    db.prepare(`
      INSERT INTO action_logs(player_id,kind,action_template_id,from_location,to_location,result_text,created_at)
      VALUES (?,'action','action-rest','home-hall','home-hall','附近侠客公开练功。',?),
             (?,'action','action-bathe','home-hall','home-hall','不应听见的私人动静。',?),
             (?,'action','action-sleep','home-hall','home-hall','不应听见的成人动静。',?)
    `).run(player.id, traceTime, player.id, traceTime, player.id, traceTime);
    db.prepare("UPDATE action_templates SET adult=1,visibility='public' WHERE id='action-sleep'").run();
    service.startAction(player.id, "action-listen");
    clock = new Date(clock.getTime() + 300_000);
    service.settleActionQueue(player.id);
    const listening = service.getPrivateEvents(player.id)[0].content;
    expect(listening).toContain("附近侠客公开练功");
    expect(listening).not.toContain("私人动静");
    expect(listening).not.toContain("成人动静");
    expect(db.prepare("SELECT COUNT(*) AS count FROM world_events WHERE player_id=? AND event_type='action'").get(player.id)).toEqual({ count: 0 });
  });

  it("offers straight eight-direction Qinggong targets and moves only after a successful timed settlement", () => {
    const player = service.createSession().player;
    expect(service.getQinggongTargets(player.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ locationId: "home-main-bedroom", direction: "down", distance: 2, durationSeconds: 35 }),
    ]));
    expect(service.getQinggongTargets(player.id).some((target) => target.locationId === "home-garage")).toBe(false);
    db.prepare("UPDATE player_skills SET level=40 WHERE player_id=? AND skill_id='qinggong'").run(player.id);
    expect(service.getQinggongTargets(player.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ locationId: "home-garage", direction: "right", distance: 3, durationSeconds: 45 }),
      expect.objectContaining({ locationId: "home-back-garden", direction: "down", distance: 4, durationSeconds: 55 }),
    ]));

    service.startQinggong(player.id, "home-main-bedroom");
    expect(service.getPlayer(player.id).currentLocation).toBe("home-entrance");
    expect(service.getVisitedMap(player.id).locations).toHaveLength(1);
    clock = new Date(clock.getTime() + 35_000);
    expect(service.settleActionQueue(player.id).completed).toBe(1);
    expect(service.getPlayer(player.id).currentLocation).toBe("home-main-bedroom");
    expect(service.getVisitedMap(player.id).locations.map((location) => location.id)).toContain("home-main-bedroom");

    const failedPlayer = service.createSession().player;
    const initialHp = failedPlayer.hp;
    roll = 99;
    service.startQinggong(failedPlayer.id, "home-main-bedroom");
    clock = new Date(clock.getTime() + 35_000);
    service.settleActionQueue(failedPlayer.id);
    const failed = service.getPlayer(failedPlayer.id);
    expect(failed.currentLocation).toBe("home-entrance");
    expect(failed.hp).toBe(initialHp - 5);
    expect(failed.needs.fatigue).toBeGreaterThanOrEqual(5);
    expect(service.getVisitedMap(failedPlayer.id).locations).toHaveLength(1);
  });

  it("requires confirmed adult opt-in and fresh mutual consent for every private adult action", () => {
    const first = service.createSession().player;
    const second = service.createSession().player;
    expect(() => service.requestInteraction(first.id, second.id, "intimate", "action-private-intimacy"))
      .toThrow("双方确认成年并开启成人内容");

    service.updateAdultProfile(first.id, "adult", true);
    service.updateAdultProfile(second.id, "adult", true);
    service.requestInteraction(first.id, second.id, "intimate", "action-private-intimacy");
    const request = service.getSocialState(second.id).incomingRequests[0];
    service.respondInteraction(second.id, request.id, true, [first.id, second.id]);
    expect(service.getActionState(first.id).current).toMatchObject({
      actionTemplateId: "action-private-intimacy", targetPlayerId: second.id, durationSeconds: 900,
    });
    expect(service.getSocialState(second.id).incomingRequests).toHaveLength(0);

    clock = new Date(clock.getTime() + 900_000);
    service.settleActionQueue(first.id);
    expect(service.getPrivateEvents(first.id)[0].content).toContain("双方同意的私密互动");
    expect(service.getPrivateEvents(second.id)[0].content).toContain("双方同意的私密互动");
    expect(db.prepare("SELECT COUNT(*) AS count FROM world_events WHERE event_type='action' AND player_id=?").get(first.id)).toEqual({ count: 0 });
    expect(() => service.startAction(first.id, "action-private-intimacy")).toThrow("这里无法进行这项行动");

    service.requestInteraction(first.id, second.id, "intimate", "action-private-intimacy");
    service.updateAdultProfile(second.id, "minor", true);
    expect(service.getSocialState(second.id).adultProfile).toEqual({ status: "minor", contentEnabled: false });
    expect(service.getSocialState(first.id).outgoingRequests).toHaveLength(0);
  });

  it("creates mutual formal relationships and enforces direct-interaction blocks", () => {
    const first = service.createSession().player;
    const second = service.createSession().player;
    service.requestInteraction(first.id, second.id, "relationship.mentor");
    const request = service.getSocialState(second.id).incomingRequests[0];
    service.respondInteraction(second.id, request.id, true, [first.id, second.id]);
    expect(service.getSocialState(first.id).relationships[0]).toMatchObject({
      otherPlayerId: second.id, relationType: "mentor", role: "mentor",
    });
    expect(service.getSocialState(second.id).relationships[0]).toMatchObject({
      otherPlayerId: first.id, relationType: "mentor", role: "disciple",
    });
    service.endRelationship(second.id, service.getSocialState(second.id).relationships[0].id);
    expect(service.getSocialState(first.id).relationships).toHaveLength(0);

    service.setPlayerBlocked(second.id, first.id, true);
    expect(() => service.greetPlayer(first.id, second.id)).toThrow("当前无法与对方互动");
    service.setPlayerBlocked(second.id, first.id, false);
    expect(service.greetPlayer(first.id, second.id).event.eventType).toBe("social");
  });

  it("atomically exchanges unbound items and silver after both trade confirmations", () => {
    const first = service.createSession().player;
    const second = service.createSession().player;
    db.prepare(`
      INSERT INTO item_instances(id,definition_id,owner_player_id,quantity,quality,durability,affixes_json,bound,created_at,updated_at)
      VALUES ('trade-rice','rice',?,3,2,0,'[]',0,?,?)
    `).run(first.id, clock.toISOString(), clock.toISOString());
    service.requestTrade(first.id, second.id);
    const tradeId = service.getSocialState(second.id).trades[0].id;
    service.respondTrade(second.id, tradeId, true, [first.id, second.id]);
    service.offerTrade(first.id, tradeId, 5, [{ itemId: "trade-rice", quantity: 2 }]);
    service.offerTrade(second.id, tradeId, 3, []);
    expect(service.confirmTrade(first.id, tradeId).message).toContain("等待对方");
    expect(service.getSocialState(first.id).trades[0]).toMatchObject({ ownConfirmed: true, otherConfirmed: false });
    expect(service.confirmTrade(second.id, tradeId).message).toBe("交易完成。");

    expect(service.getPlayer(first.id).silver).toBe(18);
    expect(service.getPlayer(second.id).silver).toBe(22);
    expect(db.prepare("SELECT quantity,owner_player_id FROM item_instances WHERE id='trade-rice'").get()).toEqual({ quantity: 1, owner_player_id: first.id });
    expect((db.prepare("SELECT SUM(quantity) AS quantity FROM item_instances WHERE owner_player_id=? AND definition_id='rice'").get(second.id) as { quantity: number }).quantity).toBe(2);
    expect(service.getSocialState(first.id).trades).toHaveLength(0);
    expect(service.getPrivateEvents(second.id)[0].content).toContain("交易已经由双方确认并完成");

    const bound = service.getInventoryState(first.id).items.find((item) => item.bound)!;
    service.requestTrade(first.id, second.id);
    const nextTradeId = service.getSocialState(second.id).trades[0].id;
    service.respondTrade(second.id, nextTradeId, true, [first.id, second.id]);
    expect(() => service.offerTrade(first.id, nextTradeId, 0, [{ itemId: bound.id, quantity: 1 }]))
      .toThrow("绑定或已装备物品不能交易");
  });

  it("upgrades the former public-map hierarchy into one continuous overworld", () => {
    db.prepare(`INSERT INTO map_layers(id,name,description,parent_layer_id,version,is_active,seed_revision,created_at,updated_at)
      VALUES ('song-legacy-layer','旧大宋层','旧层级。','world-root',1,1,2,?,?)`).run(clock.toISOString(), clock.toISOString());
    db.prepare("UPDATE locations SET layer_id='song-legacy-layer',grid_x=0,grid_y=0,x=0,y=0,chunk_x=0,chunk_y=0,seed_revision=2 WHERE id='song-jingji-1-seat'").run();
    db.prepare("UPDATE map_layers SET seed_revision=2 WHERE seed_revision>0").run();
    db.prepare("UPDATE map_regions SET seed_revision=2 WHERE seed_revision>0").run();
    db.prepare("UPDATE locations SET seed_revision=2 WHERE seed_revision>0").run();
    db.prepare("UPDATE routes SET seed_revision=2 WHERE seed_revision>0").run();
    db.prepare(`INSERT INTO map_layers(id,name,description,parent_layer_id,version,is_active,seed_revision,created_at,updated_at)
      VALUES ('song-overview','北宋舆图','旧总览。','world-root',1,1,0,?,?),
             ('palos-overview','帕洛斯群岛','旧总览。','world-root',1,1,0,?,?)`)
      .run(clock.toISOString(), clock.toISOString(), clock.toISOString(), clock.toISOString());
    db.prepare(`INSERT INTO routes(from_location,to_location,stamina_cost,id,route_type,transition_kind,version,is_active,seed_revision)
      VALUES ('home-entrance','loumen-road',0,'route-entrance-road','transition','door',1,1,0)`).run();

    importWorldSeed(db);

    expect(db.prepare("SELECT is_active FROM map_layers WHERE id='song-legacy-layer'").get()).toEqual({ is_active: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM map_layers WHERE id IN ('song-overview','palos-overview') AND is_active=1").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT is_active FROM routes WHERE id='route-entrance-road'").get()).toEqual({ is_active: 0 });
    expect(service.getLocation("song-jingji-1-seat")).toMatchObject({ layerId: "world-root", regionId: "song" });
    expect(service.getLayers()).toHaveLength(2);
    expect(validateWorldMap(db).errors).toEqual([]);
  });

  it("preserves active locations and routes while upgrading older schema metadata", () => {
    const directory = mkdtempSync(join(tmpdir(), "wuxia-v5-migration-"));
    const databasePath = join(directory, "game.db");
    try {
      const versionThree = openGameDatabase(databasePath);
      const expectedLocations = versionThree.prepare("SELECT COUNT(*) AS count FROM locations WHERE is_active=1").get();
      const expectedRoutes = versionThree.prepare("SELECT COUNT(*) AS count FROM routes WHERE is_active=1").get();
      versionThree.prepare("DELETE FROM schema_migrations").run();
      versionThree.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES (3,?)").run(clock.toISOString());
      versionThree.close();
      const upgraded = openGameDatabase(databasePath);
      expect(upgraded.prepare("SELECT COUNT(*) AS count FROM locations WHERE is_active=1").get()).toEqual(expectedLocations);
      expect(upgraded.prepare("SELECT COUNT(*) AS count FROM routes WHERE is_active=1").get()).toEqual(expectedRoutes);
      expect(upgraded.prepare("SELECT route_type FROM routes WHERE id='route-home-door-v4'").get()).toEqual({ route_type: "transition" });
      upgraded.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("backfills schema-v6 exploration history from existing movement logs", () => {
    const directory = mkdtempSync(join(tmpdir(), "wuxia-v6-visited-migration-"));
    const databasePath = join(directory, "game.db");
    try {
      const versionFive = openGameDatabase(databasePath);
      const versionFiveService = new GameService(versionFive, () => new Date(clock), () => roll);
      const player = versionFiveService.createSession().player;
      versionFiveService.move(player.id, "home-exterior");
      versionFiveService.move(player.id, "loumen-road");
      versionFive.prepare("DELETE FROM player_visited_locations WHERE player_id=?").run(player.id);
      versionFive.prepare("DELETE FROM schema_migrations").run();
      versionFive.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES (5,?)").run(clock.toISOString());
      versionFive.close();

      const upgraded = openGameDatabase(databasePath);
      const upgradedService = new GameService(upgraded, () => new Date(clock), () => roll);
      expect(upgradedService.getVisitedMap(player.id).locations.map((location) => location.id).sort())
        .toEqual(["home-entrance", "home-exterior", "loumen-road"]);
      expect(upgraded.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: MAP_SCHEMA_VERSION });
      expect(upgraded.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      upgraded.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("upgrades a populated legacy database without SQLite ALTER TABLE foreign-key errors", () => {
    const directory = mkdtempSync(join(tmpdir(), "wuxia-v1-migration-"));
    const databasePath = join(directory, "game.db");
    try {
      const legacy = new DatabaseSync(databasePath);
      legacy.exec(`
        CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL);
        INSERT INTO schema_migrations(version,applied_at) VALUES (1,'2024-01-01T00:00:00.000Z');
        CREATE TABLE locations(
          id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,region TEXT NOT NULL DEFAULT '',description TEXT NOT NULL,
          x INTEGER NOT NULL,y INTEGER NOT NULL
        );
        INSERT INTO locations(id,name,region,description,x,y) VALUES ('legacy-place','旧地点','旧区域','迁移前地点。',0,0);
      `);
      legacy.close();
      const upgraded = openGameDatabase(databasePath);
      expect(upgraded.prepare("SELECT id,layer_id,is_active FROM locations WHERE id='legacy-place'").get())
        .toEqual({ id: "legacy-place", layer_id: "world-root", is_active: 0 });
      expect(upgraded.prepare("SELECT COUNT(*) AS count FROM locations WHERE is_active=1").get())
        .toMatchObject({ count: expect.any(Number) });
      upgraded.exec(`
        INSERT INTO locations(id,name,region,description,x,y,layer_id,grid_x,grid_y,chunk_x,chunk_y)
        VALUES ('duplicate-road-a','同名街道','测试区域','同名街道西段。',160000,160000,'world-root',1000,1000,160,160),
               ('duplicate-road-b','同名街道','测试区域','同名街道东段。',160160,160000,'world-root',1001,1000,160,160);
      `);
      expect(upgraded.prepare("SELECT COUNT(*) AS count FROM locations WHERE name='同名街道'").get()).toEqual({ count: 2 });
      expect(upgraded.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      upgraded.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("creates and restores an opaque identity with six balanced attributes", () => {
    const identity = service.createSession();
    expect(identity.player).toMatchObject({
      currentLocation: "home-entrance",
      attributes: { strength: 10, agility: 10, constitution: 10, root: 10, comprehension: 10, spirit: 10 },
      cultivation: { realmName: "凡人", level: 1, unspentAttributePoints: 0 },
    });
    expect(identity.player.maxHp).toBe(300);
    expect(identity.player.maxEndurance).toBe(120);
    expect(service.getPlayerBySessionToken(identity.token)?.id).toBe(identity.player.id);
    const stored = db.prepare("SELECT token_hash FROM sessions").get() as { token_hash: string };
    expect(stored.token_hash).not.toBe(identity.token);
    expect(service.getVisitedMap(identity.player.id)).toMatchObject({
      layers: [{ id: "home-ground" }],
      locations: [{ id: "home-entrance" }],
      routes: [],
    });
  });

  it("stores an isolated visited map for each player and includes only discovered connections", () => {
    const explorer = service.createSession().player;
    const newcomer = service.createSession().player;

    service.move(explorer.id, "home-exterior");
    let visited = service.getVisitedMap(explorer.id);
    expect(visited.layers.map((layer) => layer.id).sort()).toEqual(["home-ground", "world-root"]);
    expect(visited.locations.map((location) => location.id).sort()).toEqual(["home-entrance", "home-exterior"]);
    expect(visited.routes).toMatchObject([{ id: "route-home-door-v4", routeType: "transition" }]);

    service.move(explorer.id, "loumen-road");
    service.move(explorer.id, "home-exterior");
    visited = service.getVisitedMap(explorer.id);
    expect(visited.locations.map((location) => location.id).sort()).toEqual(["home-entrance", "home-exterior", "loumen-road"]);
    expect(visited.routes.map((route) => route.id).sort()).toEqual(["route-home-door-v4", "route-home-road-v4"]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM player_visited_locations WHERE player_id=?").get(explorer.id)).toEqual({ count: 3 });

    expect(service.getVisitedMap(newcomer.id).locations.map((location) => location.id)).toEqual(["home-entrance"]);
  });

  it("keeps the global online count while scoping position payloads to three steps", () => {
    const viewer = service.createSession().player;
    const nearby = service.createSession().player;
    const distant = service.createSession().player;
    db.prepare("UPDATE players SET current_location='home-hall' WHERE id=?").run(nearby.id);
    db.prepare("UPDATE players SET current_location='palos-dungeon-5123' WHERE id=?").run(distant.id);

    const snapshot = service.getSnapshot(viewer.id, [viewer.id, nearby.id, distant.id]);

    expect(snapshot.world.onlineCount).toBe(3);
    expect(snapshot.onlinePlayers.map((player) => player.id).sort()).toEqual([nearby.id, viewer.id].sort());
    expect(snapshot.onlinePlayers.some((player) => player.id === distant.id)).toBe(false);
  });

  it("allocates 2,000 unique identities", () => {
    const names = new Set<string>();
    for (let index = 0; index < 2_000; index += 1) names.add(service.createSession().player.name);
    expect(names).toHaveLength(2_000);
  });

  it("calculates transparent derived stats and increasing attribute rewards", () => {
    expect(deriveStats({ strength: 10, agility: 10, constitution: 10, root: 10, comprehension: 10, spirit: 10 }, 0)).toMatchObject({
      maxHp: 300, maxEndurance: 120, minAttack: 25, maxAttack: 40, defense: 25, speed: 25,
      cultivationPerMinute: 10,
    });
    expect(minorAttributePoints(0)).toBe(2);
    expect(minorAttributePoints(5)).toBe(4);
    expect(minorAttributePoints(12)).toBe(8);
    expect(majorAttributePoints(1)).toBe(15);
    expect(majorAttributePoints(12)).toBe(48);
  });

  it("maps all eight adjacent directions and rejects distant offsets", () => {
    const center = { gridX: 10, gridY: 10 };
    expect(directionBetween(center, { gridX: 10, gridY: 9 })).toBe("up");
    expect(directionBetween(center, { gridX: 11, gridY: 9 })).toBe("up-right");
    expect(directionBetween(center, { gridX: 11, gridY: 10 })).toBe("right");
    expect(directionBetween(center, { gridX: 11, gridY: 11 })).toBe("down-right");
    expect(directionBetween(center, { gridX: 10, gridY: 11 })).toBe("down");
    expect(directionBetween(center, { gridX: 9, gridY: 11 })).toBe("down-left");
    expect(directionBetween(center, { gridX: 9, gridY: 10 })).toBe("left");
    expect(directionBetween(center, { gridX: 9, gridY: 9 })).toBe("up-left");
    expect(directionBetween(center, { gridX: 12, gridY: 10 })).toBeNull();
  });

  it("moves without consuming endurance and performs actions without cultivation rewards", () => {
    const player = service.createSession().player;
    const endurance = player.endurance;
    service.move(player.id, "home-exterior");
    const moved = service.move(player.id, "loumen-road");
    expect(moved.self).toMatchObject({ currentLocation: "loumen-road", endurance });
    const acted = service.act(player.id, "observe-road");
    expect(acted.self.endurance).toBe(endurance);
    expect(acted.self.cultivation.progress).toBe(0);
    expect(() => service.move(player.id, "loumen-road-east")).not.toThrow();
    expect(() => service.move(player.id, "palos-gate")).not.toThrow();
  });

  it("settles online and unlimited offline cultivation from server time only", () => {
    const player = service.createSession().player;
    db.prepare("INSERT INTO location_effects(location_id,effect_type,multiplier) VALUES ('home-entrance','cultivation',1)").run();
    service.settleCultivation(player.id, false);
    clock = new Date(clock.getTime() + 10 * 60_000);
    const settlement = service.settleCultivation(player.id, true);
    expect(settlement.delta).toBe(100);
    expect(settlement.player.cultivation).toMatchObject({ realmName: "凡人", level: 2, progress: 0, unspentAttributePoints: 2 });
    expect(service.settleCultivation(player.id, true).delta).toBe(0);
    clock = new Date(clock.getTime() - 60_000);
    expect(service.settleCultivation(player.id, true).delta).toBe(0);
  });

  it("allocates attributes atomically and recalculates combat values", () => {
    const player = service.createSession().player;
    db.prepare("UPDATE player_progression SET unspent_points=10 WHERE player_id=?").run(player.id);
    const result = service.allocateAttributes(player.id, { strength: 5, agility: 0, constitution: 0, root: 0, comprehension: 0, spirit: 0 });
    expect(result.player.attributes.strength).toBe(15);
    expect(result.player.cultivation.unspentAttributePoints).toBe(5);
    expect(result.player.derived.maxAttack).toBe(60);
    expect(() => service.allocateAttributes(player.id, { strength: 6, agility: 0, constitution: 0, root: 0, comprehension: 0, spirit: 0 })).toThrow("属性点不足");
  });

  it("applies probabilistic breakthroughs, failure cost, scaling rewards and 30% carry", () => {
    const player = service.createSession().player;
    const required = Math.ceil(cultivationForNextLevel(0, 9) * 0.3);
    db.prepare("UPDATE player_progression SET realm_level=9,cultivation_progress=? WHERE player_id=?").run(required, player.id);
    roll = 99;
    const failed = service.breakthrough(player.id);
    expect(failed.self.cultivation).toMatchObject({ realmIndex: 0, level: 9, progress: 0 });

    db.prepare("UPDATE player_progression SET cultivation_progress=? WHERE player_id=?").run(required, player.id);
    roll = 0;
    const success = service.breakthrough(player.id);
    expect(success.self.cultivation).toMatchObject({ realmIndex: 1, realmName: "后天", level: 1, unspentAttributePoints: 15 });
    expect(success.self.cultivation.progress).toBe(Math.floor(required * 0.3));
  });

  it("edits layer-scoped locations, enforces direction slots, and allows transitions", () => {
    const player = service.createSession().player;
    const session = service.acquireMapLocks(player.id, ["layer:world-root:chunk:0:0", "region:home"]);
    service.applyMapOperation(player.id, session.id, {
      type: "location.create",
      location: { id: "test-neighbor", layerId: "world-root", name: "测试邻居", description: "相邻格。", regionId: null, gridX: 3, gridY: 3 },
    });
    service.applyMapOperation(player.id, session.id, {
      type: "route.create", fromLocation: "loumen-road", toLocation: "test-neighbor", routeType: "normal",
    });
    expect(() => service.applyMapOperation(player.id, session.id, {
      type: "route.create", fromLocation: "home-entrance", toLocation: "test-neighbor", routeType: "normal",
    })).toThrow("同一地图层");
    service.applyMapOperation(player.id, session.id, {
      type: "route.create", fromLocation: "home-entrance", toLocation: "test-neighbor", routeType: "transition", transitionKind: "gate",
    });
    expect(service.getRoutes().some((route) => route.transitionKind === "gate" && route.fromLocation === "home-entrance" && route.toLocation === "test-neighbor")).toBe(true);
  });

  it("searches bounded cross-layer targets and safely manages the layer hierarchy", () => {
    expect(service.searchMapLocations("world-root", "初始台地", 10)).toMatchObject([
      { id: "palos-fasttravel-1001", layerId: "world-root" },
    ]);
    expect(service.searchMapLocations("world-root", "洞窟入口", 500)).toHaveLength(123);

    const player = service.createSession().player;
    const session = service.acquireMapLocks(player.id, ["layer:world-root"]);
    service.applyMapOperation(player.id, session.id, {
      type: "layer.create",
      layer: { id: "test-layer-parent", name: "测试父层", description: "父层。", parentLayerId: "world-root", version: 1 },
    });
    service.acquireMapLocks(player.id, ["layer:test-layer-parent"], session.id);
    service.applyMapOperation(player.id, session.id, {
      type: "layer.create",
      layer: { id: "test-layer-child", name: "测试子层", description: "子层。", parentLayerId: "test-layer-parent", version: 1 },
    });
    expect(() => service.applyMapOperation(player.id, session.id, {
      type: "layer.update", layerId: "test-layer-parent", patch: { parentLayerId: "test-layer-child" },
    })).toThrow("自己的子层");
    service.acquireMapLocks(player.id, ["layer:test-layer-child"], session.id);
    service.applyMapOperation(player.id, session.id, { type: "layer.delete", layerId: "test-layer-child" });
    service.applyMapOperation(player.id, session.id, { type: "layer.delete", layerId: "test-layer-parent" });
    expect(service.getLayers().some((layer) => layer.id.startsWith("test-layer"))).toBe(false);
  });

  it("expires edit leases and supports undo and redo", () => {
    const first = service.createSession().player;
    const second = service.createSession().player;
    const session = service.acquireMapLocks(first.id, ["layer:world-root:chunk:0:0"]);
    expect(() => service.acquireMapLocks(second.id, ["layer:world-root:chunk:0:0"])).toThrow("正由其他玩家编辑");
    service.applyMapOperation(first.id, session.id, {
      type: "location.create",
      location: { id: "undo-place", layerId: "world-root", name: "可撤销地点", description: "撤销测试。", regionId: null, gridX: 3, gridY: 3 },
    });
    expect(service.undoMapOperation(first.id, session.id).history.canRedo).toBe(true);
    expect(() => service.getLocation("undo-place")).toThrow("已停用");
    expect(service.redoMapOperation(first.id, session.id).history.canUndo).toBe(true);
    db.prepare("UPDATE map_edit_locks SET lease_expires_at='2000-01-01T00:00:00.000Z'").run();
    db.prepare("UPDATE map_edit_sessions SET lease_expires_at='2000-01-01T00:00:00.000Z'").run();
    expect(service.acquireMapLocks(second.id, ["layer:world-root:chunk:0:0"]).scopes).toContain("layer:world-root:chunk:0:0");
  });

  it("caps detailed layer viewports while preserving chunk summaries", () => {
    const insert = db.prepare(`
      INSERT INTO locations(id,layer_id,name,region,description,x,y,region_id,grid_x,grid_y,chunk_x,chunk_y,version,is_active)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,1)
    `);
    for (let index = 0; index < 1_250; index += 1) {
      const gridX = 100 + (index % 40);
      const gridY = 100 + Math.floor(index / 40);
      insert.run(`bulk-${index}`, "world-root", `批量地点${index}`, "公共区域", "压力测试。", gridX * 160, gridY * 160, null, gridX, gridY, Math.floor((gridX * 160) / 1000), Math.floor((gridY * 160) / 1000));
    }
    const viewport = service.getMapViewport("world-root", 19, 18, 3, 1);
    expect(viewport.locations.length).toBeLessThanOrEqual(1_200);
    expect(viewport.loadedChunkCount).toBeLessThanOrEqual(49);
    const queryPlan = db.prepare(`EXPLAIN QUERY PLAN SELECT id FROM locations
      WHERE layer_id=? AND is_active=1 AND (chunk_x,chunk_y) IN (VALUES (?,?),(?,?))
      ORDER BY chunk_y,chunk_x,id LIMIT 1201`).all("world-root", 16, 16, 17, 16) as Array<{ detail: string }>;
    expect(queryPlan.some((step) => step.detail.includes("idx_locations_viewport"))).toBe(true);
  });

  it("normalizes chat and exposes deterministic China-standard time", () => {
    const player = service.createSession().player;
    expect(service.sendChat(player.id, "  诸位\n朋友，幸会。  ").content).toBe("诸位 朋友，幸会。");
    expect(() => service.sendChat(player.id, "江".repeat(121))).toThrow("最多120个字");
    expect(service.getWorldStatus(2, clock)).toMatchObject({ timeZone: "Asia/Shanghai", onlineCount: 2 });
  });
});
