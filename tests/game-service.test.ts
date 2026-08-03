import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openGameDatabase, type GameDatabase } from "../lib/game/database";
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
    expect(service.getLocation("palos-fasttravel-1001")).toMatchObject({ layerId: "world-root", regionId: "palos" });
    expect(service.getLocation("home-training-room")).toMatchObject({ layerId: "home-ground" });
    expect(service.searchMapLocations("world-root", "楼门路", 10)).toHaveLength(3);
    expect(db.prepare("SELECT COUNT(*) AS count FROM locations WHERE name='楼门路' AND is_active=1").get()).toEqual({ count: 3 });
    const validation = validateWorldMap(db);
    expect(validation.errors).toEqual([]);
    expect(validation.counts).toMatchObject({ songLocations: expect.any(Number), palosLocations: 279 });
    expect(validation.counts.songLocations).toBeGreaterThanOrEqual(250);
    expect(validation.counts.locations).toBeGreaterThanOrEqual(500);
    expect(validation.counts.reachableLocations).toBe(validation.counts.locations);
    expect(validation.counts.overworldLocations).toBeGreaterThanOrEqual(890);
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
      expect(upgraded.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 6 });
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
    expect(result.player.derived.maxAttack).toBe(55);
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
