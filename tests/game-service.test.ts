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
import { formatCashWen } from "../lib/game/currency";
import { clientMessageSchema } from "../lib/game/protocol";
import { marketExpiryAt } from "../lib/game/market";
import { npcAgentToken } from "../lib/game/npc-auth";
import { UtilityNpcController } from "../lib/game/npc-controller";
import { ensureNpcPopulation, NPC_POPULATION } from "../lib/game/npc-seed";
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
    expect(conciseLocationName("东京城·大内·宣德门")).toBe("宣德门");
    expect(conciseLocationName("东京城·惠民药铺")).toBe("惠民药铺");
  });

  it("formats authoritative cash in guan and wen", () => {
    expect(formatCashWen(0)).toBe("0文");
    expect(formatCashWen(50)).toBe("50文");
    expect(formatCashWen(1_000)).toBe("1贯");
    expect(formatCashWen(12_345)).toBe("12贯345文");
  });

  it("seeds a source-tracked 500+ location world and preserves all ordinary direction slots", () => {
    expect(service.getLayers().map((layer) => layer.id).sort()).toEqual([
      "home-ground",
      "kaifeng-guozijian-ground",
      "kaifeng-palace-ground",
      "kaifeng-panlou-ground",
      "kaifeng-prefecture-ground",
      "kaifeng-shop-bath-ground",
      "kaifeng-shop-books-ground",
      "kaifeng-shop-medicine-ground",
      "kaifeng-shop-pawn-ground",
      "kaifeng-shop-silk-ground",
      "kaifeng-shop-smithy-ground",
      "kaifeng-shop-tea-ground",
      "kaifeng-shop-warehouse-ground",
      "kaifeng-xiangguo-ground",
      "world-root",
    ]);
    expect(service.getLocation("home-entrance")).toMatchObject({ layerId: "home-ground", name: "玄关" });
    expect(service.getLocation("home-exterior")).toMatchObject({ layerId: "world-root", name: "嬴长嫚与楼夜秋之家·入口" });
    expect(service.getLocation("loumen-road")).toMatchObject({ layerId: "world-root", name: "楼门路" });
    expect(service.getLocation("song-landmark-gate-nanxun")).toMatchObject({ layerId: "world-root", regionId: "song", gridX: -35, gridY: 35 });
    expect(service.getLocation("song-landmark-bridge-zhou")).toMatchObject({ name: "东京城·州桥", gridX: -35, gridY: 7 });
    expect(service.getLocation("song-landmark-gate-xuande")).toMatchObject({ name: "东京城·大内·宣德门", gridX: -35, gridY: -7 });
    expect(service.getLocation("song-landmark-old-gate-zhuque")).toMatchObject({ name: "东京城·旧城·朱雀门", gridX: -35, gridY: 14 });
    expect(service.getLocation("song-landmark-temple-xiangguo")).toMatchObject({ name: "东京城·大相国寺", gridX: -15, gridY: 3 });
    expect(service.getLocation("world-construction-site")).toMatchObject({ layerId: "world-root", name: "东境建设中", gridX: 5, gridY: 2 });
    expect(service.getLocation("home-training-room")).toMatchObject({ layerId: "home-ground" });
    expect(service.getLocation("kaifeng-palace-daqing")).toMatchObject({ layerId: "kaifeng-palace-ground", name: "大内宫城·大庆殿" });
    expect(service.getLocation("kaifeng-prefecture-main-hall")).toMatchObject({ layerId: "kaifeng-prefecture-ground", name: "开封府署·府署正堂" });
    expect(service.searchMapLocations("world-root", "楼门路", 10)).toHaveLength(3);
    expect(db.prepare("SELECT COUNT(*) AS count FROM locations WHERE name='楼门路' AND is_active=1").get()).toEqual({ count: 3 });
    const validation = validateWorldMap(db);
    expect(validation.errors).toEqual([]);
    expect(validation.counts).toMatchObject({
      locations: 1050,
      routes: 1100,
      songLocations: 935,
      buildingLocations: 89,
      shopfrontLocations: 120,
      fastTravelLocations: 30,
      overworldLocations: 940,
    });
    expect(validation.counts.songLocations).toBeGreaterThanOrEqual(250);
    expect(validation.counts.locations).toBeGreaterThanOrEqual(500);
    expect(validation.counts.reachableLocations).toBe(validation.counts.locations);
    expect(validation.counts.overworldLocations).toBeGreaterThanOrEqual(890);
    expect(db.prepare("SELECT COUNT(*) AS count FROM world_sources WHERE id='source-song-map'").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM locations WHERE is_active=1 AND region_id='song' AND name LIKE '东京城·%'").get()).toEqual({ count: 933 });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM routes r
      JOIN locations f ON f.id=r.from_location JOIN locations t ON t.id=r.to_location
      WHERE r.is_active=1 AND r.id LIKE 'route-kaifeng-%' AND f.layer_id='world-root' AND t.layer_id='world-root'
    `).get()).toEqual({ count: 975 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM locations WHERE is_active=1 AND (region_id='palos' OR id LIKE 'palos-%')").get()).toEqual({ count: 0 });
    expect((db.prepare("SELECT COUNT(*) AS count FROM location_direction_slots").get() as { count: number }).count).toBeGreaterThan(500);
    expect((db.prepare("SELECT COUNT(*) AS count FROM routes r JOIN locations f ON f.id=r.from_location JOIN locations t ON t.id=r.to_location WHERE r.is_active=1 AND r.route_type<>'normal' AND f.layer_id='world-root' AND t.layer_id='world-root'").get() as { count: number }).count).toBe(0);
    expect(validation.counts.layers).toBe(15);
    expect(service.getTransitions("home-entrance")[0]).toMatchObject({ destinationName: "嬴长嫚与楼夜秋之家·入口", transitionKind: "door" });
    expect(service.getTransitions("song-landmark-gate-xuande")[0]).toMatchObject({ destinationName: "大内宫城·宣德门内", transitionKind: "gate" });
    expect(service.getTransitions("song-landmark-office-kaifeng")[0]).toMatchObject({ destinationName: "开封府署·府署正门内", transitionKind: "door" });
    expect(service.getTransitions("song-landmark-temple-xiangguo")[0]).toMatchObject({ destinationName: "大相国寺·山门内", transitionKind: "gate" });
    expect(db.prepare("SELECT facility_type FROM location_facilities WHERE location_id='song-landmark-bridge-zhou' AND is_active=1 ORDER BY facility_type").all())
      .toEqual([
        { facility_type: "fast-travel" }, { facility_type: "road" },
        { facility_type: "settlement" }, { facility_type: "surroundings" },
      ]);
    expect(db.prepare("SELECT facility_type FROM location_facilities WHERE location_id='song-landmark-market-zhou-night' AND is_active=1 ORDER BY facility_type").all())
      .toEqual([{ facility_type: "market" }, { facility_type: "road" }, { facility_type: "settlement" }, { facility_type: "surroundings" }]);
    expect(db.prepare("SELECT facility_type FROM location_facilities WHERE location_id='kaifeng-panlou-kitchen' AND is_active=1 ORDER BY facility_type").all())
      .toEqual([
        { facility_type: "kitchen" }, { facility_type: "market" }, { facility_type: "settlement" },
        { facility_type: "social" }, { facility_type: "surroundings" }, { facility_type: "water" },
      ]);
    expect(db.prepare(`
      SELECT f.facility_type FROM location_facilities f JOIN locations l ON l.id=f.location_id
      WHERE l.name='东京城·惠民药铺' AND f.is_active=1 ORDER BY f.facility_type
    `).all()).toEqual([
      { facility_type: "market" }, { facility_type: "settlement" },
      { facility_type: "shop" }, { facility_type: "surroundings" },
    ]);
  });

  it("reapplies the bundled world seed idempotently", () => {
    const before = db.prepare("SELECT COUNT(*) AS locations FROM locations").get();
    const first = importWorldSeed(db);
    const second = importWorldSeed(db);
    expect(first).toEqual(second);
    expect(db.prepare("SELECT COUNT(*) AS locations FROM locations").get()).toEqual(before);
    expect(validateWorldMap(db).ok).toBe(true);
  });

  it("persists map overrides and seed tombstones across reseed and restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "wuxia-map-overrides-"));
    const databasePath = join(directory, "game.db");
    try {
      const firstDb = openGameDatabase(databasePath);
      const firstService = new GameService(firstDb, () => new Date(clock), () => roll);
      const player = firstService.createSession().player;
      const session = firstService.acquireMapLocks(player.id, [
        "layer:world-root", "region:song", "region:home", "layer:home-ground:chunk:0:0",
        "layer:world-root:chunk:-1:-1", "layer:world-root:chunk:-1:0",
        "layer:world-root:chunk:0:-1", "layer:world-root:chunk:0:0",
        "layer:world-root:chunk:1:-1", "layer:world-root:chunk:1:0",
      ]);

      firstService.applyMapOperation(player.id, session.id, {
        type: "layer.update", layerId: "world-root", patch: { description: "玩家编辑的大世界描述。" },
      });
      firstService.applyMapOperation(player.id, session.id, {
        type: "region.update", regionId: "song", patch: { description: "玩家编辑的开封区域描述。" },
      });
      const overrideRoutes = firstDb.prepare(`
        SELECT id FROM routes WHERE is_active=1
        AND (from_location='home-training-room' OR to_location='home-training-room')
      `).all() as Array<{ id: string }>;
      for (const route of overrideRoutes) {
        firstService.applyMapOperation(player.id, session.id, { type: "route.delete", routeId: route.id });
      }
      firstService.applyMapOperation(player.id, session.id, {
        type: "location.update", locationId: "home-training-room", patch: { name: "玩家改名的地图地点" },
      });

      const constructionRoutes = firstDb.prepare(`
        SELECT id FROM routes WHERE is_active=1
        AND (from_location='world-construction-site' OR to_location='world-construction-site')
      `).all() as Array<{ id: string }>;
      expect(constructionRoutes.length).toBeGreaterThan(0);
      for (const route of constructionRoutes) {
        firstService.applyMapOperation(player.id, session.id, { type: "route.delete", routeId: route.id });
      }
      firstService.applyMapOperation(player.id, session.id, { type: "location.delete", locationId: "world-construction-site" });

      expect(firstDb.prepare("SELECT seed_revision FROM map_layers WHERE id='world-root'").get()).toEqual({ seed_revision: 0 });
      expect(firstDb.prepare("SELECT seed_revision FROM map_regions WHERE id='song'").get()).toEqual({ seed_revision: 0 });
      expect(firstDb.prepare("SELECT seed_revision FROM locations WHERE id='home-training-room'").get()).toEqual({ seed_revision: 0 });
      expect(firstDb.prepare("SELECT is_active,seed_revision FROM locations WHERE id='world-construction-site'").get())
        .toEqual({ is_active: 0, seed_revision: 0 });
      expect(firstDb.prepare("SELECT COUNT(*) AS count FROM map_seed_tombstones WHERE entity_type='location' AND entity_id='world-construction-site'").get())
        .toEqual({ count: 1 });
      expect(firstDb.prepare("SELECT COUNT(*) AS count FROM map_seed_tombstones WHERE entity_type='route' AND entity_id=?").get(constructionRoutes[0].id))
        .toEqual({ count: 1 });

      importWorldSeed(firstDb);
      expect(firstDb.prepare("SELECT description FROM map_layers WHERE id='world-root'").get()).toEqual({ description: "玩家编辑的大世界描述。" });
      expect(firstDb.prepare("SELECT description FROM map_regions WHERE id='song'").get()).toEqual({ description: "玩家编辑的开封区域描述。" });
      expect(firstDb.prepare("SELECT name FROM locations WHERE id='home-training-room'").get()).toEqual({ name: "玩家改名的地图地点" });
      expect(firstDb.prepare("SELECT is_active FROM locations WHERE id='world-construction-site'").get()).toEqual({ is_active: 0 });
      expect(firstDb.prepare("SELECT is_active FROM routes WHERE id=?").get(constructionRoutes[0].id)).toEqual({ is_active: 0 });
      firstDb.close();

      const restarted = openGameDatabase(databasePath);
      expect(restarted.prepare("SELECT description FROM map_layers WHERE id='world-root'").get()).toEqual({ description: "玩家编辑的大世界描述。" });
      expect(restarted.prepare("SELECT description FROM map_regions WHERE id='song'").get()).toEqual({ description: "玩家编辑的开封区域描述。" });
      expect(restarted.prepare("SELECT name FROM locations WHERE id='home-training-room'").get()).toEqual({ name: "玩家改名的地图地点" });
      expect(restarted.prepare("SELECT is_active FROM locations WHERE id='world-construction-site'").get()).toEqual({ is_active: 0 });
      expect(restarted.prepare("SELECT is_active FROM routes WHERE id=?").get(constructionRoutes[0].id)).toEqual({ is_active: 0 });
      restarted.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("migrates schema-v16 map edits into seed overrides and tombstones", () => {
    const directory = mkdtempSync(join(tmpdir(), "wuxia-map-migration-"));
    const databasePath = join(directory, "game.db");
    try {
      const legacy = openGameDatabase(databasePath);
      const legacyService = new GameService(legacy, () => new Date(clock), () => roll);
      const player = legacyService.createSession().player;
      const constructionRoute = legacy.prepare(`
        SELECT id FROM routes WHERE is_active=1
        AND (from_location='world-construction-site' OR to_location='world-construction-site')
        LIMIT 1
      `).get() as { id: string };
      const session = legacyService.acquireMapLocks(player.id, ["layer:world-root:chunk:0:0"]);
      legacyService.applyMapOperation(player.id, session.id, { type: "route.delete", routeId: constructionRoute.id });
      // Reproduce schema-v16 storage: route.delete physically removed the row
      // and retained only the edit-history operation.
      legacy.prepare("DELETE FROM map_seed_tombstones WHERE entity_type='route' AND entity_id=?").run(constructionRoute.id);
      legacy.prepare("DELETE FROM routes WHERE id=?").run(constructionRoute.id);
      legacy.prepare("UPDATE map_layers SET name='迁移后的大世界',version=2 WHERE id='world-root'").run();
      legacy.prepare("UPDATE locations SET is_active=0,version=2 WHERE id='world-construction-site'").run();
      legacy.prepare("DELETE FROM schema_migrations WHERE version>16").run();
      legacy.prepare("INSERT OR REPLACE INTO schema_migrations(version,applied_at) VALUES (16,?)").run(clock.toISOString());
      legacy.close();

      const upgraded = openGameDatabase(databasePath);
      expect(upgraded.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: MAP_SCHEMA_VERSION });
      expect(upgraded.prepare("SELECT name,seed_revision FROM map_layers WHERE id='world-root'").get())
        .toEqual({ name: "迁移后的大世界", seed_revision: 0 });
      expect(upgraded.prepare("SELECT is_active,seed_revision FROM locations WHERE id='world-construction-site'").get())
        .toEqual({ is_active: 0, seed_revision: 0 });
      expect(upgraded.prepare("SELECT COUNT(*) AS count FROM map_seed_tombstones WHERE entity_type='location' AND entity_id='world-construction-site'").get())
        .toEqual({ count: 1 });
      expect(upgraded.prepare("SELECT COUNT(*) AS count FROM map_seed_tombstones WHERE entity_type='route' AND entity_id=?").get(constructionRoute.id))
        .toEqual({ count: 1 });
      expect(upgraded.prepare("SELECT COUNT(*) AS count FROM routes WHERE id=?").get(constructionRoute.id)).toEqual({ count: 0 });
      upgraded.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects reverse transition and portal duplicates while retaining normal direction rules", () => {
    const player = service.createSession().player;
    const session = service.acquireMapLocks(player.id, [
      "layer:world-root", "layer:custom-portal-layer",
      "layer:world-root:chunk:16:16", "layer:custom-portal-layer:chunk:16:16",
    ]);
    service.applyMapOperation(player.id, session.id, {
      type: "layer.create",
      layer: { id: "custom-portal-layer", name: "跨层连接测试层", description: "跨层连接测试。", parentLayerId: "world-root", version: 1 },
    });
    service.applyMapOperation(player.id, session.id, {
      type: "location.create",
      location: { id: "portal-test-a", layerId: "world-root", name: "跨层甲", description: "甲。", regionId: null, gridX: 100, gridY: 100 },
    });
    service.applyMapOperation(player.id, session.id, {
      type: "location.create",
      location: { id: "portal-test-b", layerId: "custom-portal-layer", name: "跨层乙", description: "乙。", regionId: null, gridX: 100, gridY: 100 },
    });
    service.applyMapOperation(player.id, session.id, {
      type: "route.create", fromLocation: "portal-test-a", toLocation: "portal-test-b", routeType: "portal",
    });
    expect(() => service.applyMapOperation(player.id, session.id, {
      type: "route.create", fromLocation: "portal-test-b", toLocation: "portal-test-a", routeType: "transition", transitionKind: "door",
    })).toThrow("反向路线");
  });

  it("replaces an intermediate seed route when its stable ID receives final Kaifeng endpoints", () => {
    db.prepare("DELETE FROM location_direction_slots WHERE route_id='route-kaifeng-east-entry-1'").run();
    db.prepare("DELETE FROM routes WHERE id='route-kaifeng-east-entry-1'").run();
    db.prepare(`
      INSERT INTO routes(
        from_location,to_location,stamina_cost,id,route_type,transition_kind,
        from_direction,to_direction,version,is_active,seed_revision
      ) VALUES ('loumen-road-west','home-exterior',0,'route-kaifeng-east-entry-1','normal',NULL,
        'up-right','down-left',1,1,7)
    `).run();

    importWorldSeed(db);

    expect(db.prepare("SELECT from_location,to_location,seed_revision FROM routes WHERE id='route-kaifeng-east-entry-1'").get())
      .toEqual({ from_location: "song-overview-entry", to_location: "song-street-east-entry-m1-p2", seed_revision: 10 });
    expect(validateWorldMap(db).errors).toEqual([]);
  });

  it("moves players off retired circuit nodes when upgrading to the Tokyo Kaifeng map", () => {
    const directory = mkdtempSync(join(tmpdir(), "wuxia-kaifeng-migration-"));
    const databasePath = join(directory, "game.db");
    try {
      const before = openGameDatabase(databasePath);
      const player = new GameService(before, () => new Date(clock), () => roll).createSession().player;
      before.prepare(`
        INSERT INTO locations(
          id,layer_id,name,region,description,x,y,region_id,grid_x,grid_y,chunk_x,chunk_y,
          version,is_active,seed_revision
        ) VALUES ('song-revision-6-circuit','world-root','旧京畿路治所','旧大宋','旧二十四路节点。',
          -12800,-12800,'song',-80,-80,-13,-13,1,1,6)
      `).run();
      before.prepare("UPDATE players SET current_location='song-revision-6-circuit' WHERE id=?").run(player.id);
      before.prepare(`
        INSERT OR REPLACE INTO player_visited_locations(player_id,location_id,first_visited_at,last_visited_at)
        VALUES (?,'song-revision-6-circuit',?,?)
      `).run(player.id, clock.toISOString(), clock.toISOString());
      before.close();

      const upgraded = openGameDatabase(databasePath);
      const upgradedService = new GameService(upgraded, () => new Date(clock), () => roll);
      expect(upgradedService.getPlayer(player.id).currentLocation).toBe("song-gate");
      expect(upgraded.prepare("SELECT is_active FROM locations WHERE id='song-revision-6-circuit'").get()).toEqual({ is_active: 0 });
      expect(upgradedService.getVisitedMap(player.id).locations.map((location) => location.id)).toContain("song-gate");
      expect(upgradedService.getVisitedMap(player.id).locations.map((location) => location.id)).not.toContain("song-revision-6-circuit");
      upgraded.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("installs schema-v11 market, economy and active-skill storage without breaking legacy actions", () => {
    const requiredTables = [
      "action_templates", "location_facilities", "location_action_bindings", "action_jobs", "player_needs",
      "skill_definitions", "player_skills", "item_definitions", "item_instances", "recipe_definitions",
      "crop_definitions", "farm_plots", "interaction_requests", "player_relationships", "trade_sessions",
      "combat_sessions", "loot_piles", "npc_profiles", "agent_credentials",
      "player_action_cooldowns", "player_active_skills",
      "player_wallets", "currency_ledger", "player_starter_grants", "shops", "shop_service_locations", "shop_stock", "shop_transactions",
      "market_underlyings", "market_contracts", "market_accounts", "market_orders", "market_trades", "market_positions", "market_ticks", "market_liquidations",
    ];
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((row) => row.name));
    expect(requiredTables.every((table) => tables.has(table))).toBe(true);
    expect(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: MAP_SCHEMA_VERSION });
    expect(db.prepare("SELECT skill_kind FROM skill_definitions WHERE id='eagle-eye'").get()).toEqual({ skill_kind: "active" });
    expect(db.prepare("SELECT skill_kind FROM skill_definitions WHERE id='perception'").get()).toEqual({ skill_kind: "passive" });
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

  it("seeds 240 persistent credentialed NPC actors without exposing controller identity publicly", async () => {
    expect(db.prepare("SELECT COUNT(*) AS count FROM players WHERE controller_kind='npc'").get()).toEqual({ count: NPC_POPULATION });
    expect(db.prepare("SELECT COUNT(*) AS count FROM npc_profiles").get()).toEqual({ count: NPC_POPULATION });
    expect(db.prepare("SELECT COUNT(*) AS count FROM agent_credentials WHERE label='npc-runner'").get()).toEqual({ count: NPC_POPULATION });
    expect(db.prepare("SELECT COUNT(*) AS count FROM sessions s JOIN players p ON p.id=s.player_id WHERE p.controller_kind='npc'").get()).toEqual({ count: 0 });
    ensureNpcPopulation(db, clock.toISOString());
    expect(db.prepare("SELECT COUNT(*) AS count FROM npc_profiles").get()).toEqual({ count: NPC_POPULATION });

    const npc = service.getPlayerByAgentToken(npcAgentToken("npc-001"));
    expect(npc).toMatchObject({ id: "npc-001", defeated: false });
    expect(service.getPlayerByAgentToken("invalid-agent-token")).toBeNull();
    const publicNpc = service.getOnlinePlayers(["npc-001"])[0];
    expect(publicNpc).toEqual(expect.objectContaining({ id: "npc-001", name: npc!.name, currentLocation: npc!.currentLocation }));
    expect(publicNpc).not.toHaveProperty("controllerKind");

    const snapshot = service.getSnapshot("npc-001", ["npc-001"]);
    const decision = await new UtilityNpcController(() => 0).decide({ actorId: "npc-001", snapshot, serverTime: snapshot.world.serverTime });
    expect(decision).toMatchObject({ type: "action.start" });
  });

  it("creates, versions, binds and persistently customizes structured action rules", () => {
    const custom = {
      id: "custom-test-action", name: "测试整理", description: "用于规则编辑测试。", category: "life" as const,
      targetKind: "self" as const, durationSeconds: 60, requirements: {}, check: {}, costs: {},
      success: { cashWenDelta: 2_000 }, failure: {}, resultTemplate: "{name}完成测试整理。",
      adult: false, visibility: "private" as const, cooldownSeconds: 0,
    };
    expect(service.createActionRule(custom).rules.actions.find((action) => action.id === custom.id)).toMatchObject({ version: 1, seedRevision: 0 });
    service.upsertActionRuleBinding("home-entrance", custom.id, null, 7);
    expect(service.getActionRuleLocationState("home-entrance").bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ actionId: custom.id, priority: 7 }),
    ]));
    const player = service.createSession().player;
    expect(service.getActionState(player.id).available.map((action) => action.id)).toContain(custom.id);

    service.updateActionRule(custom.id, 1, { ...custom, name: "测试整理二版" });
    expect(service.getActionRuleSnapshot().actions.find((action) => action.id === custom.id)).toMatchObject({ name: "测试整理二版", version: 2 });
    expect(() => service.updateActionRule(custom.id, 1, { ...custom, name: "过期修改" })).toThrow("其他编辑者修改");

    const observe = service.getActionRuleSnapshot().actions.find((action) => action.id === "action-observe")!;
    service.updateActionRule(observe.id, observe.version, { ...observe, name: "自定义观察", description: "保留的玩家修改。" });
    importWorldSeed(db);
    expect(service.getActionRuleSnapshot().actions.find((action) => action.id === observe.id)).toMatchObject({
      name: "自定义观察", seedRevision: 0,
    });

    expect(() => service.createActionRule({
      ...custom, id: "unsafe-adult-action", adult: true, targetKind: "player", visibility: "public",
      requirements: { sameLocation: true, targetOnline: true },
    })).toThrow("只对双方参与者可见");
    expect(() => service.createActionRule({
      ...custom, id: "missing-item-action", success: { items: [{ definitionId: "missing-item", quantity: 1 }] },
    })).toThrow("物品定义 missing-item 不存在");
    expect(() => service.createActionRule({
      ...custom, id: "positive-cost-action", costs: { cashWenDelta: 1 },
    })).toThrow("行动成本只能消耗");
    const binding = service.getActionRuleLocationState("home-entrance").bindings.find((item) => item.actionId === custom.id)!;
    service.deleteActionRuleBinding(binding.id);
    expect(service.getActionRuleLocationState("home-entrance").bindings.some((item) => item.actionId === custom.id)).toBe(false);
    service.deleteActionRule(custom.id);
    expect(service.getActionRuleSnapshot().actions.some((action) => action.id === custom.id)).toBe(false);
  });

  it("enforces action facilities, item costs, cash costs and ordinary cooldowns", () => {
    const custom = {
      id: "costed-demo-action", name: "付费整理", description: "需要厨房和一份稻米。", category: "life" as const,
      targetKind: "self" as const, durationSeconds: 60,
      requirements: { facilityType: "kitchen", minimumFacilityQuality: 1, itemCosts: [{ definitionId: "rice", quantity: 1 }] },
      check: {}, costs: { cashWenDelta: -100, hpDelta: -1 }, success: {}, failure: {},
      resultTemplate: "{name}完成了付费整理。", adult: false, visibility: "private" as const, cooldownSeconds: 300,
    };
    service.createActionRule(custom);
    service.upsertActionRuleBinding("home-entrance", custom.id, null, 0);
    service.upsertActionRuleBinding("home-kitchen", custom.id, null, 0);
    const player = service.createSession().player;
    const rice = db.prepare("SELECT id FROM item_definitions WHERE id='rice'").get();
    expect(rice).toEqual({ id: "rice" });
    db.prepare(`
      INSERT INTO item_instances(id,definition_id,owner_player_id,quantity,quality,durability,affixes_json,bound,created_at,updated_at)
      VALUES ('test-rice','rice',?,1,1,0,'[]',0,?,?)
    `).run(player.id, clock.toISOString(), clock.toISOString());
    expect(service.getActionState(player.id).available.find((action) => action.id === custom.id))
      .toMatchObject({ available: false, unavailableReason: expect.stringContaining("kitchen") });
    db.prepare("UPDATE players SET current_location='home-kitchen' WHERE id=?").run(player.id);
    const beforeCash = service.getPlayer(player.id).cashWen;
    const started = service.startAction(player.id, custom.id);
    expect(started.message).toContain("已经开始");
    expect(service.getPlayer(player.id).cashWen).toBe(beforeCash - 100);
    expect(db.prepare("SELECT quantity FROM item_reservations WHERE job_id=(SELECT id FROM action_jobs WHERE player_id=? AND status='running')").get(player.id))
      .toEqual({ quantity: 1 });
    expect(() => service.startAction(player.id, custom.id)).toThrow("冷却");
    clock = new Date(clock.getTime() + 61_000);
    service.settleActionQueue(player.id);
    expect(db.prepare("SELECT COUNT(*) AS count FROM item_instances WHERE id='test-rice'").get()).toEqual({ count: 0 });
  });

  it("settles a running action from its accepted rule snapshot", () => {
    const custom = {
      id: "snapshot-demo-action", name: "快照行动", description: "测试规则快照。", category: "life" as const,
      targetKind: "self" as const, durationSeconds: 60, requirements: {}, check: {}, costs: {},
      success: { cashWenDelta: 111 }, failure: {}, resultTemplate: "{name}执行快照行动。",
      adult: false, visibility: "private" as const, cooldownSeconds: 0,
    };
    service.createActionRule(custom);
    service.upsertActionRuleBinding("home-entrance", custom.id, null, 0);
    const player = service.createSession().player;
    service.startAction(player.id, custom.id);
    const rule = service.getActionRuleSnapshot().actions.find((action) => action.id === custom.id)!;
    service.updateActionRule(custom.id, rule.version, { ...custom, success: { cashWenDelta: 9_999 }, resultTemplate: "{name}被篡改。" });
    clock = new Date(clock.getTime() + 61_000);
    service.settleActionQueue(player.id);
    expect(service.getPlayer(player.id).cashWen).toBe(20_111);
    expect(db.prepare("SELECT result_text FROM action_jobs WHERE player_id=? ORDER BY created_at DESC LIMIT 1").get(player.id)).toEqual(
      expect.objectContaining({ result_text: expect.stringContaining("执行快照行动") }),
    );
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
    const starterSeeds = inventory.items.find((item) => item.definitionId === "rice-seed")!;
    db.prepare("DELETE FROM item_instances WHERE id=?").run(starterSeeds.id);
    expect(service.getInventoryState(player.id).items.some((item) => item.id === starterSeeds.id)).toBe(false);
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

  it("runs finite-stock Song retail with cash ledger, opening hours and idempotent requests", () => {
    expect(db.prepare("SELECT COUNT(*) AS count FROM shops WHERE is_active=1").get()).toEqual({ count: 120 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM shop_service_locations").get()).toEqual({ count: 168 });
    const player = service.createSession().player;
    const medicine = db.prepare("SELECT id,location_id,till_wen FROM shops WHERE name='惠民药铺'").get() as {
      id: string; location_id: string; till_wen: number;
    };
    db.prepare("UPDATE players SET current_location=? WHERE id=?").run(medicine.location_id, player.id);
    expect(service.getCurrentShopSummary(player.id)).toMatchObject({ id: medicine.id, name: "惠民药铺", isOpen: true });
    const inspected = service.inspectShop(player.id, medicine.id);
    const poultice = inspected.stock.find((item) => item.definitionId === "healing-poultice")!;
    const originalStock = poultice.quantity;

    const bought = service.buyFromShop(player.id, "shop-buy-request", medicine.id, poultice.definitionId, 1);
    expect(bought.player.cashWen).toBe(20_000 - poultice.buyPriceWen);
    expect(bought.shop.stock.find((item) => item.definitionId === poultice.definitionId)?.quantity).toBe(originalStock - 1);
    expect(db.prepare("SELECT till_wen FROM shops WHERE id=?").get(medicine.id)).toEqual({ till_wen: medicine.till_wen + poultice.buyPriceWen });
    expect(db.prepare("SELECT delta_wen FROM currency_ledger WHERE player_id=? ORDER BY rowid DESC LIMIT 1").get(player.id))
      .toEqual({ delta_wen: -poultice.buyPriceWen });
    expect(db.prepare("SELECT COUNT(*) AS count FROM shop_transactions WHERE player_id=? AND request_id='shop-buy-request'").get(player.id))
      .toEqual({ count: 1 });

    const replayed = service.buyFromShop(player.id, "shop-buy-request", medicine.id, poultice.definitionId, 1);
    expect(replayed.player.cashWen).toBe(bought.player.cashWen);
    expect(replayed.shop.stock.find((item) => item.definitionId === poultice.definitionId)?.quantity).toBe(originalStock - 1);
    expect(() => service.buyFromShop(player.id, "shop-buy-request", medicine.id, poultice.definitionId, 2))
      .toThrow("同一请求编号");

    const purchased = service.getInventoryState(player.id).items.find((item) => item.definitionId === poultice.definitionId && !item.bound)!;
    const sold = service.sellToShop(player.id, "shop-sell-request", medicine.id, purchased.id, 1);
    expect(sold.player.cashWen).toBe(20_000 - poultice.buyPriceWen + poultice.sellPriceWen);
    expect(sold.shop.stock.find((item) => item.definitionId === poultice.definitionId)?.quantity).toBe(originalStock);
    const bound = service.getInventoryState(player.id).items.find((item) => item.bound)!;
    expect(() => service.sellToShop(player.id, "shop-bound-request", medicine.id, bound.id, 1)).toThrow("绑定物品不能出售");

    db.prepare("UPDATE shop_stock SET quantity=3 WHERE shop_id=? AND item_definition_id=?").run(medicine.id, poultice.definitionId);
    importWorldSeed(db);
    expect(db.prepare("SELECT quantity FROM shop_stock WHERE shop_id=? AND item_definition_id=?").get(medicine.id, poultice.definitionId))
      .toEqual({ quantity: 3 });

    const beforeFailure = db.prepare("SELECT quantity FROM shop_stock WHERE shop_id=? AND item_definition_id=?").get(medicine.id, poultice.definitionId);
    db.prepare("UPDATE player_wallets SET cash_wen=0 WHERE player_id=?").run(player.id);
    expect(() => service.buyFromShop(player.id, "shop-no-cash", medicine.id, poultice.definitionId, 1)).toThrow("钱贯不足");
    expect(db.prepare("SELECT quantity FROM shop_stock WHERE shop_id=? AND item_definition_id=?").get(medicine.id, poultice.definitionId)).toEqual(beforeFailure);

    clock = new Date("2026-08-03T15:00:00.000Z");
    expect(service.getCurrentShopSummary(player.id)).toMatchObject({ isOpen: false });
    expect(() => service.buyFromShop(player.id, "shop-closed", medicine.id, poultice.definitionId, 1)).toThrow("已经打烊");
    db.prepare("UPDATE players SET current_location='home-entrance' WHERE id=?").run(player.id);
    expect(() => service.inspectShop(player.id, medicine.id)).toThrow("不在当前位置");

    expect(clientMessageSchema.safeParse({ type: "shop.buy", requestId: "test", shopId: medicine.id, definitionId: poultice.definitionId, quantity: 1 }).success).toBe(true);
    expect(clientMessageSchema.safeParse({ type: "trade.offer", requestId: "test", tradeId: "trade", cashWen: 1_000, items: [] }).success).toBe(true);
    expect(clientMessageSchema.safeParse({ type: "trade.offer", requestId: "test", tradeId: "trade", silver: 1, items: [] }).success).toBe(false);
  });

  it("matches spot, futures and options with partial fills, margin and minute settlement", () => {
    const first = service.createSession().player;
    const second = service.createSession().player;
    const marketLocation = (db.prepare("SELECT location_id FROM shops WHERE name='惠民药铺'").get() as { location_id: string }).location_id;
    db.prepare("UPDATE players SET current_location=? WHERE id IN (?,?)").run(marketLocation, first.id, second.id);
    expect(marketExpiryAt(clock, 1)).toBe("2026-08-04T12:00:00.000Z");

    let market = service.getMarketSnapshot(first.id);
    expect(market.underlyings).toHaveLength(10);
    expect(market.contracts).toHaveLength(100);
    expect(db.prepare("SELECT COUNT(*) AS count FROM market_orders WHERE owner_kind='guild' AND status='open'").get()).toEqual({ count: 200 });

    const riceSpot = market.contracts.find((contract) => contract.id === "spot-rice")!;
    service.placeMarketOrder(first.id, "market-spot-buy", riceSpot.id, "buy", riceSpot.bestAskWen!, 1);
    market = service.getMarketSnapshot(first.id);
    expect(market.positions.find((position) => position.contractId === riceSpot.id)?.quantity).toBe(1);
    expect(service.getPlayer(first.id).cashWen).toBe(20_000 - riceSpot.bestAskWen!);
    const afterSpotReplay = service.placeMarketOrder(first.id, "market-spot-buy", riceSpot.id, "buy", riceSpot.bestAskWen!, 1);
    expect(afterSpotReplay.market.positions.find((position) => position.contractId === riceSpot.id)?.quantity).toBe(1);
    expect(() => service.placeMarketOrder(first.id, "market-spot-buy", riceSpot.id, "buy", riceSpot.bestAskWen!, 2))
      .toThrow("同一请求编号");

    const future = market.contracts.find((contract) => contract.underlyingId === "rice" && contract.kind === "future" && contract.horizonDays === 1)!;
    const midpoint = Math.floor((future.bestBidWen! + future.bestAskWen!) / 2);
    const resting = service.placeMarketOrder(first.id, "market-future-rest", future.id, "buy", midpoint, 2);
    expect(resting.market.orders.find((order) => order.contractId === future.id)?.remainingQuantity).toBe(2);
    service.placeMarketOrder(second.id, "market-future-cross", future.id, "sell", midpoint, 1);
    market = service.getMarketSnapshot(first.id);
    expect(market.positions.find((position) => position.contractId === future.id)?.quantity).toBe(1);
    expect(market.orders.find((order) => order.contractId === future.id)?.remainingQuantity).toBe(1);
    service.cancelMarketOrder(first.id, "cancel-market-future", market.orders.find((order) => order.contractId === future.id)!.id);
    expect(service.getMarketSnapshot(first.id).orders.some((order) => order.contractId === future.id)).toBe(false);

    market = service.getMarketSnapshot(first.id);
    const call = market.contracts.find((contract) => contract.underlyingId === "rice" && contract.kind === "call" && contract.horizonDays === 1)!;
    service.placeMarketOrder(first.id, "market-call-buy", call.id, "buy", call.bestAskWen!, 1);
    market = service.getMarketSnapshot(first.id);
    const refreshedCall = market.contracts.find((contract) => contract.id === call.id)!;
    service.placeMarketOrder(first.id, "market-call-write", call.id, "sell", refreshedCall.bestBidWen!, 2);
    market = service.getMarketSnapshot(first.id);
    expect(market.positions.find((position) => position.contractId === call.id)?.quantity).toBe(-1);
    expect(market.reservedMarginWen).toBeGreaterThan(0);

    clock = new Date(clock.getTime() + 60_000);
    service.getMarketSnapshot(first.id);
    expect(db.prepare("SELECT COUNT(*) AS count FROM market_ticks").get()).toEqual({ count: 20 });
    db.prepare("UPDATE player_wallets SET cash_wen=0 WHERE player_id=?").run(first.id);
    clock = new Date(clock.getTime() + 60_000);
    market = service.getMarketSnapshot(first.id);
    expect(market.positions.some((position) => position.kind === "future" || position.quantity < 0)).toBe(false);
    expect(market.clearingDebtWen).toBeGreaterThan(0);
    expect((db.prepare("SELECT COUNT(*) AS count FROM market_liquidations WHERE player_id=?").get(first.id) as { count: number }).count).toBeGreaterThan(0);

    expect(clientMessageSchema.safeParse({
      type: "market.order.place", requestId: "market-test", contractId: future.id,
      side: "sell", limitPriceWen: midpoint, quantity: 1,
    }).success).toBe(true);
  });

  it("cash-settles European derivatives at the real China-time expiry", () => {
    const player = service.createSession().player;
    const marketLocation = (db.prepare("SELECT location_id FROM shops WHERE name='惠民药铺'").get() as { location_id: string }).location_id;
    db.prepare("UPDATE players SET current_location=? WHERE id=?").run(marketLocation, player.id);
    let market = service.getMarketSnapshot(player.id);
    const call = market.contracts.find((contract) => contract.underlyingId === "rice" && contract.kind === "call" && contract.horizonDays === 1)!;
    service.placeMarketOrder(player.id, "expiry-call-buy", call.id, "buy", call.bestAskWen!, 1);
    expect(service.getMarketSnapshot(player.id).positions.find((position) => position.contractId === call.id)?.quantity).toBe(1);
    clock = new Date(new Date(call.expiryAt!).getTime() + 1);
    market = service.getMarketSnapshot(player.id);
    expect(market.positions.some((position) => position.contractId === call.id)).toBe(false);
    expect(db.prepare("SELECT status FROM market_contracts WHERE id=?").get(call.id)).toEqual({ status: "settled" });
    expect(db.prepare("SELECT quantity FROM market_positions WHERE player_id=? AND contract_id=?").get(player.id, call.id)).toEqual({ quantity: 0 });
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

  it("tracks Eagle Eye duration, supports active stop, preserves cooldown and expires effects", () => {
    const player = service.createSession().player;
    const before = service.getSnapshot(player.id, [player.id]);
    expect(before.self.visionDepth).toBe(3);
    expect(service.getVisitedMap(player.id).locations).toHaveLength(1);
    expect(before.self.skills.filter((skill) => skill.kind === "active").map((skill) => skill.id).sort()).toEqual([
      "eagle-eye", "qinggong", "stealth",
    ]);
    expect(before.self.skills.find((skill) => skill.id === "perception")).toMatchObject({ kind: "passive" });
    expect(before.self.skills.find((skill) => skill.id === "eagle-eye")).toMatchObject({
      kind: "active", activeActionId: "action-eagle-eye", effectDurationSeconds: 1800,
      cooldownUntil: null, activeStartedAt: null, activeUntil: null,
    });
    expect(before.actionState.available.some((action) => action.id === "action-eagle-eye")).toBe(false);
    expect(() => service.startAction(player.id, "action-eagle-eye")).toThrow("技能页发动");
    expect(() => service.useActiveSkill(player.id, "perception")).toThrow("不是可主动发动的技能");

    const result = service.useActiveSkill(player.id, "eagle-eye");
    expect(result).toMatchObject({ success: true });
    expect(service.getActionState(player.id).current).toBeNull();
    expect(service.getActionState(player.id).queued).toEqual([]);
    const expanded = service.getSnapshot(player.id, [player.id]);
    expect(expanded.self.visionDepth).toBe(4);
    expect(expanded.locations.length).toBeGreaterThan(before.locations.length);
    expect(service.getVisitedMap(player.id).locations).toHaveLength(1);
    expect(expanded.self.skills.find((skill) => skill.id === "eagle-eye")?.cooldownUntil)
      .toBe("2026-08-03T12:30:00.000Z");
    expect(expanded.self.skills.find((skill) => skill.id === "eagle-eye")).toMatchObject({
      effectDurationSeconds: 1800,
      activeStartedAt: "2026-08-03T12:00:00.000Z",
      activeUntil: "2026-08-03T12:30:00.000Z",
    });
    expect(db.prepare("SELECT skill_id,expires_at FROM player_active_skills WHERE player_id=?").get(player.id)).toEqual({
      skill_id: "eagle-eye", expires_at: "2026-08-03T12:30:00.000Z",
    });
    expect(db.prepare("SELECT available_at FROM player_action_cooldowns WHERE player_id=? AND action_template_id='action-eagle-eye'").get(player.id))
      .toEqual({ available_at: "2026-08-03T12:30:00.000Z" });
    expect(() => service.useActiveSkill(player.id, "eagle-eye")).toThrow("技能正在持续中");

    const expiringPlayer = service.createSession().player;
    service.useActiveSkill(expiringPlayer.id, "eagle-eye");
    expect(service.stopActiveSkill(player.id, "eagle-eye").message).toContain("主动停止了鹰眼");
    expect(service.getPlayer(player.id)).toMatchObject({ visionDepth: 3 });
    expect(service.getPlayer(player.id).skills.find((skill) => skill.id === "eagle-eye")).toMatchObject({
      activeStartedAt: null, activeUntil: null, cooldownUntil: "2026-08-03T12:30:00.000Z",
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM player_active_skills WHERE player_id=?").get(player.id)).toEqual({ count: 0 });
    expect(service.getPrivateEvents(player.id)[0].content).toContain("冷却保持不变");
    expect(() => service.stopActiveSkill(player.id, "eagle-eye")).toThrow("没有持续中的效果");
    expect(() => service.useActiveSkill(player.id, "eagle-eye")).toThrow("技能冷却中");

    clock = new Date(clock.getTime() + 30 * 60_000);
    expect(service.getPlayer(player.id).visionDepth).toBe(3);
    expect(service.getPlayer(player.id).skills.find((skill) => skill.id === "eagle-eye")?.cooldownUntil).toBeNull();
    expect(service.getPlayer(expiringPlayer.id).visionDepth).toBe(3);
    expect(service.getPlayer(expiringPlayer.id).skills.find((skill) => skill.id === "eagle-eye")?.activeUntil).toBeNull();
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

  it("marks straight eight-direction Qinggong targets and resolves movement immediately with persistent cooldown", () => {
    const player = service.createSession().player;
    expect(service.getQinggongTargets(player.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ locationId: "home-main-bedroom", direction: "down", distance: 2, available: true, cooldownUntil: null }),
    ]));
    expect(service.getQinggongTargets(player.id).some((target) => target.locationId === "home-garage")).toBe(false);
    db.prepare("UPDATE player_skills SET level=40 WHERE player_id=? AND skill_id='qinggong'").run(player.id);
    expect(service.getQinggongTargets(player.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ locationId: "home-garage", direction: "right", distance: 3, available: true }),
      expect.objectContaining({ locationId: "home-back-garden", direction: "down", distance: 4, available: true }),
    ]));

    const result = service.useQinggong(player.id, "home-main-bedroom");
    expect(result).toMatchObject({ success: true, cooldownUntil: "2026-08-03T12:01:00.000Z" });
    expect(service.getPlayer(player.id).currentLocation).toBe("home-main-bedroom");
    expect(service.getActionState(player.id)).toMatchObject({ current: null, queued: [] });
    expect(service.getVisitedMap(player.id).locations.map((location) => location.id)).toContain("home-main-bedroom");
    expect(db.prepare("SELECT available_at FROM player_action_cooldowns WHERE player_id=? AND action_template_id='action-qinggong'").get(player.id))
      .toEqual({ available_at: "2026-08-03T12:01:00.000Z" });
    expect(service.getQinggongTargets(player.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ locationId: "home-entrance", available: false, cooldownUntil: "2026-08-03T12:01:00.000Z" }),
    ]));
    expect(() => service.useQinggong(player.id, "home-entrance")).toThrow("轻功冷却中");
    clock = new Date(clock.getTime() + 60_000);
    expect(service.getQinggongTargets(player.id).find((target) => target.locationId === "home-entrance"))
      .toMatchObject({ available: true, cooldownUntil: null });

    const failedPlayer = service.createSession().player;
    const initialHp = failedPlayer.hp;
    roll = 99;
    const failedResult = service.useQinggong(failedPlayer.id, "home-main-bedroom");
    expect(failedResult).toMatchObject({ success: false });
    const failed = service.getPlayer(failedPlayer.id);
    expect(failed.currentLocation).toBe("home-entrance");
    expect(failed.hp).toBe(initialHp - 5);
    expect(failed.needs.fatigue).toBeGreaterThanOrEqual(5);
    expect(service.getVisitedMap(failedPlayer.id).locations).toHaveLength(1);
    expect(service.getActionState(failedPlayer.id)).toMatchObject({ current: null, queued: [] });
    expect(service.getQinggongTargets(failedPlayer.id).every((target) => !target.available)).toBe(true);
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
    const secondRequest = service.getSocialState(second.id).incomingRequests[0];
    service.respondInteraction(second.id, secondRequest.id, true, [first.id, second.id]);
    service.updateAdultProfile(second.id, "minor", true);
    expect(service.getSocialState(second.id).adultProfile).toEqual({ status: "minor", contentEnabled: false });
    expect(service.getSocialState(first.id).outgoingRequests).toHaveLength(0);
    expect(db.prepare(`
      SELECT status,result_text FROM action_jobs WHERE player_id=? ORDER BY created_at DESC,id DESC LIMIT 1
    `).get(first.id)).toEqual({ status: "cancelled", result_text: "成人资格或同意已撤销，行动已取消。" });
    clock = new Date(clock.getTime() + 900_000);
    service.settleActionQueue(first.id);
    expect(service.getPrivateEvents(first.id).filter((event) => event.content.includes("私密互动"))).toHaveLength(1);
    expect(service.getPrivateEvents(second.id).filter((event) => event.content.includes("私密互动"))).toHaveLength(1);
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

  it("atomically exchanges unbound items and cash wen after both trade confirmations", () => {
    const first = service.createSession().player;
    const second = service.createSession().player;
    db.prepare(`
      INSERT INTO item_instances(id,definition_id,owner_player_id,quantity,quality,durability,affixes_json,bound,created_at,updated_at)
      VALUES ('trade-rice','rice',?,3,2,0,'[]',0,?,?)
    `).run(first.id, clock.toISOString(), clock.toISOString());
    service.requestTrade(first.id, second.id);
    const tradeId = service.getSocialState(second.id).trades[0].id;
    service.respondTrade(second.id, tradeId, true, [first.id, second.id]);
    service.offerTrade(first.id, tradeId, 5_000, [{ itemId: "trade-rice", quantity: 2 }]);
    service.offerTrade(second.id, tradeId, 3_000, []);
    expect(service.confirmTrade(first.id, tradeId).message).toContain("等待对方");
    expect(service.getSocialState(first.id).trades[0]).toMatchObject({ ownConfirmed: true, otherConfirmed: false });
    expect(service.confirmTrade(second.id, tradeId).message).toBe("交易完成。");

    expect(service.getPlayer(first.id).cashWen).toBe(18_000);
    expect(service.getPlayer(second.id).cashWen).toBe(22_000);
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

  it("runs 30-second combat turns, auto-defends timeouts, and auto-flees after three misses", () => {
    const attacker = service.createSession().player;
    const defender = service.createSession().player;
    service.requestInteraction(attacker.id, defender.id, "duel");
    const requestId = service.getSocialState(defender.id).incomingRequests[0].id;
    service.respondInteraction(defender.id, requestId, true, [attacker.id, defender.id]);
    const started = { combatId: service.getCombatState(attacker.id)!.id };
    expect(service.getCombatState(attacker.id)).toMatchObject({ selfTurn: true, opponentId: defender.id, round: 1 });
    expect(() => service.chooseCombatAction(defender.id, started.combatId, "attack")).toThrow("不是你的战斗回合");
    service.chooseCombatAction(attacker.id, started.combatId, "defend");
    expect(service.getCombatState(defender.id)).toMatchObject({ selfTurn: true, opponentId: attacker.id });
    expect(() => service.move(attacker.id, "home-hall")).toThrow("战斗尚未结束");

    clock = new Date(clock.getTime() + 5 * 30_000);
    expect(service.settleDueCombats()).toEqual(expect.arrayContaining([attacker.id, defender.id]));
    expect(service.getCombatState(attacker.id)).toBeNull();
    expect(db.prepare("SELECT status,loser_id FROM combat_sessions WHERE id=?").get(started.combatId)).toEqual({ status: "fled", loser_id: defender.id });
    expect(db.prepare("SELECT COUNT(*) AS count FROM combat_turns WHERE combat_id=? AND choice='timeout-defend'").get(started.combatId))
      .toEqual({ count: 4 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM loot_piles").get()).toEqual({ count: 0 });
    expect(service.getPlayer(defender.id).hp).toBe(defender.hp);
  });

  it("drops all cash wen and unbound items on defeat, then supports loot pickup and half-health respawn", () => {
    const attacker = service.getPlayer("npc-001");
    const defender = service.createSession().player;
    db.prepare(`
      INSERT INTO item_instances(id,definition_id,owner_player_id,quantity,quality,durability,affixes_json,bound,equipped_slot,created_at,updated_at)
      VALUES ('combat-rice','rice',?,4,2,0,'[]',0,NULL,?,?),
             ('combat-boots','cloth-boots',?,1,3,100,'[]',0,'feet',?,?)
    `).run(defender.id, clock.toISOString(), clock.toISOString(), defender.id, clock.toISOString(), clock.toISOString());
    db.prepare("UPDATE players SET current_location='loumen-road' WHERE id IN (?,?)").run(attacker.id, defender.id);
    db.prepare("UPDATE players SET hp=1,created_at=? WHERE id=?")
      .run(new Date(clock.getTime() - 2 * 60 * 60_000).toISOString(), defender.id);
    const boundCount = (db.prepare("SELECT COUNT(*) AS count FROM item_instances WHERE owner_player_id=? AND bound=1").get(defender.id) as { count: number }).count;
    const combat = service.startCombat(attacker.id, defender.id);
    service.chooseCombatAction(attacker.id, combat.combatId, "attack");

    expect(service.getPlayer(defender.id)).toMatchObject({ hp: 0, cashWen: 0, defeated: true });
    const piles = service.getLootPiles("loumen-road");
    expect(piles).toHaveLength(1);
    expect(piles[0]).toMatchObject({ cashWen: 20_000, sourcePlayerId: defender.id });
    expect(piles[0].items).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "稻米", quantity: 4 }),
      expect.objectContaining({ name: "布靴", quantity: 1 }),
    ]));
    expect(Object.getPrototypeOf(piles[0])).toBe(Object.prototype);
    expect(piles[0].items.every((item) => Object.getPrototypeOf(item) === Object.prototype)).toBe(true);
    expect(Object.getPrototypeOf(service.getSnapshot(attacker.id, [attacker.id]).lootPiles[0].items[0])).toBe(Object.prototype);
    expect(db.prepare("SELECT COUNT(*) AS count FROM item_instances WHERE owner_player_id=? AND bound=1").get(defender.id)).toEqual({ count: boundCount });
    expect(() => service.move(defender.id, "home-hall")).toThrow("请先返回玄关复起");

    service.takeLoot(attacker.id, piles[0].id);
    expect(service.getPlayer(attacker.id).cashWen).toBe(attacker.cashWen + 20_000);
    expect(service.getLootPiles("loumen-road")).toHaveLength(0);
    expect(db.prepare("SELECT owner_player_id,equipped_slot FROM item_instances WHERE id='combat-boots'").get())
      .toEqual({ owner_player_id: attacker.id, equipped_slot: null });

    const respawned = service.respawnPlayer(defender.id).player;
    expect(respawned).toMatchObject({ currentLocation: "home-entrance", defeated: false, cashWen: 0 });
    expect(respawned.hp).toBe(Math.ceil(respawned.maxHp / 2));
    expect(respawned.injuryUntil).not.toBeNull();
  });

  it("upgrades the former public-map hierarchy into one continuous overworld with single-floor interiors", () => {
    db.prepare(`INSERT INTO map_layers(id,name,description,parent_layer_id,version,is_active,seed_revision,created_at,updated_at)
      VALUES ('song-legacy-layer','旧大宋层','旧层级。','world-root',1,1,2,?,?)`).run(clock.toISOString(), clock.toISOString());
    db.prepare(`INSERT INTO locations(
      id,layer_id,name,region,description,x,y,region_id,grid_x,grid_y,chunk_x,chunk_y,version,is_active,seed_revision
    ) VALUES ('song-legacy-prefecture','song-legacy-layer','旧京畿路治所','旧大宋','旧层级节点。',0,0,'song',0,0,0,0,1,1,2)`).run();
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
    expect(db.prepare("SELECT is_active FROM locations WHERE id='song-legacy-prefecture'").get()).toEqual({ is_active: 0 });
    expect(service.getLocation("song-landmark-bridge-zhou")).toMatchObject({ layerId: "world-root", regionId: "song" });
    expect(service.getLayers()).toHaveLength(15);
    expect(validateWorldMap(db).errors).toEqual([]);
  });

  it("retires legacy Palos state without losing private exploration history", () => {
    const directory = mkdtempSync(join(tmpdir(), "wuxia-palos-retirement-"));
    const databasePath = join(directory, "game.db");
    try {
      const before = openGameDatabase(databasePath);
      const beforeService = new GameService(before, () => new Date(clock), () => roll);
      const player = beforeService.createSession().player;
      const npc = before.prepare("SELECT player_id FROM npc_profiles ORDER BY player_id LIMIT 1").get() as { player_id: string };
      before.prepare(`
        INSERT INTO map_regions(
          id,layer_id,name,description,x,y,width,height,version,is_active,seed_revision,created_at,updated_at
        ) VALUES ('palos','world-root','旧帕洛斯区域','待退役的旧区域。',32000,32000,160,160,1,1,9,?,?)
      `).run(clock.toISOString(), clock.toISOString());
      before.prepare(`
        INSERT INTO locations(
          id,layer_id,name,region,description,x,y,region_id,grid_x,grid_y,chunk_x,chunk_y,
          version,is_active,seed_revision
        ) VALUES ('palos-legacy-camp','world-root','旧帕洛斯营地','旧帕洛斯区域','待退役的旧地点。',
          32000,32000,'palos',200,200,32,32,1,1,9)
      `).run();
      before.prepare("UPDATE players SET current_location='palos-legacy-camp' WHERE id IN (?,?)").run(player.id, npc.player_id);
      before.prepare("UPDATE npc_profiles SET home_location_id='palos-legacy-camp' WHERE player_id=?").run(npc.player_id);
      before.prepare(`
        INSERT OR REPLACE INTO player_visited_locations(player_id,location_id,first_visited_at,last_visited_at)
        VALUES (?,'palos-legacy-camp',?,?)
      `).run(player.id, clock.toISOString(), clock.toISOString());
      const item = before.prepare("SELECT id FROM item_instances WHERE owner_player_id=? ORDER BY id LIMIT 1").get(player.id) as { id: string };
      const action = before.prepare("SELECT id FROM action_templates WHERE is_active=1 ORDER BY id LIMIT 1").get() as { id: string };
      before.prepare(`
        INSERT INTO action_jobs(
          id,player_id,action_template_id,target_location_id,status,queue_position,started_at,completes_at,
          duration_seconds,reserved_json,context_json,created_at,updated_at
        ) VALUES ('palos-legacy-job',?,?, 'palos-legacy-camp','running',0,?,?,60,'{}','{}',?,?)
      `).run(player.id, action.id, clock.toISOString(), new Date(clock.getTime() + 60_000).toISOString(), clock.toISOString(), clock.toISOString());
      before.prepare("INSERT INTO item_reservations(job_id,item_instance_id,quantity) VALUES ('palos-legacy-job',?,1)").run(item.id);
      before.close();

      const upgraded = openGameDatabase(databasePath);
      const upgradedService = new GameService(upgraded, () => new Date(clock), () => roll);
      const assignedHome = upgraded.prepare("SELECT home_location_id FROM npc_assignments WHERE player_id=?")
        .get(npc.player_id) as { home_location_id: string };
      expect(upgradedService.getPlayer(player.id).currentLocation).toBe("loumen-road-east");
      expect(upgradedService.getPlayer(npc.player_id).currentLocation).toBe("loumen-road-east");
      expect(upgraded.prepare("SELECT home_location_id FROM npc_profiles WHERE player_id=?").get(npc.player_id))
        .toEqual(assignedHome);
      expect(upgraded.prepare("SELECT status FROM action_jobs WHERE id='palos-legacy-job'").get()).toEqual({ status: "cancelled" });
      expect(upgraded.prepare("SELECT COUNT(*) AS count FROM item_reservations WHERE job_id='palos-legacy-job'").get()).toEqual({ count: 0 });
      expect(upgraded.prepare("SELECT is_active FROM locations WHERE id='palos-legacy-camp'").get()).toEqual({ is_active: 0 });
      expect(upgraded.prepare("SELECT COUNT(*) AS count FROM player_visited_locations WHERE player_id=? AND location_id='palos-legacy-camp'").get(player.id))
        .toEqual({ count: 1 });
      expect(upgradedService.getVisitedMap(player.id).locations.map((location) => location.id)).not.toContain("palos-legacy-camp");
      upgraded.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("migrates schema-v9 silver state to cash wen exactly once", () => {
    const directory = mkdtempSync(join(tmpdir(), "wuxia-currency-migration-"));
    const databasePath = join(directory, "game.db");
    try {
      const before = openGameDatabase(databasePath);
      const beforeService = new GameService(before, () => new Date(clock), () => roll);
      const first = beforeService.createSession().player;
      const second = beforeService.createSession().player;
      before.prepare("UPDATE players SET silver=7 WHERE id=?").run(first.id);
      before.prepare(`
        INSERT INTO loot_piles(id,location_id,silver,cash_wen,source_player_id,created_at,updated_at)
        VALUES ('legacy-silver-loot','home-entrance',3,0,?,?,?)
      `).run(second.id, clock.toISOString(), clock.toISOString());
      before.prepare(`
        INSERT INTO action_templates(
          id,name,description,category,target_kind,duration_seconds,requirements_json,check_json,costs_json,
          outcomes_json,result_template,adult,visibility,cooldown_seconds,version,is_active,seed_revision,created_at,updated_at
        ) VALUES ('legacy-silver-action','旧银行动','用于迁移测试。','life','self',0,'{}','{}','{"silverDelta":-1}',
          '{"success":{"silverDelta":2},"failure":{}}','{name}完成旧银行动。',0,'private',0,1,1,0,?,?)
      `).run(clock.toISOString(), clock.toISOString());
      beforeService.requestTrade(first.id, second.id);
      const tradeId = beforeService.getSocialState(first.id).trades[0].id;
      before.prepare("UPDATE trade_sessions SET offer_a_json=? WHERE id=?")
        .run(JSON.stringify({ silver: 4, items: [] }), tradeId);
      before.prepare("DELETE FROM currency_ledger WHERE player_id=?").run(first.id);
      before.prepare("DELETE FROM player_wallets WHERE player_id=?").run(first.id);
      before.prepare("DELETE FROM schema_migrations").run();
      before.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES (9,?)").run(clock.toISOString());
      before.close();

      let upgraded = openGameDatabase(databasePath);
      let upgradedService = new GameService(upgraded, () => new Date(clock), () => roll);
      expect(upgradedService.getPlayer(first.id).cashWen).toBe(7_000);
      expect(upgradedService.getLootPiles("home-entrance").find((pile) => pile.id === "legacy-silver-loot")?.cashWen).toBe(3_000);
      expect(JSON.parse((upgraded.prepare("SELECT costs_json FROM action_templates WHERE id='legacy-silver-action'").get() as { costs_json: string }).costs_json))
        .toEqual({ cashWenDelta: -1_000 });
      expect(JSON.parse((upgraded.prepare("SELECT outcomes_json FROM action_templates WHERE id='legacy-silver-action'").get() as { outcomes_json: string }).outcomes_json))
        .toEqual({ success: { cashWenDelta: 2_000 }, failure: {} });
      expect(upgradedService.getSocialState(first.id).trades[0].ownOffer.cashWen).toBe(4_000);
      expect(upgraded.prepare("SELECT COUNT(*) AS count FROM currency_ledger WHERE player_id=?").get(first.id)).toEqual({ count: 1 });
      upgraded.prepare("UPDATE players SET silver=99 WHERE id=?").run(first.id);
      expect(upgradedService.getPlayer(first.id).cashWen).toBe(7_000);
      upgraded.close();

      upgraded = openGameDatabase(databasePath);
      upgradedService = new GameService(upgraded, () => new Date(clock), () => roll);
      expect(upgradedService.getPlayer(first.id).cashWen).toBe(7_000);
      expect(upgraded.prepare("SELECT COUNT(*) AS count FROM currency_ledger WHERE player_id=?").get(first.id)).toEqual({ count: 1 });
      upgraded.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("repairs legacy silver outcomes added to a schema-v13 action catalog", () => {
    const directory = mkdtempSync(join(tmpdir(), "wuxia-action-currency-repair-"));
    const databasePath = join(directory, "game.db");
    try {
      const before = openGameDatabase(databasePath);
      before.prepare(`
        INSERT INTO action_templates(
          id,name,description,category,target_kind,duration_seconds,requirements_json,check_json,costs_json,
          outcomes_json,result_template,adult,visibility,cooldown_seconds,version,is_active,seed_revision,created_at,updated_at
        ) VALUES ('schema-13-silver-action','旧库采买','模拟已升级数据库中遗留的银两字段。','life','self',0,'{}','{}',
          '{"silverDelta":-2}','{"success":{"silverDelta":3},"failure":{}}','{name}完成旧库采买。',
          0,'private',0,1,1,0,?,?)
      `).run(clock.toISOString(), clock.toISOString());
      before.prepare("DELETE FROM schema_migrations").run();
      before.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES (13,?)").run(clock.toISOString());
      before.close();

      let upgraded = openGameDatabase(databasePath);
      let rule = new GameService(upgraded, () => new Date(clock), () => roll)
        .getActionRuleSnapshot().actions.find((action) => action.id === "schema-13-silver-action");
      expect(rule).toMatchObject({ costs: { cashWenDelta: -2_000 }, success: { cashWenDelta: 3_000 } });
      expect(upgraded.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: MAP_SCHEMA_VERSION });
      upgraded.close();

      upgraded = openGameDatabase(databasePath);
      rule = new GameService(upgraded, () => new Date(clock), () => roll)
        .getActionRuleSnapshot().actions.find((action) => action.id === "schema-13-silver-action");
      expect(rule).toMatchObject({ costs: { cashWenDelta: -2_000 }, success: { cashWenDelta: 3_000 } });
      upgraded.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preserves active locations and routes while upgrading older schema metadata", () => {
    const directory = mkdtempSync(join(tmpdir(), "wuxia-v5-migration-"));
    const databasePath = join(directory, "game.db");
    try {
      const versionThree = openGameDatabase(databasePath);
      const expectedLocations = versionThree.prepare("SELECT COUNT(*) AS count FROM locations WHERE is_active=1").get();
      const expectedRoutes = versionThree.prepare("SELECT COUNT(*) AS count FROM routes WHERE is_active=1").get();
      const player = new GameService(versionThree, () => new Date(clock), () => roll).createSession().player;
      versionThree.prepare(`
        INSERT INTO action_jobs(
          id,player_id,action_template_id,target_location_id,status,queue_position,started_at,completes_at,
          duration_seconds,reserved_json,context_json,created_at,updated_at
        ) VALUES ('old-queued-qinggong',?,'action-qinggong','home-main-bedroom','running',0,?,?,35,'{}','{}',?,?)
      `).run(player.id, clock.toISOString(), new Date(clock.getTime() + 35_000).toISOString(), clock.toISOString(), clock.toISOString());
      const legacyEffectUntil = "2099-08-03T12:15:00.000Z";
      versionThree.prepare("UPDATE players SET vision_bonus_until=?,vision_depth_bonus=1 WHERE id=?")
        .run(legacyEffectUntil, player.id);
      versionThree.prepare("DELETE FROM schema_migrations").run();
      versionThree.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES (7,?)").run(clock.toISOString());
      versionThree.close();
      const upgraded = openGameDatabase(databasePath);
      expect(upgraded.prepare("SELECT COUNT(*) AS count FROM locations WHERE is_active=1").get()).toEqual(expectedLocations);
      expect(upgraded.prepare("SELECT COUNT(*) AS count FROM routes WHERE is_active=1").get()).toEqual(expectedRoutes);
      expect(upgraded.prepare("SELECT route_type FROM routes WHERE id='route-home-door-v4'").get()).toEqual({ route_type: "transition" });
      expect(upgraded.prepare("SELECT status,result_text FROM action_jobs WHERE id='old-queued-qinggong'").get()).toEqual({
        status: "cancelled", result_text: "轻功已改为地图即时技能，旧排队行动已取消。",
      });
      expect(upgraded.prepare("SELECT skill_id,expires_at FROM player_active_skills WHERE player_id=?").get(player.id)).toEqual({
        skill_id: "eagle-eye", expires_at: legacyEffectUntil,
      });
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

  it("binds external OIDC subjects to one player and persists editor roles", () => {
    const first = service.createExternalSession("oidc", "subject-42", "editor");
    expect(service.canEditWorld(first.player.id)).toBe(true);
    const second = service.createExternalSession("oidc", "subject-42", "player");
    expect(second.player.id).toBe(first.player.id);
    expect(db.prepare("SELECT COUNT(*) AS count FROM players WHERE id=?").get(first.player.id)).toEqual({ count: 1 });
    expect(db.prepare("SELECT editor_role FROM external_identities WHERE provider='oidc' AND subject='subject-42'").get())
      .toEqual({ editor_role: "player" });
    expect(service.canEditWorld(first.player.id)).toBe(process.env.NODE_ENV !== "production");
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

  it("fast travels only to personally visited hubs while idle", () => {
    const player = service.createSession().player;
    expect(service.getVisitedMap(player.id).fastTravelDestinationIds).toEqual(["home-entrance"]);
    expect(() => service.fastTravel(player.id, "song-gate")).toThrow("只能快速前往亲自到达过的地点");

    service.move(player.id, "home-exterior");
    service.move(player.id, "loumen-road");
    service.move(player.id, "loumen-road-west");
    service.move(player.id, "song-gate");
    expect(service.getVisitedMap(player.id).fastTravelDestinationIds).toEqual(["home-entrance", "song-gate"]);

    const returned = service.fastTravel(player.id, "home-entrance");
    expect(returned).toMatchObject({
      self: { currentLocation: "home-entrance" },
      event: { eventType: "fast-travel" },
      message: "快速旅行完成：已抵达玄关",
    });
    expect(db.prepare("SELECT kind,from_location,to_location FROM action_logs WHERE player_id=? AND kind='fast-travel'").get(player.id))
      .toEqual({ kind: "fast-travel", from_location: "song-gate", to_location: "home-entrance" });

    service.move(player.id, "home-hall");
    service.fastTravel(player.id, "home-entrance");
    expect(() => service.fastTravel(player.id, "home-hall")).toThrow("不是已解锁的快速旅行枢纽");
    service.startAction(player.id, "action-observe");
    expect(() => service.fastTravel(player.id, "song-gate")).toThrow("当前行动尚未完成");
  });

  it("keeps the global online count while scoping position payloads to three steps", () => {
    const viewer = service.createSession().player;
    const nearby = service.createSession().player;
    const distant = service.createSession().player;
    db.prepare("UPDATE players SET current_location='home-hall' WHERE id=?").run(nearby.id);
    db.prepare("UPDATE players SET current_location='song-landmark-gate-nanxun' WHERE id=?").run(distant.id);

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
    expect(() => service.move(player.id, "world-construction-site")).not.toThrow();
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
    expect(service.searchMapLocations("world-root", "惠民药铺", 10)).toEqual(expect.arrayContaining([
      expect.objectContaining({ layerId: "world-root", name: "东京城·惠民药铺" }),
    ]));
    expect(service.searchMapLocations("world-root", "建设中", 10)).toMatchObject([
      { id: "world-construction-site", layerId: "world-root" },
    ]);

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
    expect(service.getWorldStatus(2, clock)).toMatchObject({
      timeZone: "Asia/Shanghai",
      onlineCount: 2,
      announcement: expect.stringContaining("北宋东京开封府"),
    });
  });
});
