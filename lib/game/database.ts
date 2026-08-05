import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applyWorldSeed } from "./world-seed";
import { ensureNpcPopulation } from "./npc-seed";
import { seedNpcCity } from "./npc-catalog";

export type GameDatabase = DatabaseSync;

export const MAP_SCHEMA_VERSION = 16;

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

export function openReadOnlyGameDatabase(databasePath = process.env.DATABASE_PATH ?? resolve("data/wuxia.db")) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA query_only = ON");
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

function migrateCurrencyOutcome(value: string) {
  const parsed = JSON.parse(value) as Record<string, unknown>;
  const migrate = (outcome: Record<string, unknown>) => {
    if (typeof outcome.silverDelta === "number" && outcome.cashWenDelta === undefined) {
      outcome.cashWenDelta = Math.trunc(outcome.silverDelta * 1_000);
    }
    delete outcome.silverDelta;
  };
  if (parsed.success && typeof parsed.success === "object" && !Array.isArray(parsed.success)) migrate(parsed.success as Record<string, unknown>);
  if (parsed.failure && typeof parsed.failure === "object" && !Array.isArray(parsed.failure)) migrate(parsed.failure as Record<string, unknown>);
  migrate(parsed);
  return JSON.stringify(parsed);
}

function migrateStoredTradeOffer(value: string) {
  const parsed = JSON.parse(value) as Record<string, unknown>;
  if (typeof parsed.silver === "number" && parsed.cashWen === undefined) parsed.cashWen = Math.max(0, Math.trunc(parsed.silver * 1_000));
  delete parsed.silver;
  return JSON.stringify(parsed);
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
      hp_delta INTEGER NOT NULL DEFAULT 0, result_template TEXT NOT NULL,
      cash_wen_delta INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS players(
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, title TEXT NOT NULL DEFAULT '初入世界',
      hp INTEGER NOT NULL DEFAULT 100, max_hp INTEGER NOT NULL DEFAULT 100,
      stamina INTEGER NOT NULL DEFAULT 80, max_stamina INTEGER NOT NULL DEFAULT 80,
      cultivation INTEGER NOT NULL DEFAULT 0, silver INTEGER NOT NULL DEFAULT 20,
      current_location TEXT NOT NULL REFERENCES locations(id), created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
      editor_role TEXT NOT NULL DEFAULT 'player' CHECK(editor_role IN ('player','editor','admin'))
    );
    CREATE TABLE IF NOT EXISTS player_wallets(
      player_id TEXT PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
      cash_wen INTEGER NOT NULL DEFAULT 0 CHECK(cash_wen>=0),updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS player_starter_grants(
      player_id TEXT PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,granted_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS currency_ledger(
      id TEXT PRIMARY KEY,player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      delta_wen INTEGER NOT NULL,balance_after_wen INTEGER NOT NULL CHECK(balance_after_wen>=0),
      reason TEXT NOT NULL,reference_type TEXT,reference_id TEXT,created_at TEXT NOT NULL
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
    CREATE TABLE IF NOT EXISTS external_identities(
      provider TEXT NOT NULL,subject TEXT NOT NULL,player_id TEXT NOT NULL UNIQUE REFERENCES players(id) ON DELETE CASCADE,
      editor_role TEXT NOT NULL DEFAULT 'player' CHECK(editor_role IN ('player','editor','admin')),
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(provider,subject)
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
      duration_seconds INTEGER NOT NULL DEFAULT 0 CHECK(duration_seconds>=0),rule_version INTEGER NOT NULL DEFAULT 1,
      rule_snapshot_json TEXT NOT NULL DEFAULT '{}',
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
      category TEXT NOT NULL,skill_kind TEXT NOT NULL DEFAULT 'passive',
      is_active INTEGER NOT NULL DEFAULT 1,seed_revision INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS player_skills(
      player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      skill_id TEXT NOT NULL REFERENCES skill_definitions(id),level INTEGER NOT NULL DEFAULT 0 CHECK(level BETWEEN 0 AND 100),
      experience INTEGER NOT NULL DEFAULT 0 CHECK(experience>=0),updated_at TEXT NOT NULL,
      PRIMARY KEY(player_id,skill_id)
    );
    CREATE TABLE IF NOT EXISTS player_action_cooldowns(
      player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      action_template_id TEXT NOT NULL REFERENCES action_templates(id) ON DELETE CASCADE,
      available_at TEXT NOT NULL,updated_at TEXT NOT NULL,
      PRIMARY KEY(player_id,action_template_id)
    );
    CREATE TABLE IF NOT EXISTS player_active_skills(
      player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      skill_id TEXT NOT NULL REFERENCES skill_definitions(id),
      action_template_id TEXT NOT NULL REFERENCES action_templates(id),
      started_at TEXT NOT NULL,expires_at TEXT NOT NULL,updated_at TEXT NOT NULL,
      PRIMARY KEY(player_id,skill_id)
    );
    CREATE TABLE IF NOT EXISTS loot_piles(
      id TEXT PRIMARY KEY,location_id TEXT NOT NULL REFERENCES locations(id),silver INTEGER NOT NULL DEFAULT 0 CHECK(silver>=0),
      source_player_id TEXT REFERENCES players(id) ON DELETE SET NULL,expires_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
      cash_wen INTEGER NOT NULL DEFAULT 0 CHECK(cash_wen>=0)
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
    CREATE TABLE IF NOT EXISTS item_reservations(
      job_id TEXT NOT NULL REFERENCES action_jobs(id) ON DELETE CASCADE,
      item_instance_id TEXT NOT NULL REFERENCES item_instances(id) ON DELETE CASCADE,
      quantity INTEGER NOT NULL CHECK(quantity>0),PRIMARY KEY(job_id,item_instance_id)
    );
    CREATE TABLE IF NOT EXISTS shops(
      id TEXT PRIMARY KEY,location_id TEXT NOT NULL UNIQUE REFERENCES locations(id),name TEXT NOT NULL,
      category TEXT NOT NULL,opens_minute INTEGER NOT NULL CHECK(opens_minute BETWEEN 0 AND 1440),
      closes_minute INTEGER NOT NULL CHECK(closes_minute BETWEEN 0 AND 1440),
      till_wen INTEGER NOT NULL DEFAULT 0 CHECK(till_wen>=0),is_active INTEGER NOT NULL DEFAULT 1,
      seed_revision INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS shop_service_locations(
      shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
      PRIMARY KEY(shop_id,location_id),UNIQUE(location_id)
    );
    CREATE TABLE IF NOT EXISTS shop_stock(
      shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      item_definition_id TEXT NOT NULL REFERENCES item_definitions(id),quantity INTEGER NOT NULL CHECK(quantity>=0),
      buy_price_wen INTEGER NOT NULL CHECK(buy_price_wen>0),sell_price_wen INTEGER NOT NULL CHECK(sell_price_wen>0),
      updated_at TEXT NOT NULL,PRIMARY KEY(shop_id,item_definition_id)
    );
    CREATE TABLE IF NOT EXISTS shop_transactions(
      id TEXT PRIMARY KEY,request_id TEXT NOT NULL,shop_id TEXT NOT NULL REFERENCES shops(id),player_id TEXT NOT NULL REFERENCES players(id),
      side TEXT NOT NULL CHECK(side IN ('buy','sell')),item_definition_id TEXT NOT NULL REFERENCES item_definitions(id),
      quantity INTEGER NOT NULL CHECK(quantity>0),unit_price_wen INTEGER NOT NULL CHECK(unit_price_wen>0),
      total_wen INTEGER NOT NULL CHECK(total_wen>0),payload_hash TEXT NOT NULL,created_at TEXT NOT NULL,
      UNIQUE(player_id,request_id)
    );
    CREATE TABLE IF NOT EXISTS market_underlyings(
      id TEXT PRIMARY KEY,name TEXT NOT NULL,unit TEXT NOT NULL,spot_price_wen INTEGER NOT NULL CHECK(spot_price_wen>0),
      previous_spot_price_wen INTEGER NOT NULL CHECK(previous_spot_price_wen>0),updated_minute TEXT NOT NULL,updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS market_contracts(
      id TEXT PRIMARY KEY,underlying_id TEXT NOT NULL REFERENCES market_underlyings(id),name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('spot','future','call','put')),expiry_at TEXT,horizon_days INTEGER,
      strike_wen INTEGER CHECK(strike_wen IS NULL OR strike_wen>0),multiplier INTEGER NOT NULL DEFAULT 1 CHECK(multiplier>0),
      mark_price_wen INTEGER NOT NULL CHECK(mark_price_wen>=0),status TEXT NOT NULL DEFAULT 'active',created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS market_accounts(
      player_id TEXT PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,reserved_margin_wen INTEGER NOT NULL DEFAULT 0 CHECK(reserved_margin_wen>=0),
      maintenance_margin_wen INTEGER NOT NULL DEFAULT 0 CHECK(maintenance_margin_wen>=0),
      clearing_debt_wen INTEGER NOT NULL DEFAULT 0 CHECK(clearing_debt_wen>=0),updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS market_orders(
      id TEXT PRIMARY KEY,request_id TEXT NOT NULL,player_id TEXT REFERENCES players(id) ON DELETE CASCADE,
      owner_kind TEXT NOT NULL CHECK(owner_kind IN ('player','guild')),contract_id TEXT NOT NULL REFERENCES market_contracts(id),
      side TEXT NOT NULL CHECK(side IN ('buy','sell')),limit_price_wen INTEGER NOT NULL CHECK(limit_price_wen>0),
      quantity INTEGER NOT NULL CHECK(quantity>0),remaining_quantity INTEGER NOT NULL CHECK(remaining_quantity>=0),
      status TEXT NOT NULL,payload_hash TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
      UNIQUE(player_id,request_id)
    );
    CREATE TABLE IF NOT EXISTS market_trades(
      id INTEGER PRIMARY KEY AUTOINCREMENT,contract_id TEXT NOT NULL REFERENCES market_contracts(id),
      buy_order_id TEXT NOT NULL REFERENCES market_orders(id),sell_order_id TEXT NOT NULL REFERENCES market_orders(id),
      buyer_player_id TEXT REFERENCES players(id),seller_player_id TEXT REFERENCES players(id),
      price_wen INTEGER NOT NULL CHECK(price_wen>0),quantity INTEGER NOT NULL CHECK(quantity>0),created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS market_positions(
      player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,contract_id TEXT NOT NULL REFERENCES market_contracts(id),
      quantity INTEGER NOT NULL DEFAULT 0,average_price_wen INTEGER NOT NULL DEFAULT 0 CHECK(average_price_wen>=0),
      last_mark_price_wen INTEGER NOT NULL DEFAULT 0 CHECK(last_mark_price_wen>=0),updated_at TEXT NOT NULL,
      PRIMARY KEY(player_id,contract_id)
    );
    CREATE TABLE IF NOT EXISTS market_ticks(
      id INTEGER PRIMARY KEY AUTOINCREMENT,minute_key TEXT NOT NULL,underlying_id TEXT NOT NULL REFERENCES market_underlyings(id),
      spot_price_wen INTEGER NOT NULL CHECK(spot_price_wen>0),created_at TEXT NOT NULL,UNIQUE(minute_key,underlying_id)
    );
    CREATE TABLE IF NOT EXISTS market_liquidations(
      id TEXT PRIMARY KEY,player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      contract_id TEXT NOT NULL REFERENCES market_contracts(id),quantity INTEGER NOT NULL,price_wen INTEGER NOT NULL,
      reason TEXT NOT NULL,created_at TEXT NOT NULL
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
      label TEXT NOT NULL,scope TEXT NOT NULL DEFAULT 'gameplay' CHECK(scope IN ('gameplay','market-trade')),
      created_at TEXT NOT NULL,expires_at TEXT,revoked_at TEXT
    );
    CREATE TABLE IF NOT EXISTS npc_assignments(
      player_id TEXT PRIMARY KEY REFERENCES npc_profiles(player_id) ON DELETE CASCADE,
      cohort TEXT NOT NULL,occupation_key TEXT NOT NULL,occupation_name TEXT NOT NULL,
      workplace_location_id TEXT NOT NULL REFERENCES locations(id),home_location_id TEXT NOT NULL REFERENCES locations(id),
      shop_id TEXT REFERENCES shops(id),public_biography TEXT NOT NULL,seed_revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS npc_routes(
      id TEXT PRIMARY KEY,name TEXT NOT NULL,loop INTEGER NOT NULL DEFAULT 1 CHECK(loop IN (0,1)),
      seed_revision INTEGER NOT NULL,is_active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS npc_route_stops(
      route_id TEXT NOT NULL REFERENCES npc_routes(id) ON DELETE CASCADE,sequence INTEGER NOT NULL,
      location_id TEXT NOT NULL REFERENCES locations(id),dwell_minutes INTEGER NOT NULL DEFAULT 15 CHECK(dwell_minutes>0),
      PRIMARY KEY(route_id,sequence)
    );
    CREATE TABLE IF NOT EXISTS npc_schedule_entries(
      id TEXT PRIMARY KEY,player_id TEXT NOT NULL REFERENCES npc_profiles(player_id) ON DELETE CASCADE,
      weekday_mask INTEGER NOT NULL DEFAULT 127 CHECK(weekday_mask BETWEEN 1 AND 127),
      start_minute INTEGER NOT NULL CHECK(start_minute BETWEEN 0 AND 1439),end_minute INTEGER NOT NULL CHECK(end_minute BETWEEN 1 AND 1440),
      activity_kind TEXT NOT NULL,target_kind TEXT NOT NULL CHECK(target_kind IN ('home','workplace','fixed','route')),
      target_location_id TEXT REFERENCES locations(id),route_id TEXT REFERENCES npc_routes(id),seed_revision INTEGER NOT NULL,
      CHECK(start_minute<end_minute)
    );
    CREATE TABLE IF NOT EXISTS npc_dialogue_topics(
      id TEXT PRIMARY KEY,title TEXT NOT NULL,player_prompt TEXT NOT NULL,reply_template TEXT NOT NULL,
      minimum_standing INTEGER NOT NULL DEFAULT -100,standing_delta INTEGER NOT NULL DEFAULT 0,
      seed_revision INTEGER NOT NULL,is_active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS npc_dialogue_assignments(
      player_id TEXT NOT NULL REFERENCES npc_profiles(player_id) ON DELETE CASCADE,
      topic_id TEXT NOT NULL REFERENCES npc_dialogue_topics(id) ON DELETE CASCADE,PRIMARY KEY(player_id,topic_id)
    );
    CREATE TABLE IF NOT EXISTS npc_dialogue_history(
      id TEXT PRIMARY KEY,player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      npc_id TEXT NOT NULL REFERENCES npc_profiles(player_id) ON DELETE CASCADE,topic_id TEXT NOT NULL REFERENCES npc_dialogue_topics(id),
      reply_text TEXT NOT NULL,created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS player_npc_standings(
      player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,npc_id TEXT NOT NULL REFERENCES npc_profiles(player_id) ON DELETE CASCADE,
      standing INTEGER NOT NULL DEFAULT 0 CHECK(standing BETWEEN -100 AND 100),updated_at TEXT NOT NULL,PRIMARY KEY(player_id,npc_id)
    );
    CREATE TABLE IF NOT EXISTS npc_standing_events(
      id TEXT PRIMARY KEY,player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      npc_id TEXT NOT NULL REFERENCES npc_profiles(player_id) ON DELETE CASCADE,delta INTEGER NOT NULL,
      standing_after INTEGER NOT NULL CHECK(standing_after BETWEEN -100 AND 100),reason TEXT NOT NULL,
      reference_id TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(player_id,npc_id,reason,reference_id)
    );
    CREATE TABLE IF NOT EXISTS npc_commission_templates(
      id TEXT PRIMARY KEY,title TEXT NOT NULL,description TEXT NOT NULL,
      objective_kind TEXT NOT NULL CHECK(objective_kind IN ('visit','action','deliver')),objective_json TEXT NOT NULL,
      reward_wen INTEGER NOT NULL CHECK(reward_wen>=0),standing_reward INTEGER NOT NULL CHECK(standing_reward>=0),
      duration_seconds INTEGER NOT NULL CHECK(duration_seconds>0),repeat_cooldown_seconds INTEGER NOT NULL DEFAULT 86400,
      seed_revision INTEGER NOT NULL,is_active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS npc_commission_offers(
      npc_id TEXT NOT NULL REFERENCES npc_profiles(player_id) ON DELETE CASCADE,
      template_id TEXT NOT NULL REFERENCES npc_commission_templates(id),PRIMARY KEY(npc_id,template_id)
    );
    CREATE TABLE IF NOT EXISTS player_commissions(
      id TEXT PRIMARY KEY,player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      npc_id TEXT NOT NULL REFERENCES npc_profiles(player_id),template_id TEXT NOT NULL REFERENCES npc_commission_templates(id),
      status TEXT NOT NULL CHECK(status IN ('active','completed','expired','abandoned')),
      objective_json TEXT NOT NULL,reward_wen INTEGER NOT NULL,standing_reward INTEGER NOT NULL,
      accept_request_id TEXT NOT NULL,completion_request_id TEXT,accepted_at TEXT NOT NULL,due_at TEXT NOT NULL,
      completed_at TEXT,updated_at TEXT NOT NULL,UNIQUE(player_id,accept_request_id),UNIQUE(player_id,completion_request_id)
    );
    CREATE TABLE IF NOT EXISTS npc_relationships(
      npc_a_id TEXT NOT NULL REFERENCES npc_profiles(player_id) ON DELETE CASCADE,
      npc_b_id TEXT NOT NULL REFERENCES npc_profiles(player_id) ON DELETE CASCADE,
      relationship_kind TEXT NOT NULL,public_note TEXT NOT NULL,seed_revision INTEGER NOT NULL,
      PRIMARY KEY(npc_a_id,npc_b_id,relationship_kind),CHECK(npc_a_id<npc_b_id)
    );
    CREATE TABLE IF NOT EXISTS market_order_cancellations(
      id TEXT PRIMARY KEY,player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL,order_id TEXT NOT NULL REFERENCES market_orders(id),payload_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,UNIQUE(player_id,request_id)
    );
    CREATE TABLE IF NOT EXISTS market_account_ledger(
      id TEXT PRIMARY KEY,player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,delta_debt_wen INTEGER NOT NULL,debt_after_wen INTEGER NOT NULL CHECK(debt_after_wen>=0),
      reference_type TEXT NOT NULL,reference_id TEXT NOT NULL,created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS npc_trade_strategies(
      id TEXT PRIMARY KEY,player_id TEXT NOT NULL REFERENCES npc_profiles(player_id) ON DELETE CASCADE,
      version INTEGER NOT NULL CHECK(version>0),schema_version INTEGER NOT NULL DEFAULT 1,
      source TEXT NOT NULL CHECK(source IN ('builtin','http')),strategy_json TEXT NOT NULL,
      strategy_hash TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
      created_at TEXT NOT NULL,retired_at TEXT,UNIQUE(player_id,version)
    );
    CREATE TABLE IF NOT EXISTS npc_trade_decisions(
      id TEXT PRIMARY KEY,player_id TEXT NOT NULL REFERENCES npc_profiles(player_id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL CHECK(sequence>0),cycle_key TEXT NOT NULL,
      strategy_id TEXT NOT NULL REFERENCES npc_trade_strategies(id),strategy_hash TEXT NOT NULL,
      input_snapshot_json TEXT NOT NULL,input_snapshot_hash TEXT NOT NULL,rng_seed TEXT NOT NULL,
      output_json TEXT,output_hash TEXT,request_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK(status IN ('pending','ready','executed','skipped','rejected')),
      error_text TEXT,created_at TEXT NOT NULL,decided_at TEXT,executed_at TEXT,
      UNIQUE(player_id,sequence),UNIQUE(player_id,cycle_key)
    );
    CREATE TABLE IF NOT EXISTS player_law_state(
      player_id TEXT PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
      wanted_points INTEGER NOT NULL DEFAULT 0 CHECK(wanted_points BETWEEN 0 AND 9999),
      decay_anchor_at TEXT NOT NULL,last_crime_at TEXT,updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS law_incidents(
      id TEXT PRIMARY KEY,actor_player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      victim_player_id TEXT REFERENCES players(id) ON DELETE SET NULL,
      offense TEXT NOT NULL CHECK(offense IN ('assault','defeat','robbery')),
      points_delta INTEGER NOT NULL CHECK(points_delta>0),location_id TEXT NOT NULL REFERENCES locations(id),
      reference_type TEXT NOT NULL CHECK(reference_type IN ('combat','loot')),reference_id TEXT NOT NULL,
      created_at TEXT NOT NULL,UNIQUE(actor_player_id,offense,reference_type,reference_id)
    );
    CREATE TABLE IF NOT EXISTS law_settlements(
      id TEXT PRIMARY KEY,player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL,wanted_points_cleared INTEGER NOT NULL CHECK(wanted_points_cleared>0),
      fine_wen INTEGER NOT NULL CHECK(fine_wen>0),location_id TEXT NOT NULL REFERENCES locations(id),
      created_at TEXT NOT NULL,UNIQUE(player_id,request_id)
    );
    CREATE TABLE IF NOT EXISTS npc_respawn_jobs(
      id TEXT PRIMARY KEY,npc_player_id TEXT NOT NULL REFERENCES npc_profiles(player_id) ON DELETE CASCADE,
      combat_id TEXT NOT NULL REFERENCES combat_sessions(id),destination_location_id TEXT NOT NULL REFERENCES locations(id),
      due_at TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('scheduled','completed','cancelled')),
      created_at TEXT NOT NULL,completed_at TEXT,UNIQUE(npc_player_id,combat_id)
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
  addColumn(db, "players", "editor_role TEXT NOT NULL DEFAULT 'player'");
  addColumn(db, "players", "adult_status TEXT NOT NULL DEFAULT 'unknown'");
  addColumn(db, "players", "adult_content_enabled INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "players", "injury_until TEXT");
  addColumn(db, "players", "vision_bonus_until TEXT");
  addColumn(db, "players", "vision_depth_bonus INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "action_logs", "action_template_id TEXT REFERENCES action_templates(id)");
  addColumn(db, "action_logs", "action_job_id TEXT REFERENCES action_jobs(id)");
  addColumn(db, "action_jobs", "duration_seconds INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "action_jobs", "rule_version INTEGER NOT NULL DEFAULT 1");
  addColumn(db, "action_jobs", "rule_snapshot_json TEXT NOT NULL DEFAULT '{}'");
  addColumn(db, "skill_definitions", "skill_kind TEXT NOT NULL DEFAULT 'passive'");
  addColumn(db, "action_definitions", "cash_wen_delta INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "loot_piles", "cash_wen INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "npc_schedule_entries", "weekday_mask INTEGER NOT NULL DEFAULT 127");
  addColumn(db, "npc_dialogue_topics", "minimum_standing INTEGER NOT NULL DEFAULT -100");
  addColumn(db, "npc_commission_templates", "repeat_cooldown_seconds INTEGER NOT NULL DEFAULT 86400");
  addColumn(db, "agent_credentials", "scope TEXT NOT NULL DEFAULT 'gameplay'");

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
  if (previousVersion < 8) {
    db.prepare(`
      DELETE FROM item_reservations WHERE job_id IN (
        SELECT id FROM action_jobs
        WHERE action_template_id='action-qinggong' AND status IN ('running','queued','paused')
      )
    `).run();
    db.prepare(`
      UPDATE action_jobs SET status='cancelled',result_text='轻功已改为地图即时技能，旧排队行动已取消。',updated_at=?
      WHERE action_template_id='action-qinggong' AND status IN ('running','queued','paused')
    `).run(now);
  }
  if (previousVersion < 9) {
    db.prepare(`
      INSERT OR IGNORE INTO player_active_skills(
        player_id,skill_id,action_template_id,started_at,expires_at,updated_at
      )
      SELECT p.id,'eagle-eye','action-eagle-eye',p.updated_at,p.vision_bonus_until,?
      FROM players p
      WHERE p.vision_bonus_until>? AND EXISTS (SELECT 1 FROM skill_definitions WHERE id='eagle-eye')
        AND EXISTS (SELECT 1 FROM action_templates WHERE id='action-eagle-eye')
    `).run(now, now);
  }
  if (previousVersion < 10) {
    db.exec(`
      UPDATE action_definitions SET cash_wen_delta=silver_delta*1000;
      UPDATE loot_piles SET cash_wen=silver*1000;
    `);
    const templates = db.prepare("SELECT id,costs_json,outcomes_json FROM action_templates").all() as Array<{
      id: string; costs_json: string; outcomes_json: string;
    }>;
    const updateTemplate = db.prepare("UPDATE action_templates SET costs_json=?,outcomes_json=? WHERE id=?");
    for (const template of templates) {
      updateTemplate.run(
        migrateCurrencyOutcome(template.costs_json), migrateCurrencyOutcome(template.outcomes_json), template.id,
      );
    }
    const trades = db.prepare("SELECT id,offer_a_json,offer_b_json FROM trade_sessions").all() as Array<{
      id: string; offer_a_json: string; offer_b_json: string;
    }>;
    const updateTrade = db.prepare("UPDATE trade_sessions SET offer_a_json=?,offer_b_json=? WHERE id=?");
    for (const trade of trades) updateTrade.run(migrateStoredTradeOffer(trade.offer_a_json), migrateStoredTradeOffer(trade.offer_b_json), trade.id);
    db.prepare(`
      INSERT OR IGNORE INTO player_wallets(player_id,cash_wen,updated_at)
      SELECT id,MAX(0,silver*1000),? FROM players
    `).run(now);
    db.prepare(`
      INSERT OR IGNORE INTO currency_ledger(
        id,player_id,delta_wen,balance_after_wen,reason,reference_type,reference_id,created_at
      ) SELECT 'currency-migration-'||player_id,player_id,cash_wen,cash_wen,
        '旧银两按一银两等于一贯迁入','migration','schema-10',? FROM player_wallets
    `).run(now);
  }
  if (previousVersion >= 10 && previousVersion < 14) {
    const templates = db.prepare("SELECT id,costs_json,outcomes_json FROM action_templates").all() as Array<{
      id: string; costs_json: string; outcomes_json: string;
    }>;
    const updateTemplate = db.prepare("UPDATE action_templates SET costs_json=?,outcomes_json=? WHERE id=?");
    for (const template of templates) {
      updateTemplate.run(
        migrateCurrencyOutcome(template.costs_json), migrateCurrencyOutcome(template.outcomes_json), template.id,
      );
    }
  }

  if (previousVersion < 15) {
    // Existing jobs keep their historical template lookup as a compatibility
    // fallback; newly accepted jobs always persist an immutable rule snapshot.
    db.prepare("UPDATE action_jobs SET rule_version=1 WHERE rule_version IS NULL OR rule_version<1").run();
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
    CREATE INDEX IF NOT EXISTS idx_action_cooldowns_available ON player_action_cooldowns(available_at,player_id);
    CREATE INDEX IF NOT EXISTS idx_active_skills_expiry ON player_active_skills(expires_at,player_id);
    CREATE INDEX IF NOT EXISTS idx_items_owner ON item_instances(owner_player_id,equipped_slot,definition_id);
    CREATE INDEX IF NOT EXISTS idx_items_loot ON item_instances(loot_pile_id,definition_id);
    CREATE INDEX IF NOT EXISTS idx_item_reservations_instance ON item_reservations(item_instance_id,job_id);
    CREATE INDEX IF NOT EXISTS idx_background_jobs_completion ON background_jobs(status,completes_at);
    CREATE INDEX IF NOT EXISTS idx_interactions_target ON interaction_requests(to_player_id,status,expires_at);
    CREATE INDEX IF NOT EXISTS idx_relationships_a ON player_relationships(player_a_id,status);
    CREATE INDEX IF NOT EXISTS idx_relationships_b ON player_relationships(player_b_id,status);
    CREATE INDEX IF NOT EXISTS idx_combat_participants ON combat_sessions(attacker_id,defender_id,status);
    CREATE INDEX IF NOT EXISTS idx_private_events_player ON private_events(player_id,id DESC);
    CREATE INDEX IF NOT EXISTS idx_npc_think ON npc_profiles(next_think_at,player_id);
    CREATE INDEX IF NOT EXISTS idx_currency_ledger_player ON currency_ledger(player_id,created_at,id);
    CREATE INDEX IF NOT EXISTS idx_shop_service_location ON shop_service_locations(location_id,shop_id);
    CREATE INDEX IF NOT EXISTS idx_shop_transactions_player ON shop_transactions(player_id,created_at,id);
    CREATE INDEX IF NOT EXISTS idx_market_contracts_active ON market_contracts(status,underlying_id,kind,expiry_at);
    CREATE INDEX IF NOT EXISTS idx_market_orders_book ON market_orders(contract_id,status,side,limit_price_wen,created_at,id);
    CREATE INDEX IF NOT EXISTS idx_market_orders_player ON market_orders(player_id,status,created_at,id);
    CREATE INDEX IF NOT EXISTS idx_market_trades_contract ON market_trades(contract_id,id DESC);
    CREATE INDEX IF NOT EXISTS idx_market_positions_player ON market_positions(player_id,contract_id);
    CREATE INDEX IF NOT EXISTS idx_npc_assignments_cohort ON npc_assignments(cohort,occupation_key,player_id);
    CREATE INDEX IF NOT EXISTS idx_npc_schedule_player ON npc_schedule_entries(player_id,start_minute,end_minute);
    CREATE INDEX IF NOT EXISTS idx_npc_dialogue_history ON npc_dialogue_history(player_id,npc_id,created_at);
    CREATE INDEX IF NOT EXISTS idx_npc_standing_events ON npc_standing_events(player_id,npc_id,created_at);
    CREATE INDEX IF NOT EXISTS idx_player_commissions ON player_commissions(player_id,status,due_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_credentials_scope ON agent_credentials(player_id,scope,label);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_npc_trade_strategy_active ON npc_trade_strategies(player_id) WHERE active=1;
    CREATE INDEX IF NOT EXISTS idx_npc_trade_decision_status ON npc_trade_decisions(status,created_at,id);
    CREATE INDEX IF NOT EXISTS idx_market_account_ledger_player ON market_account_ledger(player_id,created_at,id);
    CREATE INDEX IF NOT EXISTS idx_law_incidents_actor ON law_incidents(actor_player_id,created_at DESC,id);
    CREATE INDEX IF NOT EXISTS idx_npc_respawn_due ON npc_respawn_jobs(status,due_at,npc_player_id);
  `);
  db.prepare("INSERT OR REPLACE INTO schema_migrations(version,applied_at) VALUES (?,?)").run(MAP_SCHEMA_VERSION, now);
}

function seed(db: GameDatabase) {
  inTransaction(db, () => {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO world_state(id,era,seed,announcement,updated_at)
      VALUES (1,'北宋东京开封府市井世界','path-of-wuxia-world-v10','现代住宅之外是一张以北宋东京开封府为主体的连续大地图：城门、御街、河桥、坊市与宋式店铺相连，楼门路东端区域仍在建设。',?)
      ON CONFLICT(id) DO UPDATE SET era=excluded.era,seed=excluded.seed,announcement=excluded.announcement,updated_at=excluded.updated_at
    `).run(now);

    applyWorldSeed(db);
    db.prepare(`
      DELETE FROM item_reservations WHERE job_id IN (
        SELECT j.id FROM action_jobs j JOIN players p ON p.id=j.player_id
        JOIN locations l ON l.id=p.current_location
        WHERE l.is_active=0 AND (l.region_id='palos' OR l.id LIKE 'palos-%')
          AND j.status IN ('running','queued','paused')
      )
    `).run();
    db.prepare(`
      UPDATE action_jobs SET status='cancelled',result_text='帕洛斯区域已移除，原地点行动已取消。',updated_at=?
      WHERE player_id IN (
        SELECT p.id FROM players p JOIN locations l ON l.id=p.current_location
        WHERE l.is_active=0 AND (l.region_id='palos' OR l.id LIKE 'palos-%')
      ) AND status IN ('running','queued','paused')
    `).run(now);
    db.prepare(`
      UPDATE npc_profiles SET home_location_id='loumen-road-east',updated_at=?
      WHERE home_location_id IN (
        SELECT id FROM locations WHERE is_active=0 AND (region_id='palos' OR id LIKE 'palos-%')
      )
    `).run(now);
    db.prepare(`
      UPDATE players SET current_location='loumen-road-east',updated_at=?
      WHERE current_location IN (
        SELECT id FROM locations WHERE is_active=0 AND (region_id='palos' OR id LIKE 'palos-%')
      )
    `).run(now);
    db.prepare(`
      DELETE FROM item_reservations WHERE job_id IN (
        SELECT j.id FROM action_jobs j JOIN players p ON p.id=j.player_id
        JOIN locations l ON l.id=p.current_location
        WHERE l.is_active=0 AND l.region_id='song' AND l.seed_revision>0
          AND j.status IN ('running','queued','paused')
      )
    `).run();
    db.prepare(`
      UPDATE action_jobs SET status='cancelled',result_text='东京开封府地图重建，旧地点行动已取消。',updated_at=?
      WHERE player_id IN (
        SELECT p.id FROM players p JOIN locations l ON l.id=p.current_location
        WHERE l.is_active=0 AND l.region_id='song' AND l.seed_revision>0
      ) AND status IN ('running','queued','paused')
    `).run(now);
    db.prepare(`
      UPDATE npc_profiles SET home_location_id='song-gate',updated_at=?
      WHERE home_location_id IN (
        SELECT id FROM locations WHERE is_active=0 AND region_id='song' AND seed_revision>0
      )
    `).run(now);
    db.prepare(`
      UPDATE players SET current_location='song-gate',updated_at=?
      WHERE current_location IN (
        SELECT id FROM locations WHERE is_active=0 AND region_id='song' AND seed_revision>0
      )
    `).run(now);
    ensureNpcPopulation(db, now);
    seedNpcCity(db, now);
    db.prepare(`
      INSERT OR IGNORE INTO player_wallets(player_id,cash_wen,updated_at)
      SELECT id,MAX(0,silver*1000),? FROM players
    `).run(now);
    db.prepare(`
      INSERT OR IGNORE INTO currency_ledger(
        id,player_id,delta_wen,balance_after_wen,reason,reference_type,reference_id,created_at
      ) SELECT 'currency-opening-'||player_id,player_id,cash_wen,cash_wen,
        '初始钱贯','opening','player',? FROM player_wallets wallet
      WHERE NOT EXISTS (SELECT 1 FROM currency_ledger ledger WHERE ledger.player_id=wallet.player_id)
    `).run(now);

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
