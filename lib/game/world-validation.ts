import type { DatabaseSync } from "node:sqlite";
import { DIRECTION_DELTAS, OPPOSITE_DIRECTION } from "./map";
import { DIRECTIONS, type Direction } from "./types";
import { buildWorldSeed, KAIFENG_BUILDING_LAYER_IDS, WORLD_SEED_REVISION } from "./world-data";

export type MapValidationReport = {
  ok: boolean;
  errors: string[];
  warnings: string[];
  counts: {
    layers: number;
    regions: number;
    locations: number;
    routes: number;
    sourcedLocations: number;
    songLocations: number;
    homeLocations: number;
    buildingLocations: number;
    shopfrontLocations: number;
    fastTravelLocations: number;
    overworldLocations: number;
    reachableLocations: number;
  };
};

type RouteValidationRow = {
  id: string;
  route_type: string;
  transition_kind: string | null;
  from_direction: string | null;
  to_direction: string | null;
  from_location: string;
  to_location: string;
  from_layer: string;
  to_layer: string;
  from_grid_x: number;
  from_grid_y: number;
  to_grid_x: number;
  to_grid_y: number;
};

export function validateWorldMap(db: DatabaseSync): MapValidationReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const activeLayers = db.prepare("SELECT id,parent_layer_id FROM map_layers WHERE is_active=1").all() as Array<{ id: string; parent_layer_id: string | null }>;
  const layerIds = new Set(activeLayers.map((layer) => layer.id));
  const parents = new Map(activeLayers.map((layer) => [layer.id, layer.parent_layer_id]));
  for (const layer of activeLayers) {
    if (layer.parent_layer_id && !layerIds.has(layer.parent_layer_id)) errors.push(`地图层 ${layer.id} 的父层 ${layer.parent_layer_id} 不存在。`);
    const path = new Set<string>();
    let cursor: string | null = layer.id;
    while (cursor) {
      if (path.has(cursor)) {
        errors.push(`地图层级存在循环：${[...path, cursor].join(" -> ")}。`);
        break;
      }
      path.add(cursor);
      cursor = parents.get(cursor) ?? null;
    }
  }
  const canonicalLayers = new Set(["world-root", "home-ground", ...KAIFENG_BUILDING_LAYER_IDS]);
  const obsoleteSeedLayers = db.prepare("SELECT id FROM map_layers WHERE is_active=1 AND (seed_revision>0 OR id IN ('song-overview','palos-overview'))").all() as Array<{ id: string }>;
  for (const layer of obsoleteSeedLayers) {
    if (!canonicalLayers.has(layer.id)) errors.push(`种子地图层 ${layer.id} 不应在连续大地图中保持活动。`);
  }
  for (const layerId of canonicalLayers) {
    if (!layerIds.has(layerId)) errors.push(`标准地图层 ${layerId} 不存在或未启用。`);
  }
  const publicLocationsOutsideOverworld = db.prepare(`
    SELECT l.id,l.layer_id FROM locations l
    WHERE l.is_active=1 AND l.region_id='song' AND l.layer_id<>'world-root'
    ORDER BY l.id
  `).all() as Array<{ id: string; layer_id: string }>;
  if (publicLocationsOutsideOverworld.length > 0) {
    errors.push(`${publicLocationsOutsideOverworld.length} 个东京公共地点没有位于连续大地图：${publicLocationsOutsideOverworld.slice(0, 8).map((item) => item.id).join("、")}。`);
  }
  const activePalosLocations = (db.prepare("SELECT COUNT(*) AS count FROM locations WHERE is_active=1 AND (region_id='palos' OR id LIKE 'palos-%')").get() as { count: number }).count;
  if (activePalosLocations > 0) errors.push(`已移除的帕洛斯仍有 ${activePalosLocations} 个活动地点。`);
  if (db.prepare("SELECT 1 FROM routes WHERE id='route-entrance-road' AND is_active=1").get()) {
    errors.push("旧版玄关直达楼门路路线仍处于活动状态。住宅应通过大地图上的房屋入口进出。");
  }

  const routes = db.prepare(`
    SELECT r.id,r.route_type,r.transition_kind,r.from_direction,r.to_direction,
      r.from_location,r.to_location,
      f.layer_id AS from_layer,t.layer_id AS to_layer,
      f.grid_x AS from_grid_x,f.grid_y AS from_grid_y,t.grid_x AS to_grid_x,t.grid_y AS to_grid_y
    FROM routes r
    JOIN locations f ON f.id=r.from_location AND f.is_active=1
    JOIN locations t ON t.id=r.to_location AND t.is_active=1
    WHERE r.is_active=1
    ORDER BY r.id
  `).all() as RouteValidationRow[];
  const activeRouteCount = (db.prepare("SELECT COUNT(*) AS count FROM routes WHERE is_active=1").get() as { count: number }).count;
  if (routes.length !== activeRouteCount) errors.push("存在指向已删除或不存在地点的活动路线。");

  const slots = db.prepare("SELECT location_id,direction,route_id,target_location FROM location_direction_slots ORDER BY route_id,location_id")
    .all() as Array<{ location_id: string; direction: string; route_id: string; target_location: string }>;
  const slotsByRoute = new Map<string, typeof slots>();
  for (const slot of slots) {
    const group = slotsByRoute.get(slot.route_id) ?? [];
    group.push(slot);
    slotsByRoute.set(slot.route_id, group);
    if (!DIRECTIONS.includes(slot.direction as Direction)) errors.push(`路线 ${slot.route_id} 使用了非法方向 ${slot.direction}。`);
  }

  for (const route of routes) {
    const routeSlots = slotsByRoute.get(route.id) ?? [];
    if (route.route_type === "normal") {
      if (route.from_layer !== route.to_layer) errors.push(`普通路线 ${route.id} 跨越地图层。`);
      const dx = route.to_grid_x - route.from_grid_x;
      const dy = route.to_grid_y - route.from_grid_y;
      const expected = (Object.entries(DIRECTION_DELTAS).find(([, delta]) => delta[0] === dx && delta[1] === dy)?.[0] ?? null) as Direction | null;
      if (!expected) errors.push(`普通路线 ${route.id} 不是八方向相邻网格。`);
      if (expected && route.from_direction !== expected) errors.push(`普通路线 ${route.id} 的起点方向与坐标不符。`);
      if (expected && route.to_direction !== OPPOSITE_DIRECTION[expected]) errors.push(`普通路线 ${route.id} 的终点方向与坐标不符。`);
      if (route.transition_kind !== null) errors.push(`普通路线 ${route.id} 不应设置跨层类型。`);
      if (routeSlots.length !== 2) errors.push(`普通路线 ${route.id} 应占用两个互为反向的方向槽，实际为 ${routeSlots.length}。`);
      if (expected) {
        const fromSlot = routeSlots.find((slot) => slot.location_id === route.from_location);
        const toSlot = routeSlots.find((slot) => slot.location_id === route.to_location);
        if (!fromSlot || fromSlot.direction !== expected || fromSlot.target_location !== route.to_location) errors.push(`普通路线 ${route.id} 的起点方向槽无效。`);
        if (!toSlot || toSlot.direction !== OPPOSITE_DIRECTION[expected] || toSlot.target_location !== route.from_location) errors.push(`普通路线 ${route.id} 的终点方向槽无效。`);
      }
    } else if (route.route_type === "transition" || route.route_type === "portal") {
      if (route.route_type === "transition" && route.from_layer === route.to_layer) errors.push(`跨层路线 ${route.id} 的两端位于同一地图层。`);
      if (!route.transition_kind) errors.push(`跨层路线 ${route.id} 缺少类型。`);
      if (route.from_direction !== null || route.to_direction !== null) errors.push(`跨层路线 ${route.id} 不应占用八方向。`);
      if (routeSlots.length > 0) errors.push(`跨层路线 ${route.id} 错误占用了方向槽。`);
    } else {
      errors.push(`路线 ${route.id} 使用了未知类型 ${route.route_type}。`);
    }
  }

  const training = db.prepare(`
    SELECT l.id,e.multiplier FROM locations l
    JOIN location_effects e ON e.location_id=l.id AND e.effect_type='cultivation'
    WHERE l.id='home-training-room' AND l.is_active=1
  `).get() as { id: string; multiplier: number } | undefined;
  if (!training || training.multiplier <= 1) errors.push("住宅修炼房不存在或没有有效修炼倍率。");

  const expectedSeedIds = [...new Set([
    ...buildWorldSeed().locations.map((location) => location.id),
    ...buildWorldSeed().baseLocationSources.map((link) => link.locationId),
  ])];
  const missingSources = db.prepare(`
    SELECT l.id FROM locations l LEFT JOIN location_sources s ON s.location_id=l.id
    WHERE l.seed_revision>=? AND l.is_active=1 GROUP BY l.id HAVING COUNT(s.source_id)=0
  `).all(WORLD_SEED_REVISION) as Array<{ id: string }>;
  for (const location of missingSources) errors.push(`种子地点 ${location.id} 缺少来源记录。`);
  for (const id of expectedSeedIds) {
    if (!db.prepare("SELECT 1 FROM locations WHERE id=? AND is_active=1").get(id)) errors.push(`种子地点 ${id} 不存在。`);
  }

  const allLocations = db.prepare("SELECT id FROM locations WHERE is_active=1 ORDER BY id").all() as Array<{ id: string }>;
  const adjacency = new Map<string, string[]>();
  for (const route of routes) {
    adjacency.set(route.from_location, [...(adjacency.get(route.from_location) ?? []), route.to_location]);
    adjacency.set(route.to_location, [...(adjacency.get(route.to_location) ?? []), route.from_location]);
  }
  const reachable = new Set<string>();
  const queue = ["home-entrance"];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (reachable.has(current)) continue;
    reachable.add(current);
    for (const next of adjacency.get(current) ?? []) if (!reachable.has(next)) queue.push(next);
  }
  const unreachable = allLocations.filter((location) => !reachable.has(location.id));
  if (unreachable.length > 0) errors.push(`${unreachable.length} 个活动地点无法从玄关到达：${unreachable.slice(0, 8).map((item) => item.id).join("、")}${unreachable.length > 8 ? "……" : ""}`);

  const scalar = (sql: string, ...params: Array<string | number>) => (db.prepare(sql).get(...params) as { count: number }).count;
  const counts = {
    layers: activeLayers.length,
    regions: scalar("SELECT COUNT(*) AS count FROM map_regions WHERE is_active=1"),
    locations: allLocations.length,
    routes: routes.length,
    sourcedLocations: scalar("SELECT COUNT(DISTINCT s.location_id) AS count FROM location_sources s JOIN locations l ON l.id=s.location_id AND l.is_active=1"),
    songLocations: scalar("SELECT COUNT(*) AS count FROM locations WHERE is_active=1 AND region_id='song'"),
    homeLocations: scalar("SELECT COUNT(DISTINCT s.location_id) AS count FROM location_sources s JOIN locations l ON l.id=s.location_id AND l.is_active=1 WHERE s.source_id='source-home-design'"),
    buildingLocations: scalar("SELECT COUNT(*) AS count FROM locations WHERE is_active=1 AND layer_id LIKE 'kaifeng-%-ground'"),
    shopfrontLocations: buildWorldSeed().shopfronts.length,
    fastTravelLocations: scalar("SELECT COUNT(*) AS count FROM location_facilities WHERE is_active=1 AND facility_type='fast-travel'"),
    overworldLocations: scalar("SELECT COUNT(*) AS count FROM locations WHERE is_active=1 AND layer_id='world-root'"),
    reachableLocations: reachable.size,
  };
  if (counts.songLocations < 500) errors.push(`东京开封府地点只有 ${counts.songLocations} 个，至少需要500个。`);
  if (counts.locations < 500) errors.push(`地图地点总数只有 ${counts.locations} 个，至少需要500个。`);
  if (counts.buildingLocations < 89) errors.push(`东京开封府可进入建筑只有 ${counts.buildingLocations} 个室内地点，应至少有89个。`);
  if (counts.shopfrontLocations !== 120) errors.push(`东京开封府店铺门面为 ${counts.shopfrontLocations} 个，应为120个。`);
  if (counts.fastTravelLocations < 25) errors.push(`世界只有 ${counts.fastTravelLocations} 个快速旅行枢纽，应至少有25个。`);
  const geographicBounds = db.prepare(`
    SELECT region_id,MIN(grid_x) AS min_x,MAX(grid_x) AS max_x,MIN(grid_y) AS min_y,MAX(grid_y) AS max_y
    FROM locations WHERE is_active=1 AND region_id='song' GROUP BY region_id
  `).all() as Array<{ region_id: string; min_x: number; max_x: number; min_y: number; max_y: number }>;
  const boundsByRegion = new Map(geographicBounds.map((bounds) => [bounds.region_id, bounds]));
  const songBounds = boundsByRegion.get("song");
  if (!songBounds || songBounds.max_x - songBounds.min_x < 60 || songBounds.max_y - songBounds.min_y < 70) {
    errors.push("东京开封府没有展开为足够宽高的历史城市布局。");
  }
  if (scalar("SELECT COUNT(*) AS count FROM locations WHERE is_active=1 AND region_id='song' AND name LIKE '东京城·%'") < 900) {
    errors.push("东京开封府缺少足够完整的城门、街路、河桥与坊市节点。");
  }
  const requiredKaifengLocations = [
    "song-landmark-gate-nanxun",
    "song-landmark-old-gate-zhuque",
    "song-landmark-bridge-zhou",
    "song-landmark-gate-xuande",
    "song-landmark-temple-xiangguo",
    "song-landmark-garden-jinming",
    "song-landmark-garden-genyue",
  ];
  for (const id of requiredKaifengLocations) {
    if (!db.prepare("SELECT 1 FROM locations WHERE id=? AND is_active=1 AND region_id='song'").get(id)) {
      errors.push(`东京开封府关键历史地点 ${id} 不存在。`);
    }
  }
  const requiredBuildingRoutes = [
    "route-kaifeng-palace-entrance",
    "route-kaifeng-prefecture-entrance",
    "route-kaifeng-xiangguo-entrance",
    "route-kaifeng-guozijian-entrance",
    "route-kaifeng-panlou-entrance",
    "route-kaifeng-shop-medicine-entrance",
    "route-kaifeng-shop-tea-entrance",
    "route-kaifeng-shop-warehouse-entrance",
    "route-kaifeng-shop-silk-entrance",
    "route-kaifeng-shop-pawn-entrance",
    "route-kaifeng-shop-books-entrance",
    "route-kaifeng-shop-smithy-entrance",
    "route-kaifeng-shop-bath-entrance",
  ];
  for (const id of requiredBuildingRoutes) {
    if (!db.prepare("SELECT 1 FROM routes WHERE id=? AND is_active=1 AND route_type='transition'").get(id)) {
      errors.push(`东京开封府建筑入口 ${id} 不存在。`);
    }
  }
  for (const id of ["home-entrance", "song-landmark-bridge-zhou"]) {
    if (!db.prepare(`
      SELECT 1 FROM location_facilities
      WHERE location_id=? AND facility_type='fast-travel' AND is_active=1
    `).get(id)) {
      errors.push(`关键快速旅行枢纽 ${id} 未启用。`);
    }
  }
  const kaifengRouteStats = db.prepare(`
    SELECT COUNT(DISTINCT location_id) AS vertices FROM (
      SELECT r.id,f.id AS location_id FROM routes r
      JOIN locations f ON f.id=r.from_location AND f.is_active=1 AND f.region_id='song'
      JOIN locations t ON t.id=r.to_location AND t.is_active=1 AND t.region_id='song'
      WHERE r.is_active=1 AND r.route_type='normal'
      UNION ALL
      SELECT r.id,t.id AS location_id FROM routes r
      JOIN locations f ON f.id=r.from_location AND f.is_active=1 AND f.region_id='song'
      JOIN locations t ON t.id=r.to_location AND t.is_active=1 AND t.region_id='song'
      WHERE r.is_active=1 AND r.route_type='normal'
    )
  `).get() as { vertices: number };
  const kaifengEdgeCount = scalar(`
    SELECT COUNT(*) AS count FROM routes r
    JOIN locations f ON f.id=r.from_location AND f.is_active=1 AND f.region_id='song'
    JOIN locations t ON t.id=r.to_location AND t.is_active=1 AND t.region_id='song'
    WHERE r.is_active=1 AND r.route_type='normal'
  `);
  if (kaifengEdgeCount - kaifengRouteStats.vertices + 1 < 20) {
    errors.push("东京开封府道路缺少城郭街区应有的环路结构。");
  }
  if (!db.prepare("SELECT 1 FROM locations WHERE id='world-construction-site' AND is_active=1").get()) {
    errors.push("楼门路东端缺少建设中终点。");
  }
  if (counts.sourcedLocations < expectedSeedIds.length) warnings.push("部分非种子地点没有来源记录；编辑器自建地点允许无来源。");

  return { ok: errors.length === 0, errors: [...new Set(errors)], warnings: [...new Set(warnings)], counts };
}
