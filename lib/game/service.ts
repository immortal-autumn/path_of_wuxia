import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import type { GameDatabase } from "./database";
import { getGameDatabase, inTransaction } from "./database";
import { chunkForGrid, chunkKey, directionBetween, gridToWorldPosition, OPPOSITE_DIRECTION } from "./map";
import {
  ATTRIBUTE_KEYS,
  breakthroughChance,
  cultivationForNextLevel,
  deriveStats,
  majorAttributePoints,
  minorAttributePoints,
  REALMS,
  type AttributeKey,
} from "./progression";
import { createWorldStatus } from "./time";
import type {
  ActionDefinition,
  BaseAttributes,
  ChatMessage,
  Direction,
  GameMutation,
  GameSnapshot,
  Location,
  MapEditOperation,
  MapEditSessionState,
  MapHistoryState,
  MapLayer,
  MapLock,
  MapRegion,
  MapRoute,
  MapTransition,
  MapViewport,
  OnlinePlayer,
  PlayerSelf,
  RouteType,
  SessionIdentity,
  TransitionKind,
  VisitedMap,
  WorldEvent,
  WorldStatus,
} from "./types";

const SESSION_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;
const EDIT_LEASE_MS = 2 * 60 * 1000;
const MAX_HISTORY = 50;
const MAX_VIEWPORT_LOCATIONS = 1200;
const MINUTE_MS = 60_000;
export const SESSION_COOKIE = "wuxia_session";
export const SESSION_MAX_AGE = Math.floor(SESSION_LIFETIME_MS / 1000);

const FAMILY_NAMES = ["沈", "顾", "谢", "陆", "裴", "苏", "叶", "楚", "宁", "洛", "白", "秦", "江", "柳", "温", "萧"];
const GIVEN_NAMES = ["听澜", "照夜", "临风", "知微", "怀瑾", "清和", "无尘", "青崖", "长歌", "星河", "问舟", "霁月", "凌霜", "砚秋", "云归", "观棋", "景行", "含章", "疏影", "逐风"];

type PlayerRow = {
  id: string; name: string; title: string; hp: number; silver: number; current_location: string;
  strength: number; agility: number; constitution: number; root: number; comprehension: number; spirit: number;
  unspent_points: number; realm_index: number; realm_level: number; cultivation_progress: number;
  endurance: number; training_anchor_at: string | null; training_multiplier: number;
};
type LocationRow = {
  id: string; layer_id: string; name: string; region: string; region_id: string | null; region_name: string | null;
  description: string; x: number; y: number; grid_x: number; grid_y: number; chunk_x: number; chunk_y: number;
  version: number; training_multiplier: number;
};
type RegionRow = { id: string; layer_id: string; name: string; description: string; x: number; y: number; width: number; height: number; version: number };
type LayerRow = { id: string; name: string; description: string; parent_layer_id: string | null; version: number };
type RouteRow = {
  id: string; from_location: string; to_location: string; route_type: RouteType; transition_kind: TransitionKind | null;
  from_direction: Direction | null; to_direction: Direction | null; version: number;
};
type EventRow = { id: number; player_id: string | null; event_type: string; content: string; created_at: string };

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function placeholders(values: readonly unknown[]) {
  return values.map(() => "?").join(",");
}

function mapLayer(row: LayerRow): MapLayer {
  return { id: row.id, name: row.name, description: row.description, parentLayerId: row.parent_layer_id, version: row.version };
}

function mapLocation(row: LocationRow): Location {
  return {
    id: row.id, layerId: row.layer_id, name: row.name, region: row.region_name ?? row.region ?? "公共区域",
    regionId: row.region_id, description: row.description, x: row.x, y: row.y, gridX: row.grid_x, gridY: row.grid_y,
    chunkX: row.chunk_x, chunkY: row.chunk_y, version: row.version, trainingMultiplier: row.training_multiplier ?? 0,
  };
}

function mapRegion(row: RegionRow): MapRegion {
  return {
    id: row.id, layerId: row.layer_id, name: row.name, description: row.description,
    x: row.x, y: row.y, width: row.width, height: row.height, version: row.version,
  };
}

function mapRoute(row: RouteRow): MapRoute {
  return {
    id: row.id, fromLocation: row.from_location, toLocation: row.to_location, routeType: row.route_type,
    transitionKind: row.transition_kind, fromDirection: row.from_direction, toDirection: row.to_direction, version: row.version,
  };
}

function mapEvent(row: EventRow): WorldEvent {
  return { id: row.id, playerId: row.player_id, eventType: row.event_type, content: row.content, createdAt: row.created_at };
}

function cleanText(value: string, label: string, maxLength: number) {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) throw new Error(`${label}不能为空。`);
  if (Array.from(cleaned).length > maxLength) throw new Error(`${label}最多${maxLength}个字。`);
  return cleaned;
}

function effectSummary(action: ActionDefinition) {
  return ([ ["银两", action.silverDelta], ["气血", action.hpDelta] ] as const)
    .filter(([, value]) => value !== 0)
    .map(([label, value]) => `${label}${value > 0 ? "+" : ""}${value}`)
    .join(" · ");
}

function transitionLabel(kind: TransitionKind, destination: string) {
  const prefix: Record<TransitionKind, string> = {
    door: "通过门前往", stairs: "通过楼梯前往", elevator: "乘电梯前往", gate: "进入", road: "沿道路前往",
    ferry: "乘渡船前往", dungeon: "进入地下城", "fast-travel": "快速传送至", portal: "传送至",
  };
  return `${prefix[kind]}${destination}`;
}

export class GameService {
  constructor(
    private readonly db: GameDatabase = getGameDatabase(),
    private readonly now: () => Date = () => new Date(),
    private readonly randomPercent: () => number = () => randomInt(100),
  ) {}

  private playerSelect() {
    return `
      SELECT p.id,p.name,p.title,p.hp,p.silver,p.current_location,
             pr.strength,pr.agility,pr.constitution,pr.root,pr.comprehension,pr.spirit,
             pr.unspent_points,pr.realm_index,pr.realm_level,pr.cultivation_progress,
             pr.endurance,pr.training_anchor_at,COALESCE(le.multiplier,0) AS training_multiplier
      FROM players p JOIN player_progression pr ON pr.player_id=p.id
      LEFT JOIN location_effects le ON le.location_id=p.current_location AND le.effect_type='cultivation'
    `;
  }

  private getPlayerRow(playerId: string) {
    const row = this.db.prepare(`${this.playerSelect()} WHERE p.id=?`).get(playerId) as PlayerRow | undefined;
    if (!row) throw new Error("未找到这个角色。");
    return row;
  }

  private mapPlayer(row: PlayerRow): PlayerSelf {
    const attributes: BaseAttributes = {
      strength: row.strength, agility: row.agility, constitution: row.constitution,
      root: row.root, comprehension: row.comprehension, spirit: row.spirit,
    };
    const derived = deriveStats(attributes, row.realm_index);
    const levelCost = cultivationForNextLevel(row.realm_index, row.realm_level);
    const breakthroughCost = Math.ceil(levelCost * 0.3);
    const chance = breakthroughChance(row.realm_level);
    return {
      id: row.id, name: row.name, title: row.title, hp: Math.min(row.hp, derived.maxHp), maxHp: derived.maxHp,
      endurance: Math.min(row.endurance, derived.maxEndurance), maxEndurance: derived.maxEndurance,
      silver: row.silver, currentLocation: row.current_location, attributes, derived,
      cultivation: {
        realmIndex: row.realm_index, realmName: REALMS[row.realm_index] ?? REALMS[0], level: row.realm_level,
        progress: row.cultivation_progress, nextLevelCost: levelCost, unspentAttributePoints: row.unspent_points,
        training: row.training_multiplier > 0 && row.training_anchor_at !== null,
        trainingMultiplier: row.training_multiplier, cultivationPerMinute: Math.floor(derived.cultivationPerMinute * Math.max(1, row.training_multiplier || 1)),
        canBreakthrough: row.realm_index < REALMS.length - 1 && row.realm_level >= 9 && row.cultivation_progress >= breakthroughCost,
        breakthroughChance: chance, breakthroughCost,
        nextMinorAttributePoints: minorAttributePoints(row.realm_index),
        nextRealmAttributePoints: row.realm_index < REALMS.length - 1 ? majorAttributePoints(row.realm_index + 1) : 0,
      },
    };
  }

  private advanceCultivation(row: Pick<PlayerRow, "realm_index" | "realm_level" | "cultivation_progress" | "unspent_points">, gain: number) {
    let progress = row.cultivation_progress + Math.max(0, Math.floor(gain));
    let level = row.realm_level;
    let unspentPoints = row.unspent_points;
    while (level < 12) {
      const cost = cultivationForNextLevel(row.realm_index, level);
      if (progress < cost) break;
      progress -= cost;
      level += 1;
      unspentPoints += minorAttributePoints(row.realm_index);
    }
    return { progress, level, unspentPoints };
  }

  private settleCultivationInternal(playerId: string, at: Date, offline: boolean) {
    const row = this.getPlayerRow(playerId);
    if (row.training_multiplier <= 0) {
      if (row.training_anchor_at) this.db.prepare("UPDATE player_progression SET training_anchor_at=NULL,updated_at=? WHERE player_id=?").run(at.toISOString(), playerId);
      return { delta: 0, offline, player: this.mapPlayer({ ...row, training_anchor_at: null }) };
    }
    if (!row.training_anchor_at) {
      this.db.prepare("UPDATE player_progression SET training_anchor_at=?,updated_at=? WHERE player_id=?").run(at.toISOString(), at.toISOString(), playerId);
      return { delta: 0, offline, player: this.mapPlayer({ ...row, training_anchor_at: at.toISOString() }) };
    }
    const anchor = new Date(row.training_anchor_at);
    const minutes = Math.floor((at.getTime() - anchor.getTime()) / MINUTE_MS);
    if (minutes <= 0) return { delta: 0, offline, player: this.mapPlayer(row) };
    const rate = deriveStats({
      strength: row.strength, agility: row.agility, constitution: row.constitution,
      root: row.root, comprehension: row.comprehension, spirit: row.spirit,
    }, row.realm_index).cultivationPerMinute;
    const delta = Math.floor(minutes * rate * row.training_multiplier);
    const advanced = this.advanceCultivation(row, delta);
    const nextAnchor = new Date(anchor.getTime() + minutes * MINUTE_MS).toISOString();
    this.db.prepare(`
      UPDATE player_progression SET realm_level=?,cultivation_progress=?,unspent_points=?,training_anchor_at=?,updated_at=? WHERE player_id=?
    `).run(advanced.level, advanced.progress, advanced.unspentPoints, nextAnchor, at.toISOString(), playerId);
    this.db.prepare(`
      INSERT INTO cultivation_logs(player_id,kind,delta,realm_index,realm_level,detail,created_at) VALUES (?,?,?,?,?,?,?)
    `).run(playerId, offline ? "offline" : "online", delta, row.realm_index, advanced.level, `${minutes}个服务器分钟`, at.toISOString());
    return { delta, offline, player: this.mapPlayer(this.getPlayerRow(playerId)) };
  }

  settleCultivation(playerId: string, offline = false) {
    return inTransaction(this.db, () => this.settleCultivationInternal(playerId, this.now(), offline));
  }

  createSession(): SessionIdentity {
    return inTransaction(this.db, () => {
      const playerId = randomUUID();
      const at = this.now();
      const createdAt = at.toISOString();
      const token = randomBytes(32).toString("base64url");
      let name = "";
      for (let attempt = 0; attempt < 64; attempt += 1) {
        const baseName = `${FAMILY_NAMES[randomInt(FAMILY_NAMES.length)]}${GIVEN_NAMES[randomInt(GIVEN_NAMES.length)]}`;
        const candidate = attempt < 24 ? baseName : `${baseName}${randomInt(100, 1000)}`;
        if (!this.db.prepare("SELECT 1 FROM players WHERE name=?").get(candidate)) { name = candidate; break; }
      }
      if (!name) name = `无名客${playerId.replaceAll("-", "").slice(0, 12)}`;
      const initial = deriveStats({ strength: 10, agility: 10, constitution: 10, root: 10, comprehension: 10, spirit: 10 }, 0);
      this.db.prepare(`
        INSERT INTO players(id,name,title,hp,max_hp,stamina,max_stamina,cultivation,silver,current_location,created_at,updated_at,last_seen_at)
        VALUES (?,?,'初入世界',?,?,?, ?,0,20,'home-entrance',?,?,?)
      `).run(playerId, name, initial.maxHp, initial.maxHp, initial.maxEndurance, initial.maxEndurance, createdAt, createdAt, createdAt);
      this.db.prepare("INSERT INTO player_progression(player_id,endurance,updated_at) VALUES (?,?,?)").run(playerId, initial.maxEndurance, createdAt);
      this.db.prepare("INSERT INTO player_visited_locations(player_id,location_id,first_visited_at,last_visited_at) VALUES (?,'home-entrance',?,?)")
        .run(playerId, createdAt, createdAt);
      this.db.prepare("INSERT INTO sessions(token_hash,player_id,created_at,expires_at) VALUES (?,?,?,?)")
        .run(tokenHash(token), playerId, createdAt, new Date(at.getTime() + SESSION_LIFETIME_MS).toISOString());
      this.db.prepare("INSERT INTO world_events(player_id,event_type,content,created_at) VALUES (?,'arrival',?,?)")
        .run(playerId, `${name}从玄关踏入这个世界。`, createdAt);
      return { token, player: this.getPlayer(playerId) };
    });
  }

  getPlayerBySessionToken(token: string | undefined) {
    if (!token) return null;
    const row = this.db.prepare(`
      SELECT p.id FROM sessions s JOIN players p ON p.id=s.player_id WHERE s.token_hash=? AND s.expires_at>?
    `).get(tokenHash(token), this.now().toISOString()) as { id: string } | undefined;
    if (!row) return null;
    return this.settleCultivation(row.id, true).player;
  }

  getPlayer(playerId: string) {
    return this.mapPlayer(this.getPlayerRow(playerId));
  }

  allocateAttributes(playerId: string, allocations: BaseAttributes) {
    return inTransaction(this.db, () => {
      this.settleCultivationInternal(playerId, this.now(), false);
      const row = this.getPlayerRow(playerId);
      const total = ATTRIBUTE_KEYS.reduce((sum, key) => sum + allocations[key], 0);
      if (total <= 0) throw new Error("至少分配1点属性。");
      if (total > row.unspent_points) throw new Error("可分配属性点不足。");
      const next = Object.fromEntries(ATTRIBUTE_KEYS.map((key) => [key, row[key] + allocations[key]])) as Record<AttributeKey, number>;
      this.db.prepare(`
        UPDATE player_progression SET strength=?,agility=?,constitution=?,root=?,comprehension=?,spirit=?,
          unspent_points=unspent_points-?,updated_at=? WHERE player_id=?
      `).run(next.strength, next.agility, next.constitution, next.root, next.comprehension, next.spirit, total, this.now().toISOString(), playerId);
      const player = this.getPlayer(playerId);
      this.db.prepare("UPDATE player_progression SET endurance=? WHERE player_id=?").run(player.maxEndurance, playerId);
      return { player: this.getPlayer(playerId), message: `已分配${total}点属性。` };
    });
  }

  breakthrough(playerId: string): GameMutation {
    return inTransaction(this.db, () => {
      this.settleCultivationInternal(playerId, this.now(), false);
      const row = this.getPlayerRow(playerId);
      if (row.realm_index >= REALMS.length - 1) throw new Error("已经抵达大乘境界，无法继续突破。");
      if (row.realm_level < 9) throw new Error("达到当前境界第9级后才能尝试突破。");
      const cost = Math.ceil(cultivationForNextLevel(row.realm_index, row.realm_level) * 0.3);
      if (row.cultivation_progress < cost) throw new Error(`突破至少需要${cost}点当前修为。`);
      const chance = breakthroughChance(row.realm_level);
      const at = this.now().toISOString();
      const success = this.randomPercent() < chance;
      let content: string;
      if (!success) {
        this.db.prepare("UPDATE player_progression SET cultivation_progress=cultivation_progress-?,updated_at=? WHERE player_id=?").run(cost, at, playerId);
        content = `${row.name}尝试突破${REALMS[row.realm_index]}境界失败，修为-${cost}。`;
        this.db.prepare("INSERT INTO cultivation_logs(player_id,kind,delta,realm_index,realm_level,detail,created_at) VALUES (?,'breakthrough-failed',?,?,?,?,?)")
          .run(playerId, -cost, row.realm_index, row.realm_level, `${chance}%`, at);
      } else {
        const nextRealm = row.realm_index + 1;
        const carried = Math.floor(row.cultivation_progress * 0.3);
        const reward = majorAttributePoints(nextRealm);
        const advanced = this.advanceCultivation({ realm_index: nextRealm, realm_level: 1, cultivation_progress: 0, unspent_points: row.unspent_points + reward }, carried);
        this.db.prepare(`
          UPDATE player_progression SET realm_index=?,realm_level=?,cultivation_progress=?,unspent_points=?,updated_at=? WHERE player_id=?
        `).run(nextRealm, advanced.level, advanced.progress, advanced.unspentPoints, at, playerId);
        content = `${row.name}突破至${REALMS[nextRealm]}境界，获得${reward}点可分配属性。`;
        this.db.prepare("INSERT INTO cultivation_logs(player_id,kind,delta,realm_index,realm_level,detail,created_at) VALUES (?,'breakthrough-success',?,?,?,?,?)")
          .run(playerId, carried, nextRealm, advanced.level, `继承30%修为并获得${reward}点`, at);
      }
      const result = this.db.prepare("INSERT INTO world_events(player_id,event_type,content,created_at) VALUES (?,'breakthrough',?,?)").run(playerId, content, at);
      const event = this.db.prepare("SELECT id,player_id,event_type,content,created_at FROM world_events WHERE id=?").get(result.lastInsertRowid) as EventRow;
      return { self: this.getPlayer(playerId), event: mapEvent(event), message: content };
    });
  }

  private locationSelect() {
    return `
      SELECT l.id,l.layer_id,l.name,l.region,l.region_id,r.name AS region_name,l.description,
             l.x,l.y,l.grid_x,l.grid_y,l.chunk_x,l.chunk_y,l.version,
             COALESCE(le.multiplier,0) AS training_multiplier
      FROM locations l LEFT JOIN map_regions r ON r.id=l.region_id
      LEFT JOIN location_effects le ON le.location_id=l.id AND le.effect_type='cultivation'
    `;
  }

  getLocation(locationId: string) {
    const row = this.db.prepare(`${this.locationSelect()} WHERE l.id=? AND l.is_active=1`).get(locationId) as LocationRow | undefined;
    if (!row) throw new Error("地点不存在或已停用。");
    return mapLocation(row);
  }

  getLocations(locationIds?: string[], layerId?: string) {
    let sql = `${this.locationSelect()} WHERE l.is_active=1`;
    const params: string[] = [];
    if (locationIds) {
      if (locationIds.length === 0) return [];
      sql += ` AND l.id IN (${placeholders(locationIds)})`;
      params.push(...locationIds);
    }
    if (layerId) { sql += " AND l.layer_id=?"; params.push(layerId); }
    sql += " ORDER BY l.id";
    return (this.db.prepare(sql).all(...params) as LocationRow[]).map(mapLocation);
  }

  searchMapLocations(layerId: string, query = "", limit = 100) {
    this.getLayer(layerId);
    const cleanedQuery = query.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
    const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
    const rows = this.db.prepare(`
      ${this.locationSelect()} WHERE l.is_active=1 AND l.layer_id=? AND l.name LIKE ?
      ORDER BY l.name,l.id LIMIT ?
    `).all(layerId, `%${cleanedQuery}%`, safeLimit) as LocationRow[];
    return rows.map(mapLocation);
  }

  getLayer(layerId: string) {
    const row = this.db.prepare("SELECT id,name,description,parent_layer_id,version FROM map_layers WHERE id=? AND is_active=1").get(layerId) as LayerRow | undefined;
    if (!row) throw new Error("地图层不存在或已停用。");
    return mapLayer(row);
  }

  getLayers() {
    return (this.db.prepare("SELECT id,name,description,parent_layer_id,version FROM map_layers WHERE is_active=1 ORDER BY name").all() as LayerRow[]).map(mapLayer);
  }

  getRegions(regionIds?: string[], layerId?: string) {
    let sql = "SELECT id,layer_id,name,description,x,y,width,height,version FROM map_regions WHERE is_active=1";
    const params: string[] = [];
    if (regionIds) {
      if (regionIds.length === 0) return [];
      sql += ` AND id IN (${placeholders(regionIds)})`;
      params.push(...regionIds);
    }
    if (layerId) { sql += " AND layer_id=?"; params.push(layerId); }
    sql += " ORDER BY id";
    return (this.db.prepare(sql).all(...params) as RegionRow[]).map(mapRegion);
  }

  getRoutes(locationIds?: string[]) {
    let sql = "SELECT id,from_location,to_location,route_type,transition_kind,from_direction,to_direction,version FROM routes WHERE is_active=1";
    const params: string[] = [];
    if (locationIds) {
      if (locationIds.length === 0) return [];
      const slots = placeholders(locationIds);
      sql += ` AND from_location IN (${slots}) AND to_location IN (${slots})`;
      params.push(...locationIds, ...locationIds);
    }
    sql += " ORDER BY id";
    return (this.db.prepare(sql).all(...params) as RouteRow[]).map(mapRoute);
  }

  getVisitedMap(playerId: string): VisitedMap {
    this.getPlayer(playerId);
    const locations = (this.db.prepare(`
      ${this.locationSelect()}
      WHERE l.is_active=1 AND EXISTS (
        SELECT 1 FROM player_visited_locations visited
        WHERE visited.player_id=? AND visited.location_id=l.id
      )
      ORDER BY l.layer_id,l.grid_y,l.grid_x,l.id
    `).all(playerId) as LocationRow[]).map(mapLocation);
    const visitedLayerIds = new Set(locations.map((location) => location.layerId));
    const routes = (this.db.prepare(`
      SELECT route.id,route.from_location,route.to_location,route.route_type,route.transition_kind,
             route.from_direction,route.to_direction,route.version
      FROM routes route
      WHERE route.is_active=1
        AND EXISTS (
          SELECT 1 FROM player_visited_locations visited_from
          WHERE visited_from.player_id=? AND visited_from.location_id=route.from_location
        )
        AND EXISTS (
          SELECT 1 FROM player_visited_locations visited_to
          WHERE visited_to.player_id=? AND visited_to.location_id=route.to_location
        )
      ORDER BY route.id
    `).all(playerId, playerId) as RouteRow[]).map(mapRoute);
    return {
      layers: this.getLayers().filter((layer) => visitedLayerIds.has(layer.id)),
      locations,
      routes,
    };
  }

  getActions(locationIds?: string[]) {
    let sql = `
      SELECT a.id,a.location_id,a.name,a.description,a.silver_delta,a.hp_delta
      FROM action_definitions a JOIN locations l ON l.id=a.location_id WHERE l.is_active=1
    `;
    const params: string[] = [];
    if (locationIds) {
      if (locationIds.length === 0) return [];
      sql += ` AND a.location_id IN (${placeholders(locationIds)})`;
      params.push(...locationIds);
    }
    return (this.db.prepare(`${sql} ORDER BY a.id`).all(...params) as Array<{
      id: string; location_id: string; name: string; description: string; silver_delta: number; hp_delta: number;
    }>).map((row) => ({
      id: row.id, locationId: row.location_id, name: row.name, description: row.description,
      silverDelta: row.silver_delta, hpDelta: row.hp_delta,
    }));
  }

  getNeighborhood(startLocationId: string, maxDepth = 3) {
    const start = this.getLocation(startLocationId);
    const visited = new Set<string>([start.id]);
    let frontier = [start.id];
    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
      const rows = this.db.prepare(`SELECT target_location FROM location_direction_slots WHERE location_id IN (${placeholders(frontier)})`).all(...frontier) as Array<{ target_location: string }>;
      const next = [...new Set(rows.map((row) => row.target_location).filter((id) => !visited.has(id)))];
      for (const id of next) visited.add(id);
      frontier = next;
    }
    const locations = this.getLocations([...visited], start.layerId);
    const regionIds = [...new Set(locations.flatMap((location) => location.regionId ? [location.regionId] : []))];
    const routes = this.getRoutes(locations.map((location) => location.id)).filter((route) => route.routeType === "normal");
    return { locations, routes, regions: this.getRegions(regionIds, start.layerId) };
  }

  getTransitions(locationId: string): MapTransition[] {
    const rows = this.db.prepare(`
      SELECT r.id,r.from_location,r.to_location,r.route_type,r.transition_kind,
             destination.id AS destination_id,destination.name AS destination_name,destination.layer_id AS destination_layer_id
      FROM routes r JOIN locations destination ON destination.id=CASE WHEN r.from_location=? THEN r.to_location ELSE r.from_location END
      WHERE r.is_active=1 AND r.route_type IN ('transition','portal') AND (r.from_location=? OR r.to_location=?) AND destination.is_active=1
      ORDER BY r.id
    `).all(locationId, locationId, locationId) as Array<{
      id: string; from_location: string; to_location: string; route_type: "transition" | "portal";
      transition_kind: TransitionKind | null; destination_id: string; destination_name: string; destination_layer_id: string;
    }>;
    return rows.map((row) => {
      const kind = row.transition_kind ?? (row.route_type === "portal" ? "portal" : "door");
      return {
        routeId: row.id, destinationId: row.destination_id, destinationName: row.destination_name,
        destinationLayerId: row.destination_layer_id, routeType: row.route_type, transitionKind: kind,
        label: transitionLabel(kind, row.destination_name),
      };
    });
  }

  getOnlinePlayers(playerIds: string[]) {
    const ids = [...new Set(playerIds)];
    if (ids.length === 0) return [];
    const rows = this.db.prepare(`SELECT id,name,title,current_location FROM players WHERE id IN (${placeholders(ids)}) ORDER BY name`).all(...ids) as Array<{
      id: string; name: string; title: string; current_location: string;
    }>;
    return rows.map((row) => ({ id: row.id, name: row.name, title: row.title, currentLocation: row.current_location })) satisfies OnlinePlayer[];
  }

  getWorldStatus(onlineCount: number, now = this.now()): WorldStatus {
    const base = this.db.prepare("SELECT announcement FROM world_state WHERE id=1").get() as { announcement: string };
    return createWorldStatus(base, onlineCount, now);
  }

  getRecentEvents(limit = 12) {
    return (this.db.prepare("SELECT id,player_id,event_type,content,created_at FROM world_events ORDER BY id DESC LIMIT ?").all(limit) as EventRow[]).map(mapEvent);
  }

  getRecentChat(limit = 50) {
    const rows = this.db.prepare(`
      SELECT c.id,c.player_id,p.name AS player_name,c.content,c.created_at
      FROM chat_messages c JOIN players p ON p.id=c.player_id ORDER BY c.id DESC LIMIT ?
    `).all(limit) as Array<{ id: number; player_id: string; player_name: string; content: string; created_at: string }>;
    return rows.reverse().map((row) => ({ id: row.id, playerId: row.player_id, playerName: row.player_name, content: row.content, createdAt: row.created_at })) satisfies ChatMessage[];
  }

  getSnapshot(playerId: string, onlinePlayerIds: string[]): GameSnapshot {
    this.settleCultivation(playerId, false);
    const self = this.getPlayer(playerId);
    const current = this.getLocation(self.currentLocation);
    const neighborhood = this.getNeighborhood(self.currentLocation);
    const allOnlinePlayers = this.getOnlinePlayers(onlinePlayerIds);
    const visibleLocationIds = new Set(neighborhood.locations.map((location) => location.id));
    const onlinePlayers = allOnlinePlayers.filter((player) => visibleLocationIds.has(player.currentLocation));
    return {
      self, world: this.getWorldStatus(allOnlinePlayers.length), currentLayer: this.getLayer(current.layerId),
      regions: neighborhood.regions, locations: neighborhood.locations, routes: neighborhood.routes,
      transitions: this.getTransitions(self.currentLocation), actions: this.getActions([self.currentLocation]),
      onlinePlayers, recentEvents: this.getRecentEvents(), chatMessages: this.getRecentChat(),
    };
  }

  getMapViewport(layerId: string, centerChunkX: number, centerChunkY: number, radius = 1, zoom = 1): MapViewport {
    const safeRadius = Math.max(1, Math.min(3, Math.floor(radius)));
    const [minX, maxX, minY, maxY] = [centerChunkX - safeRadius, centerChunkX + safeRadius, centerChunkY - safeRadius, centerChunkY + safeRadius];
    const chunkCoordinates: number[] = [];
    for (let chunkY = minY; chunkY <= maxY; chunkY += 1) {
      for (let chunkX = minX; chunkX <= maxX; chunkX += 1) chunkCoordinates.push(chunkX, chunkY);
    }
    const chunkValues = Array.from({ length: chunkCoordinates.length / 2 }, () => "(?,?)").join(",");
    const chunks = (this.db.prepare(`
      SELECT chunk_x,chunk_y,COUNT(*) AS location_count FROM locations
      WHERE is_active=1 AND layer_id=? AND (chunk_x,chunk_y) IN (VALUES ${chunkValues})
      GROUP BY chunk_x,chunk_y ORDER BY chunk_y,chunk_x
    `).all(layerId, ...chunkCoordinates) as Array<{ chunk_x: number; chunk_y: number; location_count: number }>).map((row) => ({
      chunkX: row.chunk_x, chunkY: row.chunk_y, locationCount: row.location_count,
    }));
    const regions = (this.db.prepare(`
      SELECT id,layer_id,name,description,x,y,width,height,version FROM map_regions
      WHERE is_active=1 AND layer_id=? AND x<=? AND x+width>=? AND y<=? AND y+height>=? LIMIT 500
    `).all(layerId, (maxX + 1) * 1000, minX * 1000, (maxY + 1) * 1000, minY * 1000) as RegionRow[]).map(mapRegion);
    const common = { layer: this.getLayer(layerId), layers: this.getLayers(), regions, chunks, loadedChunkCount: chunks.length };
    if (zoom < 0.6) return { ...common, locations: [], remoteLocations: [], routes: [], truncated: false };
    const rows = this.db.prepare(`
      ${this.locationSelect()} WHERE l.is_active=1 AND l.layer_id=?
      AND (l.chunk_x,l.chunk_y) IN (VALUES ${chunkValues})
      ORDER BY l.chunk_y,l.chunk_x,l.id LIMIT ?
    `).all(layerId, ...chunkCoordinates, MAX_VIEWPORT_LOCATIONS + 1) as LocationRow[];
    const truncated = rows.length > MAX_VIEWPORT_LOCATIONS;
    const locations = rows.slice(0, MAX_VIEWPORT_LOCATIONS).map(mapLocation);
    const localIds = locations.map((item) => item.id);
    const normalRoutes = this.getRoutes(localIds).filter((route) => route.routeType === "normal");
    const transitionRows = localIds.length === 0 ? [] : this.db.prepare(`
      SELECT id,from_location,to_location,route_type,transition_kind,from_direction,to_direction,version
      FROM routes WHERE is_active=1 AND route_type IN ('transition','portal')
      AND (from_location IN (${placeholders(localIds)}) OR to_location IN (${placeholders(localIds)}))
      ORDER BY id
    `).all(...localIds, ...localIds) as RouteRow[];
    const transitionRoutes = transitionRows.map(mapRoute);
    const localIdSet = new Set(localIds);
    const remoteIds = [...new Set(transitionRoutes.flatMap((route) => [route.fromLocation, route.toLocation]).filter((id) => !localIdSet.has(id)))];
    return {
      ...common, locations, remoteLocations: this.getLocations(remoteIds),
      routes: [...normalRoutes, ...transitionRoutes], truncated,
    };
  }

  private cleanupExpiredLocks() {
    const now = this.now().toISOString();
    this.db.prepare("DELETE FROM map_edit_locks WHERE lease_expires_at<=?").run(now);
    this.db.prepare("UPDATE map_edit_sessions SET state='expired' WHERE state='active' AND lease_expires_at<=?").run(now);
  }

  getActiveLocks(): MapLock[] {
    this.cleanupExpiredLocks();
    const rows = this.db.prepare(`
      SELECT l.scope_key,l.session_id,l.player_id,p.name AS player_name,l.lease_expires_at
      FROM map_edit_locks l JOIN players p ON p.id=l.player_id ORDER BY l.scope_key
    `).all() as Array<{ scope_key: string; session_id: string; player_id: string; player_name: string; lease_expires_at: string }>;
    return rows.map((row) => ({ scopeKey: row.scope_key, sessionId: row.session_id, playerId: row.player_id, playerName: row.player_name, leaseExpiresAt: row.lease_expires_at }));
  }

  acquireMapLocks(playerId: string, scopeKeys: string[], existingSessionId?: string): MapEditSessionState {
    const scopes = [...new Set(scopeKeys)].sort();
    if (scopes.length === 0) throw new Error("至少需要选择一个编辑区域。");
    return inTransaction(this.db, () => {
      this.cleanupExpiredLocks();
      const now = this.now();
      const lease = new Date(now.getTime() + EDIT_LEASE_MS).toISOString();
      let sessionId = existingSessionId;
      if (sessionId) {
        const session = this.db.prepare("SELECT player_id,state FROM map_edit_sessions WHERE id=?").get(sessionId) as { player_id: string; state: string } | undefined;
        if (!session || session.player_id !== playerId || session.state !== "active") throw new Error("编辑会话已经失效。");
      } else {
        sessionId = randomUUID();
        this.db.prepare("INSERT INTO map_edit_sessions(id,player_id,state,lease_expires_at,created_at,updated_at) VALUES (?,?,'active',?,?,?)")
          .run(sessionId, playerId, lease, now.toISOString(), now.toISOString());
      }
      for (const scope of scopes) {
        const held = this.db.prepare("SELECT session_id FROM map_edit_locks WHERE scope_key=?").get(scope) as { session_id: string } | undefined;
        if (held && held.session_id !== sessionId) throw new Error(`区域 ${scope} 正由其他玩家编辑。`);
      }
      for (const scope of scopes) {
        this.db.prepare(`
          INSERT INTO map_edit_locks(scope_key,session_id,player_id,lease_expires_at) VALUES (?,?,?,?)
          ON CONFLICT(scope_key) DO UPDATE SET lease_expires_at=excluded.lease_expires_at
        `).run(scope, sessionId, playerId, lease);
      }
      this.db.prepare("UPDATE map_edit_locks SET lease_expires_at=? WHERE session_id=?").run(lease, sessionId);
      this.db.prepare("UPDATE map_edit_sessions SET lease_expires_at=?,updated_at=? WHERE id=?").run(lease, now.toISOString(), sessionId);
      return this.getEditSession(playerId, sessionId);
    });
  }

  renewMapLocks(playerId: string, sessionId: string) {
    return inTransaction(this.db, () => {
      this.cleanupExpiredLocks();
      const session = this.getEditSession(playerId, sessionId);
      const now = this.now();
      const lease = new Date(now.getTime() + EDIT_LEASE_MS).toISOString();
      this.db.prepare("UPDATE map_edit_sessions SET lease_expires_at=?,updated_at=? WHERE id=?").run(lease, now.toISOString(), sessionId);
      this.db.prepare("UPDATE map_edit_locks SET lease_expires_at=? WHERE session_id=?").run(lease, sessionId);
      return { ...session, leaseExpiresAt: lease };
    });
  }

  releaseMapLocks(playerId: string, sessionId: string) {
    return inTransaction(this.db, () => {
      this.getEditSession(playerId, sessionId);
      this.db.prepare("DELETE FROM map_edit_locks WHERE session_id=?").run(sessionId);
      this.db.prepare("UPDATE map_edit_sessions SET state='committed',updated_at=? WHERE id=?").run(this.now().toISOString(), sessionId);
      return true;
    });
  }

  getEditSession(playerId: string, sessionId: string): MapEditSessionState {
    const row = this.db.prepare("SELECT id,player_id,state,lease_expires_at FROM map_edit_sessions WHERE id=?").get(sessionId) as {
      id: string; player_id: string; state: string; lease_expires_at: string;
    } | undefined;
    if (!row || row.player_id !== playerId || row.state !== "active" || row.lease_expires_at <= this.now().toISOString()) throw new Error("编辑会话不存在或租约已过期。");
    const scopes = this.db.prepare("SELECT scope_key FROM map_edit_locks WHERE session_id=? ORDER BY scope_key").all(sessionId) as Array<{ scope_key: string }>;
    return { id: row.id, scopes: scopes.map((item) => item.scope_key), leaseExpiresAt: row.lease_expires_at, history: this.getHistoryState(sessionId) };
  }

  private getHistoryState(sessionId: string): MapHistoryState {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count,SUM(CASE WHEN undone=0 THEN 1 ELSE 0 END) AS active_count,
             SUM(CASE WHEN undone=1 THEN 1 ELSE 0 END) AS undone_count FROM map_edit_operations WHERE session_id=?
    `).get(sessionId) as { count: number; active_count: number | null; undone_count: number | null };
    return { canUndo: (row.active_count ?? 0) > 0, canRedo: (row.undone_count ?? 0) > 0, operationCount: row.count };
  }

  private assertScopes(sessionId: string, scopes: string[]) {
    for (const scope of [...new Set(scopes)]) {
      if (!this.db.prepare("SELECT 1 FROM map_edit_locks WHERE scope_key=? AND session_id=? AND lease_expires_at>?").get(scope, sessionId, this.now().toISOString())) {
        throw new Error(`缺少 ${scope} 的有效编辑锁。`);
      }
    }
  }

  private locationScope(location: Location) {
    return location.regionId ? `region:${location.regionId}` : `layer:${location.layerId}:chunk:${chunkKey(location.chunkX, location.chunkY)}`;
  }

  private scopesForOperation(operation: MapEditOperation): string[] {
    if (operation.type === "layer.create") return [operation.layer.parentLayerId ? `layer:${operation.layer.parentLayerId}` : "layer:world-root"];
    if (operation.type === "layer.update" || operation.type === "layer.delete") return [`layer:${operation.layerId}`];
    if (operation.type === "region.create") return [`layer:${operation.region.layerId}:chunk:${chunkKey(Math.floor(operation.region.x / 1000), Math.floor(operation.region.y / 1000))}`];
    if (operation.type === "region.update" || operation.type === "region.delete") return [`region:${operation.regionId}`];
    if (operation.type === "location.create") {
      const chunk = chunkForGrid(operation.location.gridX, operation.location.gridY);
      return [operation.location.regionId ? `region:${operation.location.regionId}` : `layer:${operation.location.layerId}:chunk:${chunkKey(chunk.chunkX, chunk.chunkY)}`];
    }
    if (operation.type === "location.update" || operation.type === "location.delete") {
      const current = this.getLocation(operation.locationId);
      const scopes = [this.locationScope(current)];
      if (operation.type === "location.update" && (operation.patch.gridX !== undefined || operation.patch.gridY !== undefined || operation.patch.regionId !== undefined)) {
        const chunk = chunkForGrid(operation.patch.gridX ?? current.gridX, operation.patch.gridY ?? current.gridY);
        const regionId = operation.patch.regionId === undefined ? current.regionId : operation.patch.regionId;
        scopes.push(regionId ? `region:${regionId}` : `layer:${current.layerId}:chunk:${chunkKey(chunk.chunkX, chunk.chunkY)}`);
      }
      return scopes;
    }
    if (operation.type === "route.create") return [this.locationScope(this.getLocation(operation.fromLocation)), this.locationScope(this.getLocation(operation.toLocation))];
    const route = this.getRoute(operation.routeId);
    return [this.locationScope(this.getLocation(route.fromLocation)), this.locationScope(this.getLocation(route.toLocation))];
  }

  applyMapOperation(playerId: string, sessionId: string, operation: MapEditOperation) {
    return inTransaction(this.db, () => {
      this.getEditSession(playerId, sessionId);
      this.assertScopes(sessionId, this.scopesForOperation(operation));
      this.db.prepare("DELETE FROM map_edit_operations WHERE session_id=? AND undone=1").run(sessionId);
      const result = this.applyOperation(operation);
      this.db.prepare("INSERT INTO map_edit_operations(session_id,operation_type,forward_json,inverse_json,undone,created_at) VALUES (?,?,?,?,0,?)")
        .run(sessionId, operation.type, JSON.stringify(result.forward), JSON.stringify(result.inverse), this.now().toISOString());
      this.db.prepare(`DELETE FROM map_edit_operations WHERE session_id=? AND id NOT IN (SELECT id FROM map_edit_operations WHERE session_id=? ORDER BY id DESC LIMIT ?)`)
        .run(sessionId, sessionId, MAX_HISTORY);
      return { invalidatedChunks: result.invalidatedChunks, history: this.getHistoryState(sessionId) };
    });
  }

  undoMapOperation(playerId: string, sessionId: string) {
    return inTransaction(this.db, () => {
      this.getEditSession(playerId, sessionId);
      const row = this.db.prepare("SELECT id,inverse_json FROM map_edit_operations WHERE session_id=? AND undone=0 ORDER BY id DESC LIMIT 1").get(sessionId) as { id: number; inverse_json: string } | undefined;
      if (!row) throw new Error("没有可以撤销的操作。");
      const inverse = JSON.parse(row.inverse_json) as MapEditOperation;
      this.assertScopes(sessionId, this.scopesForOperation(inverse));
      const result = this.applyOperation(inverse);
      this.db.prepare("UPDATE map_edit_operations SET undone=1 WHERE id=?").run(row.id);
      return { invalidatedChunks: result.invalidatedChunks, history: this.getHistoryState(sessionId) };
    });
  }

  redoMapOperation(playerId: string, sessionId: string) {
    return inTransaction(this.db, () => {
      this.getEditSession(playerId, sessionId);
      const row = this.db.prepare("SELECT id,forward_json FROM map_edit_operations WHERE session_id=? AND undone=1 ORDER BY id ASC LIMIT 1").get(sessionId) as { id: number; forward_json: string } | undefined;
      if (!row) throw new Error("没有可以重做的操作。");
      const forward = JSON.parse(row.forward_json) as MapEditOperation;
      this.assertScopes(sessionId, this.scopesForOperation(forward));
      const result = this.applyOperation(forward);
      this.db.prepare("UPDATE map_edit_operations SET undone=0 WHERE id=?").run(row.id);
      return { invalidatedChunks: result.invalidatedChunks, history: this.getHistoryState(sessionId) };
    });
  }

  private applyOperation(operation: MapEditOperation): { forward: MapEditOperation; inverse: MapEditOperation; invalidatedChunks: string[] } {
    const now = this.now().toISOString();
    if (operation.type === "layer.create") {
      const layer = { ...operation.layer, id: operation.layer.id || `layer-${randomUUID()}` };
      if (layer.parentLayerId) this.getLayer(layer.parentLayerId);
      const name = cleanText(layer.name, "地图层名称", 40);
      const description = cleanText(layer.description, "地图层描述", 200);
      if (this.db.prepare("SELECT 1 FROM map_layers WHERE id=?").get(layer.id)) {
        this.db.prepare("UPDATE map_layers SET name=?,description=?,parent_layer_id=?,is_active=1,version=version+1,updated_at=? WHERE id=?")
          .run(name, description, layer.parentLayerId, now, layer.id);
      } else {
        this.db.prepare(`INSERT INTO map_layers(id,name,description,parent_layer_id,version,is_active,created_at,updated_at) VALUES (?,?,?,?,1,1,?,?)`)
          .run(layer.id, name, description, layer.parentLayerId, now, now);
      }
      return { forward: { type: "layer.create", layer }, inverse: { type: "layer.delete", layerId: layer.id }, invalidatedChunks: [] };
    }
    if (operation.type === "layer.update") {
      const current = this.getLayer(operation.layerId);
      if (operation.expectedVersion && operation.expectedVersion !== current.version) throw new Error("地图层已被更新，请刷新后重试。");
      const parent = operation.patch.parentLayerId === undefined ? current.parentLayerId : operation.patch.parentLayerId;
      if (parent === current.id) throw new Error("地图层不能以自身为父级。");
      if (parent) this.getLayer(parent);
      let ancestor = parent;
      while (ancestor) {
        if (ancestor === current.id) throw new Error("地图层不能移入自己的子层。");
        ancestor = (this.db.prepare("SELECT parent_layer_id FROM map_layers WHERE id=? AND is_active=1").get(ancestor) as { parent_layer_id: string | null } | undefined)?.parent_layer_id ?? null;
      }
      const name = operation.patch.name === undefined ? current.name : cleanText(operation.patch.name, "地图层名称", 40);
      const description = operation.patch.description === undefined ? current.description : cleanText(operation.patch.description, "地图层描述", 200);
      this.db.prepare("UPDATE map_layers SET name=?,description=?,parent_layer_id=?,version=version+1,updated_at=? WHERE id=?").run(name, description, parent, now, current.id);
      return { forward: operation, inverse: { type: "layer.update", layerId: current.id, patch: { name: current.name, description: current.description, parentLayerId: current.parentLayerId } }, invalidatedChunks: [] };
    }
    if (operation.type === "layer.delete") {
      if (["world-root", "home-ground", "song-overview", "palos-overview"].includes(operation.layerId)) throw new Error("初始地图层不能删除。");
      const current = this.getLayer(operation.layerId);
      const used = this.db.prepare("SELECT 1 FROM locations WHERE layer_id=? AND is_active=1 UNION SELECT 1 FROM map_layers WHERE parent_layer_id=? AND is_active=1 LIMIT 1").get(current.id, current.id);
      if (used) throw new Error("地图层仍包含地点或子层，不能删除。");
      this.db.prepare("UPDATE map_layers SET is_active=0,version=version+1,updated_at=? WHERE id=?").run(now, current.id);
      return { forward: operation, inverse: { type: "layer.create", layer: current }, invalidatedChunks: [] };
    }
    if (operation.type === "region.create") {
      const region = { ...operation.region, id: operation.region.id || `region-${randomUUID()}` };
      this.getLayer(region.layerId);
      const name = cleanText(region.name, "区域名称", 40);
      const description = cleanText(region.description, "区域描述", 200);
      if (this.db.prepare("SELECT 1 FROM map_regions WHERE id=?").get(region.id)) {
        this.db.prepare("UPDATE map_regions SET layer_id=?,name=?,description=?,x=?,y=?,width=?,height=?,is_active=1,version=version+1,updated_at=? WHERE id=?")
          .run(region.layerId, name, description, region.x, region.y, Math.max(160, region.width), Math.max(160, region.height), now, region.id);
      } else {
        this.db.prepare(`INSERT INTO map_regions(id,layer_id,name,description,x,y,width,height,version,is_active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,1,1,?,?)`)
          .run(region.id, region.layerId, name, description, region.x, region.y, Math.max(160, region.width), Math.max(160, region.height), now, now);
      }
      return { forward: { type: "region.create", region }, inverse: { type: "region.delete", regionId: region.id }, invalidatedChunks: [] };
    }
    if (operation.type === "region.update") {
      const current = this.getRegion(operation.regionId);
      if (operation.expectedVersion && operation.expectedVersion !== current.version) throw new Error("区域已被更新，请刷新后重试。");
      const next = {
        name: operation.patch.name === undefined ? current.name : cleanText(operation.patch.name, "区域名称", 40),
        description: operation.patch.description === undefined ? current.description : cleanText(operation.patch.description, "区域描述", 200),
        x: operation.patch.x ?? current.x, y: operation.patch.y ?? current.y,
        width: Math.max(160, operation.patch.width ?? current.width), height: Math.max(160, operation.patch.height ?? current.height),
      };
      this.db.prepare("UPDATE map_regions SET name=?,description=?,x=?,y=?,width=?,height=?,version=version+1,updated_at=? WHERE id=?")
        .run(next.name, next.description, next.x, next.y, next.width, next.height, now, current.id);
      this.db.prepare("UPDATE locations SET region=?,version=version+1 WHERE region_id=?").run(next.name, current.id);
      return { forward: operation, inverse: { type: "region.update", regionId: current.id, patch: { name: current.name, description: current.description, x: current.x, y: current.y, width: current.width, height: current.height } }, invalidatedChunks: [] };
    }
    if (operation.type === "region.delete") {
      if (operation.regionId === "home") throw new Error("初始之家区域不能删除。");
      const current = this.getRegion(operation.regionId);
      if (this.db.prepare("SELECT 1 FROM locations WHERE region_id=? AND is_active=1 LIMIT 1").get(current.id)) throw new Error("区域内仍有地点，不能删除。");
      this.db.prepare("UPDATE map_regions SET is_active=0,version=version+1,updated_at=? WHERE id=?").run(now, current.id);
      return { forward: operation, inverse: { type: "region.create", region: current }, invalidatedChunks: [] };
    }
    if (operation.type === "location.create") {
      const id = operation.location.id || `location-${randomUUID()}`;
      const { layerId, gridX, gridY, regionId } = operation.location;
      this.getLayer(layerId);
      if (this.db.prepare("SELECT 1 FROM locations WHERE layer_id=? AND grid_x=? AND grid_y=? AND is_active=1 AND id<>?").get(layerId, gridX, gridY, id)) throw new Error("目标网格已被其他地点占用。");
      const region = regionId ? this.getRegion(regionId) : null;
      if (region && region.layerId !== layerId) throw new Error("地点与区域必须属于同一地图层。");
      const position = gridToWorldPosition(gridX, gridY);
      const chunk = chunkForGrid(gridX, gridY);
      const name = cleanText(operation.location.name, "地点名称", 40);
      const description = cleanText(operation.location.description, "地点描述", 200);
      if (this.db.prepare("SELECT 1 FROM locations WHERE id=?").get(id)) {
        this.db.prepare(`
          UPDATE locations SET layer_id=?,name=?,region=?,description=?,x=?,y=?,region_id=?,grid_x=?,grid_y=?,chunk_x=?,chunk_y=?,is_active=1,version=version+1 WHERE id=?
        `).run(layerId, name, region?.name ?? "公共区域", description, position.x, position.y, regionId, gridX, gridY, chunk.chunkX, chunk.chunkY, id);
      } else {
        this.db.prepare(`
          INSERT INTO locations(id,layer_id,name,region,description,x,y,region_id,grid_x,grid_y,chunk_x,chunk_y,version,is_active)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,1)
        `).run(id, layerId, name, region?.name ?? "公共区域", description, position.x, position.y, regionId, gridX, gridY, chunk.chunkX, chunk.chunkY);
      }
      this.db.prepare("INSERT OR IGNORE INTO action_definitions(id,location_id,name,description,stamina_delta,silver_delta,cultivation_delta,hp_delta,result_template) VALUES (?,?,'观察','观察这个地点的环境。',0,0,0,0,'{name}在此观察四周。')").run(`observe-${id}`, id);
      const forward: MapEditOperation = { type: "location.create", location: { id, layerId, name, description, regionId, gridX, gridY } };
      return { forward, inverse: { type: "location.delete", locationId: id }, invalidatedChunks: [`${layerId}:${chunkKey(chunk.chunkX, chunk.chunkY)}`] };
    }
    if (operation.type === "location.update") {
      const current = this.getLocation(operation.locationId);
      if (operation.expectedVersion && operation.expectedVersion !== current.version) throw new Error("地点已被更新，请刷新后重试。");
      const gridX = operation.patch.gridX ?? current.gridX;
      const gridY = operation.patch.gridY ?? current.gridY;
      const regionId = operation.patch.regionId === undefined ? current.regionId : operation.patch.regionId;
      if (this.db.prepare("SELECT 1 FROM locations WHERE layer_id=? AND grid_x=? AND grid_y=? AND is_active=1 AND id<>?").get(current.layerId, gridX, gridY, current.id)) throw new Error("目标网格已被其他地点占用。");
      const region = regionId ? this.getRegion(regionId) : null;
      if (region && region.layerId !== current.layerId) throw new Error("地点与区域必须属于同一地图层。");
      const connected = this.getRoutes().filter((route) => route.routeType === "normal" && (route.fromLocation === current.id || route.toLocation === current.id));
      for (const route of connected) {
        const other = this.getLocation(route.fromLocation === current.id ? route.toLocation : route.fromLocation);
        const direction = route.fromLocation === current.id ? directionBetween({ gridX, gridY }, other) : directionBetween(other, { gridX, gridY });
        const expected = route.fromLocation === current.id ? route.fromDirection : route.toDirection;
        if (!direction || direction !== expected) throw new Error("地点仍连接普通路线，请先删除路线再移动。");
      }
      const position = gridToWorldPosition(gridX, gridY);
      const chunk = chunkForGrid(gridX, gridY);
      const name = operation.patch.name === undefined ? current.name : cleanText(operation.patch.name, "地点名称", 40);
      const description = operation.patch.description === undefined ? current.description : cleanText(operation.patch.description, "地点描述", 200);
      this.db.prepare("UPDATE locations SET name=?,region=?,description=?,region_id=?,grid_x=?,grid_y=?,x=?,y=?,chunk_x=?,chunk_y=?,version=version+1 WHERE id=?")
        .run(name, region?.name ?? "公共区域", description, regionId, gridX, gridY, position.x, position.y, chunk.chunkX, chunk.chunkY, current.id);
      return {
        forward: operation,
        inverse: { type: "location.update", locationId: current.id, patch: { name: current.name, description: current.description, regionId: current.regionId, gridX: current.gridX, gridY: current.gridY } },
        invalidatedChunks: [...new Set([`${current.layerId}:${chunkKey(current.chunkX, current.chunkY)}`, `${current.layerId}:${chunkKey(chunk.chunkX, chunk.chunkY)}`])],
      };
    }
    if (operation.type === "location.delete") {
      if (["home-entrance", "home-training-room"].includes(operation.locationId)) throw new Error("关键初始地点不能删除。");
      const current = this.getLocation(operation.locationId);
      if (this.db.prepare("SELECT 1 FROM players WHERE current_location=? LIMIT 1").get(current.id)) throw new Error("仍有玩家位于该地点，不能删除。");
      if (this.db.prepare("SELECT 1 FROM routes WHERE is_active=1 AND (from_location=? OR to_location=?) LIMIT 1").get(current.id, current.id)) throw new Error("请先删除地点连接的路线。");
      this.db.prepare("UPDATE locations SET is_active=0,version=version+1 WHERE id=?").run(current.id);
      return {
        forward: operation,
        inverse: { type: "location.create", location: { id: current.id, layerId: current.layerId, name: current.name, description: current.description, regionId: current.regionId, gridX: current.gridX, gridY: current.gridY } },
        invalidatedChunks: [`${current.layerId}:${chunkKey(current.chunkX, current.chunkY)}`],
      };
    }
    if (operation.type === "route.create") {
      const from = this.getLocation(operation.fromLocation);
      const to = this.getLocation(operation.toLocation);
      if (from.id === to.id) throw new Error("路线不能连接地点自身。");
      let fromDirection: Direction | null = null;
      let toDirection: Direction | null = null;
      if (operation.routeType === "normal") {
        if (from.layerId !== to.layerId) throw new Error("普通路线只能连接同一地图层。");
        fromDirection = directionBetween(from, to);
        if (!fromDirection) throw new Error("普通路线只能连接八方向相邻一格。");
        toDirection = OPPOSITE_DIRECTION[fromDirection];
        if (this.db.prepare("SELECT 1 FROM location_direction_slots WHERE location_id=? AND direction=?").get(from.id, fromDirection)) throw new Error("起点该方向已有路线。");
        if (this.db.prepare("SELECT 1 FROM location_direction_slots WHERE location_id=? AND direction=?").get(to.id, toDirection)) throw new Error("终点反方向已有路线。");
      }
      if (operation.routeType === "transition" && from.layerId === to.layerId) throw new Error("跨层连接必须连接不同地图层。");
      const routeId = operation.routeId || `route-${randomUUID()}`;
      const kind = operation.routeType === "portal" ? "portal" : operation.routeType === "transition" ? operation.transitionKind ?? "door" : null;
      this.db.prepare("DELETE FROM routes WHERE is_active=0 AND ((from_location=? AND to_location=?) OR (from_location=? AND to_location=?))").run(from.id, to.id, to.id, from.id);
      this.db.prepare(`INSERT INTO routes(from_location,to_location,stamina_cost,id,route_type,transition_kind,from_direction,to_direction,version,is_active) VALUES (?,?,0,?,?,?,?,?,1,1)`)
        .run(from.id, to.id, routeId, operation.routeType, kind, fromDirection, toDirection);
      if (fromDirection && toDirection) {
        this.db.prepare("INSERT INTO location_direction_slots(location_id,direction,route_id,target_location) VALUES (?,?,?,?)").run(from.id, fromDirection, routeId, to.id);
        this.db.prepare("INSERT INTO location_direction_slots(location_id,direction,route_id,target_location) VALUES (?,?,?,?)").run(to.id, toDirection, routeId, from.id);
      }
      const forward: MapEditOperation = { ...operation, transitionKind: kind ?? undefined, routeId };
      return { forward, inverse: { type: "route.delete", routeId }, invalidatedChunks: [...new Set([`${from.layerId}:${chunkKey(from.chunkX, from.chunkY)}`, `${to.layerId}:${chunkKey(to.chunkX, to.chunkY)}`])] };
    }
    const route = this.getRoute(operation.routeId);
    const from = this.getLocation(route.fromLocation);
    const to = this.getLocation(route.toLocation);
    this.db.prepare("DELETE FROM location_direction_slots WHERE route_id=?").run(route.id);
    this.db.prepare("DELETE FROM routes WHERE id=?").run(route.id);
    return {
      forward: operation,
      inverse: { type: "route.create", routeId: route.id, fromLocation: route.fromLocation, toLocation: route.toLocation, routeType: route.routeType, transitionKind: route.transitionKind ?? undefined },
      invalidatedChunks: [...new Set([`${from.layerId}:${chunkKey(from.chunkX, from.chunkY)}`, `${to.layerId}:${chunkKey(to.chunkX, to.chunkY)}`])],
    };
  }

  getRegion(regionId: string) {
    const row = this.db.prepare("SELECT id,layer_id,name,description,x,y,width,height,version FROM map_regions WHERE id=? AND is_active=1").get(regionId) as RegionRow | undefined;
    if (!row) throw new Error("大区域不存在或已停用。");
    return mapRegion(row);
  }

  getRoute(routeId: string) {
    const row = this.db.prepare("SELECT id,from_location,to_location,route_type,transition_kind,from_direction,to_direction,version FROM routes WHERE id=? AND is_active=1").get(routeId) as RouteRow | undefined;
    if (!row) throw new Error("路线不存在或已停用。");
    return mapRoute(row);
  }

  move(playerId: string, destinationId: string): GameMutation {
    return inTransaction(this.db, () => {
      this.settleCultivationInternal(playerId, this.now(), false);
      const player = this.getPlayer(playerId);
      if (destinationId === player.currentLocation) throw new Error("你已经在这里了。");
      if (!this.db.prepare("SELECT 1 FROM routes WHERE is_active=1 AND ((from_location=? AND to_location=?) OR (from_location=? AND to_location=?))").get(player.currentLocation, destinationId, destinationId, player.currentLocation)) {
        throw new Error("两地之间没有可通行的路线。");
      }
      const destination = this.getLocation(destinationId);
      const at = this.now().toISOString();
      const content = `${player.name}前往${destination.region} - ${destination.name}。`;
      this.db.prepare("UPDATE players SET current_location=?,updated_at=?,last_seen_at=? WHERE id=?").run(destinationId, at, at, playerId);
      this.db.prepare("UPDATE player_progression SET training_anchor_at=?,updated_at=? WHERE player_id=?")
        .run(destination.trainingMultiplier > 0 ? at : null, at, playerId);
      this.db.prepare(`
        INSERT INTO player_visited_locations(player_id,location_id,first_visited_at,last_visited_at)
        VALUES (?,?,?,?)
        ON CONFLICT(player_id,location_id) DO UPDATE SET last_visited_at=excluded.last_visited_at
      `).run(playerId, destinationId, at, at);
      this.db.prepare("INSERT INTO action_logs(player_id,kind,from_location,to_location,result_text,created_at) VALUES (?,'move',?,?,?,?)")
        .run(playerId, player.currentLocation, destinationId, content, at);
      const result = this.db.prepare("INSERT INTO world_events(player_id,event_type,content,created_at) VALUES (?,'move',?,?)").run(playerId, content, at);
      const event = this.db.prepare("SELECT id,player_id,event_type,content,created_at FROM world_events WHERE id=?").get(result.lastInsertRowid) as EventRow;
      return { self: this.getPlayer(playerId), event: mapEvent(event), message: `已抵达${destination.name}` };
    });
  }

  act(playerId: string, actionId: string): GameMutation {
    return inTransaction(this.db, () => {
      this.settleCultivationInternal(playerId, this.now(), false);
      const player = this.getPlayer(playerId);
      const row = this.db.prepare(`
        SELECT id,location_id,name,description,silver_delta,hp_delta,result_template FROM action_definitions WHERE id=?
      `).get(actionId) as { id: string; location_id: string; name: string; description: string; silver_delta: number; hp_delta: number; result_template: string } | undefined;
      if (!row || row.location_id !== player.currentLocation) throw new Error("这里无法进行这项行动。");
      const action: ActionDefinition = { id: row.id, locationId: row.location_id, name: row.name, description: row.description, silverDelta: row.silver_delta, hpDelta: row.hp_delta };
      if (player.silver + action.silverDelta < 0) throw new Error("银两不足。");
      const hp = Math.max(0, Math.min(player.maxHp, player.hp + action.hpDelta));
      const at = this.now().toISOString();
      const content = row.result_template.replace("{name}", player.name);
      this.db.prepare("UPDATE players SET hp=?,silver=?,updated_at=?,last_seen_at=? WHERE id=?").run(hp, player.silver + action.silverDelta, at, at, playerId);
      this.db.prepare("INSERT INTO action_logs(player_id,kind,action_id,action_template_id,from_location,to_location,result_text,created_at) VALUES (?,'action',?,?,?,?,?,?)")
        .run(playerId, action.id, action.id, player.currentLocation, player.currentLocation, content, at);
      const result = this.db.prepare("INSERT INTO world_events(player_id,event_type,content,created_at) VALUES (?,'action',?,?)").run(playerId, content, at);
      const event = this.db.prepare("SELECT id,player_id,event_type,content,created_at FROM world_events WHERE id=?").get(result.lastInsertRowid) as EventRow;
      const effect = effectSummary(action);
      return { self: this.getPlayer(playerId), event: mapEvent(event), message: `${action.name}完成${effect ? ` · ${effect}` : ""}` };
    });
  }

  sendChat(playerId: string, rawContent: string): ChatMessage {
    const content = cleanText(rawContent, "消息", 120);
    const player = this.getPlayer(playerId);
    const createdAt = this.now().toISOString();
    const result = this.db.prepare("INSERT INTO chat_messages(player_id,content,created_at) VALUES (?,?,?)").run(playerId, content, createdAt);
    this.touchPlayers([playerId]);
    return { id: Number(result.lastInsertRowid), playerId, playerName: player.name, content, createdAt };
  }

  touchPlayers(playerIds: string[]) {
    const ids = [...new Set(playerIds)];
    if (ids.length === 0) return;
    const statement = this.db.prepare("UPDATE players SET last_seen_at=? WHERE id=?");
    inTransaction(this.db, () => {
      const at = this.now().toISOString();
      for (const id of ids) statement.run(at, id);
    });
  }
}

declare global {
  var __wuxiaGameService: GameService | undefined;
}

export function getGameService() {
  globalThis.__wuxiaGameService ??= new GameService();
  return globalThis.__wuxiaGameService;
}
