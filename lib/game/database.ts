import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applyWorldSeed } from "./world-seed";

export type GameDatabase = DatabaseSync;

export const MAP_SCHEMA_VERSION = 7;

export function openGameDatabase(databasePath = process.env.DATABASE_PATH ?? resolve("data/wuxia.db")) {
  if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  if (databasePath !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  migrate(db);
  seed(db);
  return db;
}

function hasColumn(db: GameDatabase, table: string, column: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return columns.some((item) => item.name === column);
}

function addColumn(db: GameDatabase, table: string, definition: string) {
  const column = definition.split(/\s+/, 1)[0];
  if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

function migrate(db: GameDatabase) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS world_state(
      id INTEGER PRIMARY KEY CHECK (id=1), era TEXT NOT NULL, seed TEXT NOT NULL,
      announcement TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS map_layers(
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL,
      parent_layer_id TEXT REFERENCES map_layers(id), version INTEGER NOT NULL DEFAULT 1,
      is_active INTEGER NOT NULL DEFAULT 1, seed_revision INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS map_regions(
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL,
      x INTEGER NOT NULL, y INTEGER NOT NULL, width INTEGER NOT NULL CHECK(width>0),
      height INTEGER NOT NULL CHECK(height>0), version INTEGER NOT NULL DEFAULT 1,
      is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS locations(
      id TEXT PRIMARY KEY, name TEXT NOT NULL, region TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL, x INTEGER NOT NULL, y INTEGER NOT NULL,
      region_id TEXT REFERENCES map_regions(id), grid_x INTEGER NOT NULL DEFAULT 0,
      grid_y INTEGER NOT NULL DEFAULT 0, chunk_x INTEGER NOT NULL DEFAULT 0,
      chunk_y INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1,
      is_active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS routes(
      from_location TEXT NOT NULL REFERENCES locations(id), to_location TEXT NOT NULL REFERENCES locations(id),
      stamina_cost INTEGER NOT NULL DEFAULT 0 CHECK(stamina_cost>=0), id TEXT,
      route_type TEXT NOT NULL DEFAULT 'normal', from_direction TEXT, to_direction TEXT,
      version INTEGER NOT NULL DEFAULT 1, is_active INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY(from_location,to_location), CHECK(from_location<>to_location)
    );
    CREATE TABLE IF NOT EXISTS location_direction_slots(
      location_id TEXT NOT NULL REFERENCES locations(id), direction TEXT NOT NULL,
      route_id TEXT NOT NULL, target_location TEXT NOT NULL REFERENCES locations(id),
      PRIMARY KEY(location_id,direction), UNIQUE(route_id,location_id)
    );
    CREATE TABLE IF NOT EXISTS action_definitions(
      id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id), name TEXT NOT NULL,
      description TEXT NOT NULL, stamina_delta INTEGER NOT NULL DEFAULT 0,
      silver_delta INTEGER NOT NULL DEFAULT 0, cultivation_delta INTEGER NOT NULL DEFAULT 0,
      hp_delta INTEGER NOT NULL DEFAULT 0, result_template TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS players(
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, title TEXT NOT NULL DEFAULT '初入世界',
      hp INTEGER NOT NULL DEFAULT 100, max_hp INTEGER NOT NULL DEFAULT 100,
      stamina INTEGER NOT NULL DEFAULT 80, max_stamina INTEGER NOT NULL DEFAULT 80,
      cultivation INTEGER NOT NULL DEFAULT 0, silver INTEGER NOT NULL DEFAULT 20,
      current_location TEXT NOT NULL REFERENCES locations(id), created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, last_seen_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS player_progression(
      player_id TEXT PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
      strength INTEGER NOT NULL DEFAULT 10, agility INTEGER NOT NULL DEFAULT 10,
      constitution INTEGER NOT NULL DEFAULT 10, root INTEGER NOT NULL DEFAULT 10,
      comprehension INTEGER NOT NULL DEFAULT 10, spirit INTEGER NOT NULL DEFAULT 10,
      unspent_points INTEGER NOT NULL DEFAULT 0, realm_index INTEGER NOT NULL DEFAULT 0,
      realm_level INTEGER NOT NULL DEFAULT 1, cultivation_progress INTEGER NOT NULL DEFAULT 0,
      endurance INTEGER NOT NULL DEFAULT 120, training_anchor_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cultivation_logs(
      id INTEGER PRIMARY KEY AUTOINCREMENT, player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, delta INTEGER NOT NULL, realm_index INTEGER NOT NULL,
      realm_level INTEGER NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS location_effects(
      location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
      effect_type TEXT NOT NULL, multiplier REAL NOT NULL DEFAULT 1,
      PRIMARY KEY(location_id,effect_type)
    );
    CREATE TABLE IF NOT EXISTS world_sources(
      id TEXT PRIMARY KEY, title TEXT NOT NULL, url TEXT NOT NULL, content_version TEXT NOT NULL,
      retrieved_at TEXT NOT NULL, notes TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS location_sources(
      location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL REFERENCES world_sources(id), source_key TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(location_id,source_id)
    );
    CREATE TABLE IF NOT EXISTS sessions(
      token_hash TEXT PRIMARY KEY, player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL, expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS player_visited_locations(
      player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
      first_visited_at TEXT NOT NULL, last_visited_at TEXT NOT NULL,
      PRIMARY KEY(player_id,location_id)
    );
    CREATE TABLE IF NOT EXISTS action_logs(
      id INTEGER PRIMARY KEY AUTOINCREMENT, player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, action_id TEXT REFERENCES action_definitions(id), from_location TEXT REFERENCES locations(id),
      to_location TEXT REFERENCES locations(id), result_text TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS world_events(
      id INTEGER PRIMARY KEY AUTOINCREMENT, player_id TEXT REFERENCES players(id) ON DELETE SET NULL,
      event_type TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chat_messages(
      id INTEGER PRIMARY KEY AUTOINCREMENT, player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      content TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS map_edit_sessions(
      id TEXT PRIMARY KEY, player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      state TEXT NOT NULL DEFAULT 'active', lease_expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS map_edit_locks(
      scope_key TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES map_edit_sessions(id) ON DELETE CASCADE,
      player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE, lease_expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS map_edit_operations(
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES map_edit_sessions(id) ON DELETE CASCADE,
      operation_type TEXT NOT NULL, forward_json TEXT NOT NULL, inverse_json TEXT NOT NULL,
      undone INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS action_templates(
      id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL,category TEXT NOT NULL,
      target_kind TEXT NOT NULL DEFAULT 'self',duration_seconds INTEGER NOT NULL DEFAULT 0 CHECK(duration_seconds>=0),
      requirements_json TEXT NOT NULL DEFAULT '{}',check_json TEXT NOT NULL DEFAULT '{}',
      costs_json TEXT NOT NULL DEFAULT '{}',outcomes_json TEXT NOT NULL DEFAULT '{}',result_template TEXT NOT NULL,
      adult INTEGER NOT NULL DEFAULT 0 CHECK(adult IN (0,1)),visibility TEXT NOT NULL DEFAULT 'public',
      cooldown_seconds INTEGER NOT NULL DEFAULT 0 CHECK(cooldown_seconds>=0),version INTEGER NOT NULL DEFAULT 1,
      is_active INTEGER NOT NULL DEFAULT 1,seed_revision INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS location_facilities(
      id TEXT PRIMARY KEY,location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
      facility_type TEXT NOT NULL,quality INTEGER NOT NULL DEFAULT 1 CHECK(quality BETWEEN 1 AND 5),
      capacity INTEGER NOT NULL DEFAULT 1 CHECK(capacity>0),config_json TEXT NOT NULL DEFAULT '{}',
      version INTEGER NOT NULL DEFAULT 1,is_active INTEGER NOT NULL DEFAULT 1,seed_revision INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(location_id,facility_type)
    );
    CREATE TABLE IF NOT EXISTS location_action_bindings(
      id TEXT PRIMARY KEY,location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
      action_template_id TEXT NOT NULL REFERENCES action_templates(id) ON DELETE CASCADE,
      facility_id TEXT REFERENCES location_facilities(id) ON DELETE SET NULL,priority INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,seed_revision INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(location_id,action_template_id)
    );
    CREATE TABLE IF NOT EXISTS action_jobs(
      id TEXT PRIMARY KEY,player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      action_template_id TEXT NOT NULL REFERENCES action_templates(id),binding_id TEXT REFERENCES location_action_bindings(id),
      target_player_id TEXT REFERENCES players(id) ON DELETE SET NULL,target_location_id TEXT REFERENCES locations(id),
      status TEXT NOT NULL,queue_position INTEGER NOT NULL DEFAULT 0,started_at TEXT,completes_at TEXT,
      reserved_json TEXT NOT NULL DEFAULT '{}',context_json TEXT NOT NULL DEFAULT '{}',result_text TEXT,
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS player_needs(
      player_id TEXT PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
      satiety REAL NOT NULL DEFAULT 100 CHECK(satiety BETWEEN 0 AND 100),
      hydration REAL NOT NULL DEFAULT 100 CHECK(hydration BETWEEN 0 AND 100),
      hygiene REAL NOT NULL DEFAULT 100 CHECK(hygiene BETWEEN 0 AND 100),
      fatigue REAL NOT NULL DEFAULT 0 CHECK(fatigue BETWEEN 0 AND 100),
      bladder REAL NOT NULL DEFAULT 0 CHECK(bladder BETWEEN 0 AND 100),updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS skill_definitions(
      id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,description TEXT NOT NULL,attribute_key TEXT NOT NULL,
      category TEXT NOT NULL,is_active INTEGER NOT NULL DEFAULT 1,seed_revision INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS player_skills(
      player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      skill_id TEXT NOT NULL REFERENCES skill_definitions(id),level INTEGER NOT NULL DEFAULT 0 CHECK(level BETWEEN 0 AND 100),
      experience INTEGER NOT NULL DEFAULT 0 CHECK(experience>=0),updated_at TEXT NOT NULL,
      PRIMARY KEY(player_id,skill_id)
    );
    CREATE TABLE IF NOT EXISTS loot_piles(
      id TEXT PRIMARY KEY,location_id TEXT NOT NULL REFERENCES locations(id),silver INTEGER NOT NULL DEFAULT 0 CHECK(silver>=0),
      source_player_id TEXT REFERENCES players(id) ON DELETE SET NULL,expires_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS item_definitions(
      id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL,category TEXT NOT NULL,
      stackable INTEGER NOT NULL DEFAULT 0 CHECK(stackable IN (0,1)),max_stack INTEGER NOT NULL DEFAULT 1 CHECK(max_stack>0),
      base_value INTEGER NOT NULL DEFAULT 0 CHECK(base_value>=0),max_durability INTEGER NOT NULL DEFAULT 0 CHECK(max_durability>=0),
      equipment_slot TEXT,tags_json TEXT NOT NULL DEFAULT '[]',effects_json TEXT NOT NULL DEFAULT '{}',
      version INTEGER NOT NULL DEFAULT 1,is_active INTEGER NOT NULL DEFAULT 1,seed_revision INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS item_instances(
      id TEXT PRIMARY KEY,definition_id TEXT NOT NULL REFERENCES item_definitions(id),
      owner_player_id TEXT REFERENCES players(id) ON DELETE CASCADE,loot_pile_id TEXT REFERENCES loot_piles(id) ON DELETE CASCADE,
      quantity INTEGER NOT NULL DEFAULT 1 CHECK(quantity>0),quality INTEGER NOT NULL DEFAULT 1 CHECK(quality BETWEEN 1 AND 5),
      durability INTEGER NOT NULL DEFAULT 0 CHECK(durability>=0),affixes_json TEXT NOT NULL DEFAULT '[]',
      bound INTEGER NOT NULL DEFAULT 0 CHECK(bound IN (0,1)),equipped_slot TEXT,locked_by_job_id TEXT REFERENCES action_jobs(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
      CHECK((owner_player_id IS NOT NULL) <> (loot_pile_id IS NOT NULL))
    );
    CREATE TABLE IF NOT EXISTS recipe_definitions(
      id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL,facility_type TEXT NOT NULL,
      skill_id TEXT REFERENCES skill_definitions(id),duration_seconds INTEGER NOT NULL CHECK(duration_seconds>0),
      difficulty INTEGER NOT NULL DEFAULT 50,inputs_json TEXT NOT NULL,outputs_json TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,is_active INTEGER NOT NULL DEFAULT 1,seed_revision INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS crop_definitions(
      id TEXT PRIMARY KEY,name TEXT NOT NULL,seed_item_id TEXT NOT NULL REFERENCES item_definitions(id),
      harvest_item_id TEXT NOT NULL REFERENCES item_definitions(id),growth_seconds INTEGER NOT NULL CHECK(growth_seconds>0),
      stages_json TEXT NOT NULL DEFAULT '[]',seed_revision INTEGER NOT NULL DEFAULT 0,is_active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS farm_plots(
      id TEXT PRIMARY KEY,facility_id TEXT NOT NULL REFERENCES location_facilities(id) ON DELETE CASCADE,
      owner_player_id TEXT REFERENCES players(id) ON DELETE SET NULL,crop_id TEXT REFERENCES crop_definitions(id),
      planted_at TEXT,matures_at TEXT,water REAL NOT NULL DEFAULT 100 CHECK(water BETWEEN 0 AND 100),
      fertility REAL NOT NULL DEFAULT 100 CHECK(fertility BETWEEN 0 AND 100),disease REAL NOT NULL DEFAULT 0 CHECK(disease BETWEEN 0 AND 100),
      state TEXT NOT NULL DEFAULT 'empty',version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS background_jobs(
      id TEXT PRIMARY KEY,job_type TEXT NOT NULL,owner_player_id TEXT REFERENCES players(id) ON DELETE SET NULL,
      location_id TEXT REFERENCES locations(id) ON DELETE CASCADE,status TEXT NOT NULL,completes_at TEXT NOT NULL,
      context_json TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS private_events(
      id INTEGER PRIMARY KEY AUTOINCREMENT,player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,content TEXT NOT NULL,created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS interaction_requests(
      id TEXT PRIMARY KEY,request_type TEXT NOT NULL,from_player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      to_player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,status TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',expires_at TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
      CHECK(from_player_id<>to_player_id)
    );
    CREATE TABLE IF NOT EXISTS player_relationships(
      id TEXT PRIMARY KEY,player_a_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      player_b_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,relation_type TEXT NOT NULL,status TEXT NOT NULL,
      role_a TEXT,role_b TEXT,affinity INTEGER NOT NULL DEFAULT 0,trust INTEGER NOT NULL DEFAULT 0,
      intimacy INTEGER NOT NULL DEFAULT 0,hostility INTEGER NOT NULL DEFAULT 0,requested_by TEXT REFERENCES players(id),
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL,CHECK(player_a_id<player_b_id),
      UNIQUE(player_a_id,player_b_id,relation_type)
    );
    CREATE TABLE IF NOT EXISTS player_blocks(
      player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      blocked_player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,created_at TEXT NOT NULL,
      PRIMARY KEY(player_id,blocked_player_id),CHECK(player_id<>blocked_player_id)
    );
    CREATE TABLE IF NOT EXISTS trade_sessions(
      id TEXT PRIMARY KEY,player_a_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      player_b_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,status TEXT NOT NULL,
      offer_a_json TEXT NOT NULL DEFAULT '{}',offer_b_json TEXT NOT NULL DEFAULT '{}',confirmed_a INTEGER NOT NULL DEFAULT 0,
      confirmed_b INTEGER NOT NULL DEFAULT 0,expires_at TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
      CHECK(player_a_id<>player_b_id)
    );
    CREATE TABLE IF NOT EXISTS combat_sessions(
      id TEXT PRIMARY KEY,location_id TEXT NOT NULL REFERENCES locations(id),attacker_id TEXT NOT NULL REFERENCES players(id),
      defender_id TEXT NOT NULL REFERENCES players(id),status TEXT NOT NULL,round INTEGER NOT NULL DEFAULT 1,
      acting_player_id TEXT REFERENCES players(id),turn_deadline TEXT,attacker_misses INTEGER NOT NULL DEFAULT 0,
      defender_misses INTEGER NOT NULL DEFAULT 0,winner_id TEXT REFERENCES players(id),loser_id TEXT REFERENCES players(id),
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL,ended_at TEXT,CHECK(attacker_id<>defender_id)
    );
    CREATE TABLE IF NOT EXISTS combat_turns(
      id INTEGER PRIMARY KEY AUTOINCREMENT,combat_id TEXT NOT NULL REFERENCES combat_sessions(id) ON DELETE CASCADE,
      round INTEGER NOT NULL,player_id TEXT NOT NULL REFERENCES players(id),choice TEXT NOT NULL,
      result_json TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS npc_profiles(
      player_id TEXT PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,stable_key TEXT NOT NULL UNIQUE,
      controller_mode TEXT NOT NULL DEFAULT 'utility',personality_json TEXT NOT NULL DEFAULT '{}',
      goals_json TEXT NOT NULL DEFAULT '[]',profession TEXT NOT NULL DEFAULT '游民',home_location_id TEXT REFERENCES locations(id),
      next_think_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_credentials(
      token_hash TEXT PRIMARY KEY,player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      label TEXT NOT NULL,created_at TEXT NOT NULL,expires_at TEXT,revoked_at TEXT
    );
  `);

  const previousVersion = (db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number | null } | undefined)?.version ?? 0;
  const now = new Date().toISOString();

  // SQLite rejects ALTER TABLE ADD COLUMN when a populated table combines a
  // non-null default with REFERENCES. The application validates these layer IDs
  // and fresh databases still get the same indexed storage shape.
  addColumn(db, "map_regions", "layer_id TEXT NOT NULL DEFAULT 'world-root'");
  addColumn(db, "map_regions", "seed_revision INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "locations", "region_id TEXT REFERENCES map_regions(id)");
  addColumn(db, "locations", "layer_id TEXT NOT NULL DEFAULT 'world-root'");
  addColumn(db, "locations", "grid_x INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "locations", "grid_y INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "locations", "chunk_x INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "locations", "chunk_y INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "locations", "version INTEGER NOT NULL DEFAULT 1");
  addColumn(db, "locations", "is_active INTEGER NOT NULL DEFAULT 1");
  addColumn(db, "locations", "seed_revision INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "routes", "id TEXT");
  addColumn(db, "routes", "route_type TEXT NOT NULL DEFAULT 'normal'");
  addColumn(db, "routes", "transition_kind TEXT");
  addColumn(db, "routes", "from_direction TEXT");
  addColumn(db, "routes", "to_direction TEXT");
  addColumn(db, "routes", "version INTEGER NOT NULL DEFAULT 1");
  addColumn(db, "routes", "is_active INTEGER NOT NULL DEFAULT 1");
  addColumn(db, "routes", "seed_revision INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "players", "controller_kind TEXT NOT NULL DEFAULT 'human'");
  addColumn(db, "players", "adult_status TEXT NOT NULL DEFAULT 'unknown'");
  addColumn(db, "players", "adult_content_enabled INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "players", "injury_until TEXT");
  addColumn(db, "players", "vision_bonus_until TEXT");
  addColumn(db, "players", "vision_depth_bonus INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "action_logs", "action_template_id TEXT REFERENCES action_templates(id)");
  addColumn(db, "action_logs", "action_job_id TEXT REFERENCES action_jobs(id)");

  if (previousVersion < 2) db.exec("UPDATE routes SET is_active=0; UPDATE locations SET is_active=0;");
  if (previousVersion < 3) {
    db.prepare("UPDATE map_regions SET x=400,y=40,width=160,height=180,updated_at=? WHERE id='home' AND version=1").run(now);
  }
  if (previousVersion < 4) {
    db.exec(`
      UPDATE locations SET layer_id='home-ground' WHERE id='home-entrance';
      UPDATE locations SET layer_id='world-root' WHERE id IN ('loumen-road','song-gate','palos-gate');
      UPDATE map_regions SET layer_id='home-ground' WHERE id='home';
      UPDATE map_regions SET layer_id='world-root' WHERE id IN ('song','palos');
      UPDATE routes SET route_type='transition',transition_kind='door',stamina_cost=0,
        from_direction=NULL,to_direction=NULL WHERE id='route-entrance-road';
      DELETE FROM location_direction_slots WHERE route_id='route-entrance-road';
      UPDATE routes SET stamina_cost=0;
      UPDATE action_definitions SET stamina_delta=0,cultivation_delta=0;
    `);
    db.prepare(`
      INSERT OR IGNORE INTO player_progression(
        player_id,strength,agility,constitution,root,comprehension,spirit,
        unspent_points,realm_index,realm_level,cultivation_progress,endurance,updated_at
      ) SELECT id,10,10,10,10,10,10,0,0,1,MAX(0,cultivation),120,? FROM players
    `).run(now);
  }
  if (previousVersion < 5) {
    // A table rebuild is required because SQLite cannot drop the inline UNIQUE
    // constraint that older schemas placed on locations.name. Foreign keys must
    // be disabled outside the replacement transaction so dependent game data is
    // preserved while the table keeps the same name and primary key.
    db.exec("PRAGMA foreign_keys = OFF");
    try {
      db.exec(`
        BEGIN IMMEDIATE;
        DROP TABLE IF EXISTS locations_v5;
        CREATE TABLE locations_v5(
          id TEXT PRIMARY KEY, name TEXT NOT NULL, region TEXT NOT NULL DEFAULT '',
          description TEXT NOT NULL, x INTEGER NOT NULL, y INTEGER NOT NULL,
          region_id TEXT REFERENCES map_regions(id), grid_x INTEGER NOT NULL DEFAULT 0,
          grid_y INTEGER NOT NULL DEFAULT 0, chunk_x INTEGER NOT NULL DEFAULT 0,
          chunk_y INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1,
          is_active INTEGER NOT NULL DEFAULT 1,
          layer_id TEXT NOT NULL DEFAULT 'world-root', seed_revision INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO locations_v5(
          id,name,region,description,x,y,region_id,grid_x,grid_y,chunk_x,chunk_y,
          version,is_active,layer_id,seed_revision
        )
        SELECT id,name,region,description,x,y,region_id,grid_x,grid_y,chunk_x,chunk_y,
          version,is_active,layer_id,seed_revision FROM locations;
        DROP TABLE locations;
        ALTER TABLE locations_v5 RENAME TO locations;
        COMMIT;
      `);
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // The multi-statement migration may have failed before BEGIN.
      }
      throw error;
    } finally {
      db.exec("PRAGMA foreign_keys = ON");
    }
  }
  if (previousVersion < 6) {
    db.exec(`
      INSERT OR IGNORE INTO player_visited_locations(player_id,location_id,first_visited_at,last_visited_at)
      SELECT player_id,location_id,MIN(created_at),MAX(created_at)
      FROM (
        SELECT player_id,from_location AS location_id,created_at FROM action_logs
          WHERE kind='move' AND from_location IS NOT NULL
        UNION ALL
        SELECT player_id,to_location AS location_id,created_at FROM action_logs
          WHERE kind='move' AND to_location IS NOT NULL
      )
      GROUP BY player_id,location_id;

      INSERT OR IGNORE INTO player_visited_locations(player_id,location_id,first_visited_at,last_visited_at)
      SELECT id,current_location,created_at,created_at FROM players;
    `);
  }
  if (previousVersion < 7) {
    db.prepare(`
      INSERT OR IGNORE INTO player_needs(player_id,updated_at)
      SELECT id,? FROM players
    `).run(now);
    db.prepare(`
      INSERT OR IGNORE INTO action_templates(
        id,name,description,category,target_kind,duration_seconds,requirements_json,check_json,
        costs_json,outcomes_json,result_template,adult,visibility,cooldown_seconds,version,is_active,seed_revision,created_at,updated_at
      )
      SELECT id,name,description,'legacy','self',0,'{}','{}','{}',
        printf('{"success":{"silverDelta":%d,"hpDelta":%d}}',silver_delta,hp_delta),
        result_template,0,'public',0,1,1,0,?,? FROM action_definitions
    `).run(now, now);
    db.prepare(`
      INSERT OR IGNORE INTO location_action_bindings(
        id,location_id,action_template_id,priority,is_active,seed_revision,created_at,updated_at
      ) SELECT 'action-binding-'||id,location_id,id,0,1,0,?,? FROM action_definitions
    `).run(now, now);
    db.exec(`
      UPDATE action_logs SET action_template_id=action_id
      WHERE action_id IS NOT NULL AND action_template_id IS NULL;
    `);
  }

  db.exec(`
    DROP INDEX IF EXISTS idx_active_grid;
    CREATE INDEX IF NOT EXISTS idx_sessions_player ON sessions(player_id);
    CREATE INDEX IF NOT EXISTS idx_events_created ON world_events(created_at DESC,id DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_created ON chat_messages(created_at DESC,id DESC);
    CREATE INDEX IF NOT EXISTS idx_logs_player_created ON action_logs(player_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_locations_chunk ON locations(layer_id,chunk_x,chunk_y,is_active);
    CREATE INDEX IF NOT EXISTS idx_locations_viewport ON locations(layer_id,is_active,chunk_x,chunk_y,id);
    CREATE INDEX IF NOT EXISTS idx_locations_region ON locations(region_id,is_active);
    CREATE INDEX IF NOT EXISTS idx_locations_layer ON locations(layer_id,is_active);
    CREATE INDEX IF NOT EXISTS idx_regions_layer ON map_regions(layer_id,is_active);
    CREATE INDEX IF NOT EXISTS idx_routes_from ON routes(from_location,is_active);
    CREATE INDEX IF NOT EXISTS idx_routes_to ON routes(to_location,is_active);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_routes_id ON routes(id) WHERE id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_active_grid ON locations(layer_id,grid_x,grid_y) WHERE is_active=1;
    CREATE INDEX IF NOT EXISTS idx_locks_session ON map_edit_locks(session_id);
    CREATE INDEX IF NOT EXISTS idx_operations_session ON map_edit_operations(session_id,id DESC);
    CREATE INDEX IF NOT EXISTS idx_visited_location ON player_visited_locations(location_id,player_id);
    CREATE INDEX IF NOT EXISTS idx_action_bindings_location ON location_action_bindings(location_id,is_active,priority);
    CREATE INDEX IF NOT EXISTS idx_action_jobs_player ON action_jobs(player_id,status,queue_position);
    CREATE INDEX IF NOT EXISTS idx_action_jobs_completion ON action_jobs(status,completes_at);
    CREATE INDEX IF NOT EXISTS idx_items_owner ON item_instances(owner_player_id,equipped_slot,definition_id);
    CREATE INDEX IF NOT EXISTS idx_items_loot ON item_instances(loot_pile_id,definition_id);
    CREATE INDEX IF NOT EXISTS idx_background_jobs_completion ON background_jobs(status,completes_at);
    CREATE INDEX IF NOT EXISTS idx_interactions_target ON interaction_requests(to_player_id,status,expires_at);
    CREATE INDEX IF NOT EXISTS idx_relationships_a ON player_relationships(player_a_id,status);
    CREATE INDEX IF NOT EXISTS idx_relationships_b ON player_relationships(player_b_id,status);
    CREATE INDEX IF NOT EXISTS idx_combat_participants ON combat_sessions(attacker_id,defender_id,status);
    CREATE INDEX IF NOT EXISTS idx_private_events_player ON private_events(player_id,id DESC);
    CREATE INDEX IF NOT EXISTS idx_npc_think ON npc_profiles(next_think_at,player_id);
  `);
  db.prepare("INSERT OR REPLACE INTO schema_migrations(version,applied_at) VALUES (?,?)").run(MAP_SCHEMA_VERSION, now);
}

function seed(db: GameDatabase) {
  inTransaction(db, () => {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO world_state(id,era,seed,announcement,updated_at)
      VALUES (1,'北宋大观四年与帕洛斯世界','path-of-wuxia-world-v5','单层住宅之外是一张连续地理大地图：楼门路向西接入北宋二十四路舆图，向东接入帕洛斯群岛坐标图。',?)
      ON CONFLICT(id) DO UPDATE SET era=excluded.era,seed=excluded.seed,announcement=excluded.announcement,updated_at=excluded.updated_at
    `).run(now);

    applyWorldSeed(db);

    db.prepare(`
      INSERT OR IGNORE INTO player_progression(player_id,cultivation_progress,endurance,updated_at)
      SELECT id,MAX(0,cultivation),120,? FROM players
    `).run(now);
    db.prepare(`UPDATE players SET current_location='home-entrance',updated_at=? WHERE current_location NOT IN (SELECT id FROM locations WHERE is_active=1)`).run(now);
    db.prepare(`
      INSERT OR IGNORE INTO player_visited_locations(player_id,location_id,first_visited_at,last_visited_at)
      SELECT id,current_location,created_at,updated_at FROM players
    `).run();
    const eventCount = db.prepare("SELECT COUNT(*) AS count FROM world_events").get() as { count: number };
    if (eventCount.count === 0) {
      db.prepare(`INSERT INTO world_events(player_id,event_type,content,created_at) VALUES (NULL,'system','玄关的门被轻轻推开，新的世界由此展开。',?)`).run(now);
    }
  });
}

export function inTransaction<T>(db: GameDatabase, operation: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

declare global {
  var __wuxiaDatabase: { path: string; db: GameDatabase } | undefined;
}

export function getGameDatabase() {
  const databasePath = process.env.DATABASE_PATH ?? resolve("data/wuxia.db");
  if (!globalThis.__wuxiaDatabase || globalThis.__wuxiaDatabase.path !== databasePath) {
    globalThis.__wuxiaDatabase?.db.close();
    globalThis.__wuxiaDatabase = { path: databasePath, db: openGameDatabase(databasePath) };
  }
  return globalThis.__wuxiaDatabase.db;
}

export function closeGameDatabase() {
  if (!globalThis.__wuxiaDatabase) return;
  globalThis.__wuxiaDatabase.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  globalThis.__wuxiaDatabase.db.close();
  globalThis.__wuxiaDatabase = undefined;
}
