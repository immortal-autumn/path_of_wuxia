import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openGameDatabase, type GameDatabase } from "../lib/game/database";
import { directionBetween } from "../lib/game/map";
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

  it("seeds a source-tracked 500+ location world and preserves all ordinary direction slots", () => {
    expect(service.getLayers().map((layer) => layer.id)).toEqual(expect.arrayContaining([
      "world-root", "home-ground", "home-basement", "song-overview", "palos-overview", "palos-dungeons",
    ]));
    expect(service.getLocation("home-entrance")).toMatchObject({ layerId: "home-ground", name: "玄关" });
    expect(service.getLocation("loumen-road")).toMatchObject({ layerId: "world-root", name: "楼门路" });
    expect(service.getLocation("home-training-room")).toMatchObject({ layerId: "home-basement" });
    const validation = validateWorldMap(db);
    expect(validation.errors).toEqual([]);
    expect(validation.counts).toMatchObject({ songLocations: expect.any(Number), palosLocations: 279 });
    expect(validation.counts.songLocations).toBeGreaterThanOrEqual(250);
    expect(validation.counts.locations).toBeGreaterThanOrEqual(500);
    expect(validation.counts.reachableLocations).toBe(validation.counts.locations);
    expect((db.prepare("SELECT COUNT(*) AS count FROM location_direction_slots").get() as { count: number }).count).toBeGreaterThan(500);
    expect(service.getTransitions("home-entrance")[0]).toMatchObject({ destinationName: "楼门路", transitionKind: "door" });
  });

  it("reapplies the bundled world seed idempotently", () => {
    const before = db.prepare("SELECT COUNT(*) AS locations FROM locations").get();
    const first = importWorldSeed(db);
    const second = importWorldSeed(db);
    expect(first).toEqual(second);
    expect(db.prepare("SELECT COUNT(*) AS locations FROM locations").get()).toEqual(before);
    expect(validateWorldMap(db).ok).toBe(true);
  });

  it("preserves active locations and routes while upgrading a version-3 database", () => {
    const directory = mkdtempSync(join(tmpdir(), "wuxia-v4-migration-"));
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
      expect(upgraded.prepare("SELECT route_type FROM routes WHERE id='route-entrance-road'").get()).toEqual({ route_type: "transition" });
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
    const moved = service.move(player.id, "loumen-road");
    expect(moved.self).toMatchObject({ currentLocation: "loumen-road", endurance });
    const acted = service.act(player.id, "observe-road");
    expect(acted.self.endurance).toBe(endurance);
    expect(acted.self.cultivation.progress).toBe(0);
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
    const session = service.acquireMapLocks(player.id, ["layer:world-root:chunk:0:0", "layer:song-overview:chunk:0:0"]);
    service.applyMapOperation(player.id, session.id, {
      type: "location.create",
      location: { id: "test-neighbor", layerId: "world-root", name: "测试邻居", description: "相邻格。", regionId: null, gridX: 3, gridY: 3 },
    });
    service.applyMapOperation(player.id, session.id, {
      type: "route.create", fromLocation: "loumen-road", toLocation: "test-neighbor", routeType: "normal",
    });
    expect(() => service.applyMapOperation(player.id, session.id, {
      type: "route.create", fromLocation: "song-overview-entry", toLocation: "test-neighbor", routeType: "normal",
    })).toThrow("同一地图层");
    service.applyMapOperation(player.id, session.id, {
      type: "route.create", fromLocation: "song-overview-entry", toLocation: "test-neighbor", routeType: "transition", transitionKind: "gate",
    });
    expect(service.getRoutes().some((route) => route.transitionKind === "gate" && route.fromLocation === "song-overview-entry")).toBe(true);
  });

  it("expires edit leases and supports undo and redo", () => {
    const first = service.createSession().player;
    const second = service.createSession().player;
    const session = service.acquireMapLocks(first.id, ["layer:world-root:chunk:0:0"]);
    expect(() => service.acquireMapLocks(second.id, ["layer:world-root:chunk:0:0"])).toThrow("正由其他玩家编辑");
    service.applyMapOperation(first.id, session.id, {
      type: "location.create",
      location: { id: "undo-place", layerId: "world-root", name: "可撤销地点", description: "撤销测试。", regionId: null, gridX: 5, gridY: 3 },
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
      const gridX = 10 + (index % 40);
      const gridY = 10 + Math.floor(index / 40);
      insert.run(`bulk-${index}`, "world-root", `批量地点${index}`, "公共区域", "压力测试。", gridX * 160, gridY * 160, null, gridX, gridY, Math.floor((gridX * 160) / 1000), Math.floor((gridY * 160) / 1000));
    }
    const viewport = service.getMapViewport("world-root", 4, 4, 3, 1);
    expect(viewport.locations.length).toBeLessThanOrEqual(1_200);
    expect(viewport.loadedChunkCount).toBeLessThanOrEqual(49);
  });

  it("normalizes chat and exposes deterministic China-standard time", () => {
    const player = service.createSession().player;
    expect(service.sendChat(player.id, "  诸位\n朋友，幸会。  ").content).toBe("诸位 朋友，幸会。");
    expect(() => service.sendChat(player.id, "江".repeat(121))).toThrow("最多120个字");
    expect(service.getWorldStatus(2, clock)).toMatchObject({ timeZone: "Asia/Shanghai", onlineCount: 2 });
  });
});
