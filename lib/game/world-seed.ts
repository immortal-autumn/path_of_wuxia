import type { DatabaseSync } from "node:sqlite";
import { CHUNK_SIZE, GRID_SIZE } from "./map";
import { buildWorldSeed, WORLD_SEED_REVISION } from "./world-data";

export type WorldSeedReport = {
  revision: number;
  sources: number;
  layers: number;
  regions: number;
  locations: number;
  routes: number;
  actions: number;
};

/** Applies the bundled seed inside the caller's active transaction. */
export function applyWorldSeed(db: DatabaseSync): WorldSeedReport {
  const seed = buildWorldSeed();
  const now = new Date().toISOString();
  const sourceInsert = db.prepare(`
    INSERT INTO world_sources(id,title,url,content_version,retrieved_at,notes) VALUES (?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET title=excluded.title,url=excluded.url,
      content_version=excluded.content_version,retrieved_at=excluded.retrieved_at,notes=excluded.notes
  `);
  for (const source of seed.sources) {
    sourceInsert.run(source.id, source.title, source.url, source.contentVersion, source.retrievedAt, source.notes);
  }

  // These base records predate seed_revision and therefore look like user data.
  // Their stable IDs are reserved by the bundled world, so only these known
  // revision-1 hierarchy artifacts are retired explicitly.
  db.exec("UPDATE map_layers SET is_active=0 WHERE id IN ('song-overview','palos-overview')");
  db.prepare("DELETE FROM location_direction_slots WHERE route_id='route-entrance-road'").run();
  db.prepare("UPDATE routes SET is_active=0 WHERE id='route-entrance-road'").run();

  const deactivateMissing = (table: "map_layers" | "map_regions" | "locations", desiredIds: Set<string>) => {
    const rows = db.prepare(`SELECT id FROM ${table} WHERE seed_revision>0 AND seed_revision<?`).all(WORLD_SEED_REVISION) as Array<{ id: string }>;
    const deactivate = db.prepare(`UPDATE ${table} SET is_active=0 WHERE id=?`);
    for (const row of rows) if (!desiredIds.has(row.id)) deactivate.run(row.id);
  };

  deactivateMissing("map_layers", new Set(seed.layers.map((layer) => layer.id)));

  const layerInsert = db.prepare(`
    INSERT INTO map_layers(id,name,description,parent_layer_id,version,is_active,seed_revision,created_at,updated_at)
    VALUES (?,?,?,?,1,1,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,
      parent_layer_id=excluded.parent_layer_id,is_active=1,seed_revision=excluded.seed_revision,updated_at=excluded.updated_at
    WHERE map_layers.seed_revision<excluded.seed_revision
  `);
  for (const layer of seed.layers) {
    layerInsert.run(layer.id, layer.name, layer.description, layer.parentLayerId, WORLD_SEED_REVISION, now, now);
  }

  deactivateMissing("map_regions", new Set(seed.regions.map((region) => region.id)));

  const regionInsert = db.prepare(`
    INSERT INTO map_regions(id,layer_id,name,description,x,y,width,height,version,is_active,seed_revision,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,1,1,?,?,?)
    ON CONFLICT(id) DO UPDATE SET layer_id=excluded.layer_id,name=excluded.name,description=excluded.description,
      x=excluded.x,y=excluded.y,width=excluded.width,height=excluded.height,is_active=1,
      seed_revision=excluded.seed_revision,updated_at=excluded.updated_at
    WHERE map_regions.seed_revision<excluded.seed_revision
  `);
  for (const region of seed.regions) {
    regionInsert.run(
      region.id, region.layerId, region.name, region.description, region.x, region.y,
      region.width, region.height, WORLD_SEED_REVISION, now, now,
    );
  }

  deactivateMissing("locations", new Set(seed.locations.map((location) => location.id)));

  const regionNames = new Map((db.prepare("SELECT id,name FROM map_regions").all() as Array<{ id: string; name: string }>).map((row) => [row.id, row.name]));
  const locationInsert = db.prepare(`
    INSERT INTO locations(
      id,layer_id,name,region,description,x,y,region_id,grid_x,grid_y,chunk_x,chunk_y,
      version,is_active,seed_revision
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,1,?)
    ON CONFLICT(id) DO UPDATE SET layer_id=excluded.layer_id,name=excluded.name,region=excluded.region,
      description=excluded.description,x=excluded.x,y=excluded.y,region_id=excluded.region_id,
      grid_x=excluded.grid_x,grid_y=excluded.grid_y,chunk_x=excluded.chunk_x,chunk_y=excluded.chunk_y,
      is_active=1,seed_revision=excluded.seed_revision
    WHERE locations.seed_revision<excluded.seed_revision
  `);
  for (const location of seed.locations) {
    const x = location.gridX * GRID_SIZE;
    const y = location.gridY * GRID_SIZE;
    locationInsert.run(
      location.id, location.layerId, location.name, location.regionId ? regionNames.get(location.regionId) ?? "" : "公共区域",
      location.description, x, y, location.regionId, location.gridX, location.gridY,
      Math.floor(x / CHUNK_SIZE), Math.floor(y / CHUNK_SIZE), WORLD_SEED_REVISION,
    );
  }

  const routeInsert = db.prepare(`
    INSERT INTO routes(
      from_location,to_location,stamina_cost,id,route_type,transition_kind,from_direction,to_direction,
      version,is_active,seed_revision
    ) VALUES (?,?,0,?,?,?,?,?,1,1,?)
    ON CONFLICT(from_location,to_location) DO UPDATE SET id=excluded.id,route_type=excluded.route_type,
      transition_kind=excluded.transition_kind,from_direction=excluded.from_direction,to_direction=excluded.to_direction,
      stamina_cost=0,is_active=1,seed_revision=excluded.seed_revision
    WHERE routes.seed_revision<excluded.seed_revision
  `);
  const slotInsert = db.prepare(`
    INSERT INTO location_direction_slots(location_id,direction,route_id,target_location) VALUES (?,?,?,?)
    ON CONFLICT(location_id,direction) DO UPDATE SET route_id=excluded.route_id,target_location=excluded.target_location
  `);
  const desiredRouteIds = new Set(seed.routes.map((route) => route.id));
  const previousSeedRoutes = db.prepare("SELECT rowid,id FROM routes WHERE seed_revision>0 AND seed_revision<?").all(WORLD_SEED_REVISION) as Array<{ rowid: number; id: string | null }>;
  const clearSlots = db.prepare("DELETE FROM location_direction_slots WHERE route_id=?");
  const deactivateRoute = db.prepare("UPDATE routes SET is_active=0 WHERE rowid=?");
  for (const route of previousSeedRoutes) {
    if (route.id) clearSlots.run(route.id);
    if (!route.id || !desiredRouteIds.has(route.id)) deactivateRoute.run(route.rowid);
  }
  for (const route of seed.routes) {
    routeInsert.run(
      route.fromLocation, route.toLocation, route.id, route.routeType, route.transitionKind,
      route.fromDirection, route.toDirection, WORLD_SEED_REVISION,
    );
    if (route.routeType === "normal" && route.fromDirection && route.toDirection) {
      slotInsert.run(route.fromLocation, route.fromDirection, route.id, route.toLocation);
      slotInsert.run(route.toLocation, route.toDirection, route.id, route.fromLocation);
    }
  }

  const actionInsert = db.prepare(`
    INSERT INTO action_definitions(
      id,location_id,name,description,stamina_delta,silver_delta,cultivation_delta,hp_delta,result_template
    ) VALUES (?,?,?,?,0,?,0,?,?)
    ON CONFLICT(id) DO UPDATE SET location_id=excluded.location_id,name=excluded.name,
      description=excluded.description,stamina_delta=0,silver_delta=excluded.silver_delta,
      cultivation_delta=0,hp_delta=excluded.hp_delta,result_template=excluded.result_template
  `);
  for (const action of seed.actions) {
    actionInsert.run(action.id, action.locationId, action.name, action.description, action.silverDelta, action.hpDelta, action.resultTemplate);
  }

  const effectInsert = db.prepare(`
    INSERT INTO location_effects(location_id,effect_type,multiplier) VALUES (?,'cultivation',?)
    ON CONFLICT(location_id,effect_type) DO UPDATE SET multiplier=excluded.multiplier
  `);
  for (const location of seed.locations) {
    if (location.trainingMultiplier) effectInsert.run(location.id, location.trainingMultiplier);
  }

  const sourceLinkInsert = db.prepare(`
    INSERT INTO location_sources(location_id,source_id,source_key) VALUES (?,?,?)
    ON CONFLICT(location_id,source_id) DO UPDATE SET source_key=excluded.source_key
  `);
  for (const location of seed.locations) sourceLinkInsert.run(location.id, location.sourceId, location.sourceKey);
  for (const link of seed.baseLocationSources) sourceLinkInsert.run(link.locationId, link.sourceId, link.sourceKey);

  return {
    revision: WORLD_SEED_REVISION,
    sources: seed.sources.length,
    layers: seed.layers.length,
    regions: seed.regions.length,
    locations: seed.locations.length,
    routes: seed.routes.length,
    actions: seed.actions.length,
  };
}

export function importWorldSeed(db: DatabaseSync) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const report = applyWorldSeed(db);
    db.exec("COMMIT");
    return report;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
