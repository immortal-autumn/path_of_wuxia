import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import {
  actionOutcomeSchema,
  actionSuccessChance,
  applyNeedDeltas,
  needPenalty,
  parseCheck,
  parseOutcomes,
  parseRequirements,
  settleNeedValues,
} from "./action-engine";
import type { GameDatabase } from "./database";
import { getGameDatabase, inTransaction } from "./database";
import { chunkForGrid, chunkKey, directionBetween, DIRECTION_DELTAS, gridToWorldPosition, OPPOSITE_DIRECTION } from "./map";
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
import { ensureStarterInventory } from "./item-catalog";
import type {
  ActionJob,
  ActionOutcome,
  ActionSystemState,
  ActionTemplate,
  ActionDefinition,
  BaseAttributes,
  ChatMessage,
  Direction,
  GameMutation,
  GameSnapshot,
  InventoryState,
  ItemInstance,
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
  PrivateEvent,
  PlayerSelf,
  PlayerNeeds,
  PlayerSkill,
  QinggongTarget,
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
  vision_bonus_until: string | null; vision_depth_bonus: number;
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
type ActionTemplateRow = {
  id: string; binding_id: string; name: string; description: string; category: ActionTemplate["category"];
  target_kind: ActionTemplate["targetKind"]; duration_seconds: number; requirements_json: string; check_json: string;
  costs_json: string; outcomes_json: string; result_template: string; adult: number;
  visibility: ActionTemplate["visibility"]; cooldown_seconds: number; version: number;
};
type ActionJobRow = {
  id: string; action_name: string; player_id: string; action_template_id: string; target_player_id: string | null;
  target_location_id: string | null; status: ActionJob["status"]; queue_position: number;
  duration_seconds: number;
  started_at: string | null; completes_at: string | null; result_text: string | null;
  reserved_json: string; context_json: string;
};

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

function mapActionJob(row: ActionJobRow): ActionJob {
  return {
    id: row.id,
    name: row.action_name,
    playerId: row.player_id,
    actionTemplateId: row.action_template_id,
    targetPlayerId: row.target_player_id,
    targetLocationId: row.target_location_id,
    status: row.status,
    queuePosition: row.queue_position,
    durationSeconds: row.duration_seconds,
    startedAt: row.started_at,
    completesAt: row.completes_at,
    resultText: row.result_text,
  };
}

function actionOutcomeSummary(outcome: ActionOutcome) {
  const parts: string[] = [];
  if (outcome.silverDelta) parts.push(`银两${outcome.silverDelta > 0 ? "+" : ""}${outcome.silverDelta}`);
  if (outcome.hpDelta) parts.push(`气血${outcome.hpDelta > 0 ? "+" : ""}${outcome.hpDelta}`);
  if (outcome.cultivationDelta) parts.push(`修为${outcome.cultivationDelta > 0 ? "+" : ""}${outcome.cultivationDelta}`);
  if (outcome.needDeltas) {
    const labels = { satiety: "饱食", hydration: "饮水", hygiene: "卫生", fatigue: "疲劳", bladder: "如厕" } as const;
    for (const [key, value] of Object.entries(outcome.needDeltas)) {
      if (value) parts.push(`${labels[key as keyof typeof labels]}${value > 0 ? "+" : ""}${value}`);
    }
  }
  return parts.join(" · ") || "结果由行动检定决定";
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

function straightDirection(dx: number, dy: number): Direction | null {
  const distance = Math.max(Math.abs(dx), Math.abs(dy));
  if (distance < 1) return null;
  return (Object.entries(DIRECTION_DELTAS).find(([, [stepX, stepY]]) => (
    stepX * distance === dx && stepY * distance === dy
  ))?.[0] ?? null) as Direction | null;
}

export class GameService {
  constructor(
    private readonly db: GameDatabase = getGameDatabase(),
    private readonly now: () => Date = () => new Date(),
    private readonly randomPercent: () => number = () => randomInt(100),
  ) {}

  private ensurePlayerSystems(playerId: string, at = this.now()) {
    const timestamp = at.toISOString();
    this.db.prepare("INSERT OR IGNORE INTO player_needs(player_id,updated_at) VALUES (?,?)").run(playerId, timestamp);
    this.db.prepare(`
      INSERT OR IGNORE INTO player_skills(player_id,skill_id,level,experience,updated_at)
      SELECT ?,id,0,0,? FROM skill_definitions WHERE is_active=1
    `).run(playerId, timestamp);
  }

  private readNeeds(playerId: string): PlayerNeeds {
    this.ensurePlayerSystems(playerId);
    const row = this.db.prepare(`
      SELECT satiety,hydration,hygiene,fatigue,bladder,updated_at FROM player_needs WHERE player_id=?
    `).get(playerId) as {
      satiety: number; hydration: number; hygiene: number; fatigue: number; bladder: number; updated_at: string;
    };
    return {
      satiety: row.satiety,
      hydration: row.hydration,
      hygiene: row.hygiene,
      fatigue: row.fatigue,
      bladder: row.bladder,
      updatedAt: row.updated_at,
    };
  }

  private writeNeeds(playerId: string, needs: PlayerNeeds) {
    this.db.prepare(`
      UPDATE player_needs SET satiety=?,hydration=?,hygiene=?,fatigue=?,bladder=?,updated_at=? WHERE player_id=?
    `).run(needs.satiety, needs.hydration, needs.hygiene, needs.fatigue, needs.bladder, needs.updatedAt, playerId);
  }

  private settleNeedsInternal(playerId: string, at: Date) {
    const settled = settleNeedValues(this.readNeeds(playerId), at);
    this.writeNeeds(playerId, settled);
    return settled;
  }

  getNeeds(playerId: string) {
    this.getPlayerRow(playerId);
    return this.settleNeedsInternal(playerId, this.now());
  }

  private getPlayerSkills(playerId: string): PlayerSkill[] {
    this.ensurePlayerSystems(playerId);
    return (this.db.prepare(`
      SELECT s.id,s.name,s.description,s.attribute_key,s.category,ps.level,ps.experience
      FROM player_skills ps JOIN skill_definitions s ON s.id=ps.skill_id
      WHERE ps.player_id=? AND s.is_active=1 ORDER BY s.category,s.id
    `).all(playerId) as Array<{
      id: string; name: string; description: string; attribute_key: keyof BaseAttributes;
      category: string; level: number; experience: number;
    }>).map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      attributeKey: row.attribute_key,
      category: row.category,
      level: row.level,
      experience: row.experience,
    }));
  }

  private equipmentBonuses(playerId: string) {
    const rows = this.db.prepare(`
      SELECT d.effects_json FROM item_instances i JOIN item_definitions d ON d.id=i.definition_id
      WHERE i.owner_player_id=? AND i.equipped_slot IS NOT NULL AND i.durability>=0
    `).all(playerId) as Array<{ effects_json: string }>;
    const bonuses = { attack: 0, defense: 0, speed: 0, maxHp: 0 };
    for (const row of rows) {
      const effects = JSON.parse(row.effects_json) as Record<string, unknown>;
      for (const key of Object.keys(bonuses) as Array<keyof typeof bonuses>) {
        const value = effects[key];
        if (typeof value === "number" && Number.isFinite(value)) bonuses[key] += value;
      }
    }
    return bonuses;
  }

  private grantItem(playerId: string, definitionId: string, quantity: number, quality: number, bound: boolean, at: string) {
    const definition = this.db.prepare(`
      SELECT stackable,max_stack,max_durability FROM item_definitions WHERE id=? AND is_active=1
    `).get(definitionId) as { stackable: number; max_stack: number; max_durability: number } | undefined;
    if (!definition) throw new Error(`物品定义 ${definitionId} 不存在。`);
    let remaining = Math.max(0, Math.floor(quantity));
    if (definition.stackable) {
      const stacks = this.db.prepare(`
        SELECT id,quantity FROM item_instances WHERE owner_player_id=? AND definition_id=?
          AND quality=? AND bound=? AND equipped_slot IS NULL
        ORDER BY quantity,id
      `).all(playerId, definitionId, quality, bound ? 1 : 0) as Array<{ id: string; quantity: number }>;
      const update = this.db.prepare("UPDATE item_instances SET quantity=?,updated_at=? WHERE id=?");
      for (const stack of stacks) {
        if (remaining <= 0) break;
        const added = Math.min(remaining, definition.max_stack - stack.quantity);
        if (added <= 0) continue;
        update.run(stack.quantity + added, at, stack.id);
        remaining -= added;
      }
    }
    const insert = this.db.prepare(`
      INSERT INTO item_instances(
        id,definition_id,owner_player_id,quantity,quality,durability,affixes_json,bound,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,'[]',?,?,?)
    `);
    while (remaining > 0) {
      const stackQuantity = definition.stackable ? Math.min(remaining, definition.max_stack) : 1;
      insert.run(randomUUID(), definitionId, playerId, stackQuantity, quality, definition.max_durability, bound ? 1 : 0, at, at);
      remaining -= stackQuantity;
    }
  }

  private reserveItems(playerId: string, jobId: string, inputs: Record<string, number>) {
    const reserve = this.db.prepare("INSERT INTO item_reservations(job_id,item_instance_id,quantity) VALUES (?,?,?)");
    for (const [definitionId, requiredValue] of Object.entries(inputs)) {
      let required = Math.max(0, Math.floor(requiredValue));
      const rows = this.db.prepare(`
        SELECT i.id,i.quantity-COALESCE(SUM(r.quantity),0) AS available
        FROM item_instances i LEFT JOIN item_reservations r ON r.item_instance_id=i.id
        WHERE i.owner_player_id=? AND i.definition_id=? AND i.equipped_slot IS NULL
        GROUP BY i.id,i.quantity HAVING available>0 ORDER BY i.bound,i.quality,i.created_at
      `).all(playerId, definitionId) as Array<{ id: string; available: number }>;
      for (const row of rows) {
        if (required <= 0) break;
        const quantity = Math.min(required, row.available);
        reserve.run(jobId, row.id, quantity);
        required -= quantity;
      }
      if (required > 0) throw new Error("制作或行动所需物品不足。");
    }
  }

  private consumeReservations(jobId: string, at: string) {
    const rows = this.db.prepare(`
      SELECT r.item_instance_id,r.quantity,i.quantity AS owned FROM item_reservations r
      JOIN item_instances i ON i.id=r.item_instance_id WHERE r.job_id=?
    `).all(jobId) as Array<{ item_instance_id: string; quantity: number; owned: number }>;
    for (const row of rows) {
      if (row.quantity >= row.owned) this.db.prepare("DELETE FROM item_instances WHERE id=?").run(row.item_instance_id);
      else this.db.prepare("UPDATE item_instances SET quantity=quantity-?,updated_at=? WHERE id=?").run(row.quantity, at, row.item_instance_id);
    }
    this.db.prepare("DELETE FROM item_reservations WHERE job_id=?").run(jobId);
  }

  getInventoryState(playerId: string): InventoryState {
    const player = this.getPlayer(playerId);
    ensureStarterInventory(this.db, playerId, this.now().toISOString());
    const items = (this.db.prepare(`
      SELECT i.id,i.definition_id,d.name,d.description,d.category,i.quantity,i.quality,i.durability,
        d.max_durability,i.affixes_json,i.bound,i.equipped_slot,d.equipment_slot,d.effects_json,
        COALESCE(SUM(r.quantity),0) AS reserved_quantity
      FROM item_instances i JOIN item_definitions d ON d.id=i.definition_id
      LEFT JOIN item_reservations r ON r.item_instance_id=i.id
      WHERE i.owner_player_id=? GROUP BY i.id ORDER BY i.equipped_slot DESC,d.category,d.name,i.quality DESC,i.id
    `).all(playerId) as Array<{
      id: string; definition_id: string; name: string; description: string; category: string; quantity: number;
      quality: number; durability: number; max_durability: number; affixes_json: string; bound: number;
      equipped_slot: string | null; equipment_slot: string | null; effects_json: string; reserved_quantity: number;
    }>).map((row): ItemInstance => ({
      id: row.id, definitionId: row.definition_id, name: row.name, description: row.description,
      category: row.category, quantity: row.quantity, quality: row.quality, durability: row.durability,
      maxDurability: row.max_durability, affixes: JSON.parse(row.affixes_json) as Array<Record<string, unknown>>,
      bound: row.bound === 1, equippedSlot: row.equipped_slot, equipmentSlot: row.equipment_slot,
      reservedQuantity: row.reserved_quantity, effects: JSON.parse(row.effects_json) as Record<string, unknown>,
    }));
    const counts = new Map<string, number>();
    for (const item of items) counts.set(item.definitionId, (counts.get(item.definitionId) ?? 0) + item.quantity - item.reservedQuantity);
    const facilities = new Set((this.db.prepare(`
      SELECT facility_type FROM location_facilities WHERE location_id=? AND is_active=1
    `).all(player.currentLocation) as Array<{ facility_type: string }>).map((row) => row.facility_type));
    const itemNames = new Map((this.db.prepare("SELECT id,name FROM item_definitions WHERE is_active=1").all() as Array<{ id: string; name: string }>).map((row) => [row.id, row.name]));
    const recipes = (this.db.prepare(`
      SELECT id,name,description,facility_type,skill_id,duration_seconds,difficulty,inputs_json,outputs_json
      FROM recipe_definitions WHERE is_active=1 ORDER BY facility_type,name
    `).all() as Array<{
      id: string; name: string; description: string; facility_type: string; skill_id: string | null;
      duration_seconds: number; difficulty: number; inputs_json: string; outputs_json: string;
    }>).map((row) => {
      const inputs = Object.entries(JSON.parse(row.inputs_json) as Record<string, number>)
        .map(([definitionId, quantity]) => ({ definitionId, name: itemNames.get(definitionId) ?? definitionId, quantity }));
      const outputs = Object.entries(JSON.parse(row.outputs_json) as Record<string, number>)
        .map(([definitionId, quantity]) => ({ definitionId, name: itemNames.get(definitionId) ?? definitionId, quantity }));
      const facilityAvailable = facilities.has(row.facility_type);
      const missing = inputs.find((input) => (counts.get(input.definitionId) ?? 0) < input.quantity);
      return {
        id: row.id, name: row.name, description: row.description, facilityType: row.facility_type,
        skillId: row.skill_id, durationSeconds: row.duration_seconds, difficulty: row.difficulty, inputs, outputs,
        available: facilityAvailable && !missing,
        unavailableReason: !facilityAvailable ? `需要${row.facility_type}设施` : missing ? `缺少${missing.name}` : null,
      };
    }).filter((recipe) => facilities.has(recipe.facilityType));
    const farmPlots = (this.db.prepare(`
      SELECT p.id,f.location_id,p.state,p.crop_id,c.name AS crop_name,p.owner_player_id,p.matures_at,
        p.water,p.fertility,p.disease FROM farm_plots p
      JOIN location_facilities f ON f.id=p.facility_id LEFT JOIN crop_definitions c ON c.id=p.crop_id
      WHERE f.location_id=? AND f.is_active=1 ORDER BY p.id
    `).all(player.currentLocation) as Array<{
      id: string; location_id: string; state: string; crop_id: string | null; crop_name: string | null;
      owner_player_id: string | null; matures_at: string | null; water: number; fertility: number; disease: number;
    }>).map((row) => ({
      id: row.id, locationId: row.location_id, state: row.state, cropId: row.crop_id, cropName: row.crop_name,
      ownerPlayerId: row.owner_player_id, maturesAt: row.matures_at,
      mature: row.matures_at !== null && new Date(row.matures_at).getTime() <= this.now().getTime(),
      water: row.water, fertility: row.fertility, disease: row.disease,
    }));
    return { items, recipes, farmPlots };
  }

  equipItem(playerId: string, itemInstanceId: string) {
    return inTransaction(this.db, () => {
      const row = this.db.prepare(`
        SELECT i.id,i.equipped_slot,d.equipment_slot,
          i.quantity-COALESCE((SELECT SUM(quantity) FROM item_reservations WHERE item_instance_id=i.id),0) AS available
        FROM item_instances i JOIN item_definitions d ON d.id=i.definition_id
        WHERE i.id=? AND i.owner_player_id=?
      `).get(itemInstanceId, playerId) as { id: string; equipped_slot: string | null; equipment_slot: string | null; available: number } | undefined;
      if (!row) throw new Error("未找到这件物品。");
      if (!row.equipment_slot) throw new Error("这件物品不能装备。");
      if (row.available <= 0) throw new Error("这件物品已被行动预留。");
      const at = this.now().toISOString();
      this.db.prepare("UPDATE item_instances SET equipped_slot=NULL,updated_at=? WHERE owner_player_id=? AND equipped_slot=?")
        .run(at, playerId, row.equipment_slot);
      this.db.prepare("UPDATE item_instances SET equipped_slot=?,updated_at=? WHERE id=?").run(row.equipment_slot, at, row.id);
      return { inventory: this.getInventoryState(playerId), player: this.getPlayer(playerId), message: "装备已更新。" };
    });
  }

  unequipItem(playerId: string, itemInstanceId: string) {
    return inTransaction(this.db, () => {
      const changed = this.db.prepare("UPDATE item_instances SET equipped_slot=NULL,updated_at=? WHERE id=? AND owner_player_id=? AND equipped_slot IS NOT NULL")
        .run(this.now().toISOString(), itemInstanceId, playerId).changes;
      if (!changed) throw new Error("这件物品当前没有装备。");
      return { inventory: this.getInventoryState(playerId), player: this.getPlayer(playerId), message: "物品已卸下。" };
    });
  }

  useItem(playerId: string, itemInstanceId: string) {
    return inTransaction(this.db, () => {
      const row = this.db.prepare(`
        SELECT i.id,i.quantity,d.name,d.effects_json,
          COALESCE((SELECT SUM(quantity) FROM item_reservations WHERE item_instance_id=i.id),0) AS reserved
        FROM item_instances i JOIN item_definitions d ON d.id=i.definition_id
        WHERE i.id=? AND i.owner_player_id=? AND i.equipped_slot IS NULL
      `).get(itemInstanceId, playerId) as { id: string; quantity: number; name: string; effects_json: string; reserved: number } | undefined;
      if (!row || row.quantity - row.reserved <= 0) throw new Error("这件物品当前无法使用。");
      const effects = actionOutcomeSchema.parse(JSON.parse(row.effects_json));
      if (Object.keys(effects).length === 0) throw new Error("这件物品不能直接使用。");
      const at = this.now();
      const player = this.getPlayerRow(playerId);
      const needs = this.settleNeedsInternal(playerId, at);
      const nextNeeds = applyNeedDeltas(needs, effects.needDeltas);
      nextNeeds.updatedAt = at.toISOString();
      this.writeNeeds(playerId, nextNeeds);
      const derived = this.mapPlayer(player).derived;
      this.db.prepare("UPDATE players SET hp=?,updated_at=?,last_seen_at=? WHERE id=?")
        .run(Math.max(0, Math.min(derived.maxHp, player.hp + (effects.hpDelta ?? 0))), at.toISOString(), at.toISOString(), playerId);
      if (row.quantity === 1) this.db.prepare("DELETE FROM item_instances WHERE id=?").run(row.id);
      else this.db.prepare("UPDATE item_instances SET quantity=quantity-1,updated_at=? WHERE id=?").run(at.toISOString(), row.id);
      this.db.prepare("INSERT INTO private_events(player_id,event_type,content,created_at) VALUES (?,'item',?,?)")
        .run(playerId, `使用了${row.name}。`, at.toISOString());
      return { inventory: this.getInventoryState(playerId), player: this.getPlayer(playerId), message: `已使用${row.name}。` };
    });
  }

  private enqueueSystemJob({
    playerId,
    templateId,
    durationSeconds,
    context,
    inputs = {},
  }: {
    playerId: string;
    templateId: string;
    durationSeconds: number;
    context: Record<string, unknown>;
    inputs?: Record<string, number>;
  }) {
    const now = this.now();
    this.settleActionQueueInternal(playerId, now);
    const player = this.getPlayerRow(playerId);
    this.getTemplateRow(templateId);
    const jobs = this.actionJobs(playerId);
    const queuedCount = jobs.filter((job) => job.status === "queued").length;
    if (queuedCount >= 8) throw new Error("等待队列最多只能安排8项行动。");
    const running = jobs.some((job) => job.status === "running" || job.status === "paused");
    const id = randomUUID();
    const timestamp = now.toISOString();
    this.db.prepare(`
      INSERT INTO action_jobs(
        id,player_id,action_template_id,target_location_id,status,queue_position,started_at,completes_at,
        duration_seconds,reserved_json,context_json,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,'{}',?,?,?)
    `).run(
      id, playerId, templateId, player.current_location, running ? "queued" : "running", running ? queuedCount + 1 : 0,
      running ? null : timestamp,
      running ? null : new Date(now.getTime() + durationSeconds * 1000).toISOString(),
      durationSeconds, JSON.stringify(context), timestamp, timestamp,
    );
    this.reserveItems(playerId, id, inputs);
    return { id, running };
  }

  startCraft(playerId: string, recipeId: string) {
    return inTransaction(this.db, () => {
      const player = this.getPlayerRow(playerId);
      const recipe = this.db.prepare(`
        SELECT id,name,facility_type,skill_id,duration_seconds,difficulty,inputs_json,outputs_json
        FROM recipe_definitions WHERE id=? AND is_active=1
      `).get(recipeId) as {
        id: string; name: string; facility_type: string; skill_id: string | null; duration_seconds: number;
        difficulty: number; inputs_json: string; outputs_json: string;
      } | undefined;
      if (!recipe) throw new Error("配方不存在或已停用。");
      if (!this.db.prepare("SELECT 1 FROM location_facilities WHERE location_id=? AND facility_type=? AND is_active=1").get(player.current_location, recipe.facility_type)) {
        throw new Error("当前位置缺少配方所需设施。");
      }
      const queued = this.enqueueSystemJob({
        playerId,
        templateId: "action-craft-recipe",
        durationSeconds: recipe.duration_seconds,
        context: { recipeId: recipe.id, skillId: recipe.skill_id, difficulty: recipe.difficulty, outputs: JSON.parse(recipe.outputs_json) },
        inputs: JSON.parse(recipe.inputs_json) as Record<string, number>,
      });
      return {
        actionState: this.readActionState(playerId), inventory: this.getInventoryState(playerId),
        message: queued.running ? `${recipe.name}已加入等待队列。` : `${recipe.name}已经开始。`,
      };
    });
  }

  startFarmAction(playerId: string, plotId: string, operation: "plant" | "water" | "harvest", cropId?: string) {
    return inTransaction(this.db, () => {
      const player = this.getPlayerRow(playerId);
      const plot = this.db.prepare(`
        SELECT p.id,p.state,p.crop_id,p.matures_at,f.location_id FROM farm_plots p
        JOIN location_facilities f ON f.id=p.facility_id WHERE p.id=? AND f.is_active=1
      `).get(plotId) as { id: string; state: string; crop_id: string | null; matures_at: string | null; location_id: string } | undefined;
      if (!plot || plot.location_id !== player.current_location) throw new Error("农田不在当前位置。");
      let templateId: string;
      let durationSeconds: number;
      let inputs: Record<string, number> = {};
      const context: Record<string, unknown> = { farmOperation: operation, plotId };
      if (operation === "plant") {
        if (plot.state !== "empty" || !cropId) throw new Error("这块农田当前不能播种。");
        const crop = this.db.prepare("SELECT seed_item_id FROM crop_definitions WHERE id=? AND is_active=1").get(cropId) as { seed_item_id: string } | undefined;
        if (!crop) throw new Error("作物不存在或已停用。");
        templateId = "action-farm-plant";
        durationSeconds = 1800;
        inputs = { [crop.seed_item_id]: 1 };
        context.cropId = cropId;
      } else if (operation === "water") {
        if (plot.state !== "growing") throw new Error("这块农田没有正在生长的作物。");
        templateId = "action-farm-water";
        durationSeconds = 1200;
      } else {
        if (plot.state !== "growing" || !plot.matures_at || new Date(plot.matures_at).getTime() > this.now().getTime()) throw new Error("作物尚未成熟。");
        templateId = "action-farm-harvest";
        durationSeconds = 1800;
      }
      const queued = this.enqueueSystemJob({ playerId, templateId, durationSeconds, context, inputs });
      return {
        actionState: this.readActionState(playerId), inventory: this.getInventoryState(playerId),
        message: queued.running ? "农耕行动已加入等待队列。" : "农耕行动已经开始。",
      };
    });
  }

  private playerSelect() {
    return `
      SELECT p.id,p.name,p.title,p.hp,p.silver,p.current_location,
             pr.strength,pr.agility,pr.constitution,pr.root,pr.comprehension,pr.spirit,
             pr.unspent_points,pr.realm_index,pr.realm_level,pr.cultivation_progress,
             pr.endurance,pr.training_anchor_at,COALESCE(le.multiplier,0) AS training_multiplier,
             p.vision_bonus_until,p.vision_depth_bonus
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
    const baseDerived = deriveStats(attributes, row.realm_index);
    const equipment = this.equipmentBonuses(row.id);
    const derived = {
      ...baseDerived,
      maxHp: baseDerived.maxHp + equipment.maxHp,
      minAttack: baseDerived.minAttack + equipment.attack,
      maxAttack: baseDerived.maxAttack + equipment.attack,
      defense: baseDerived.defense + equipment.defense,
      speed: baseDerived.speed + equipment.speed,
    };
    const levelCost = cultivationForNextLevel(row.realm_index, row.realm_level);
    const breakthroughCost = Math.ceil(levelCost * 0.3);
    const chance = breakthroughChance(row.realm_level);
    const needs = this.readNeeds(row.id);
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
      needs,
      skills: this.getPlayerSkills(row.id),
      visionDepth: row.vision_bonus_until && new Date(row.vision_bonus_until).getTime() > this.now().getTime()
        ? Math.min(8, 3 + Math.max(0, row.vision_depth_bonus))
        : 3,
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
      ensureStarterInventory(this.db, playerId, createdAt);
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
    this.settleActionQueue(row.id, true);
    return this.settleCultivation(row.id, true).player;
  }

  getPlayer(playerId: string) {
    const row = this.getPlayerRow(playerId);
    this.settleNeedsInternal(playerId, this.now());
    return this.mapPlayer(row);
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

  private getTemplateRow(actionTemplateId: string) {
    const row = this.db.prepare(`
      SELECT id,'' AS binding_id,name,description,category,target_kind,duration_seconds,requirements_json,
        check_json,costs_json,outcomes_json,result_template,adult,visibility,cooldown_seconds,version
      FROM action_templates WHERE id=? AND is_active=1
    `).get(actionTemplateId) as ActionTemplateRow | undefined;
    if (!row) throw new Error("行动规则不存在或已停用。");
    return row;
  }

  private actionJobs(playerId: string) {
    return (this.db.prepare(`
      SELECT j.id,t.name AS action_name,j.player_id,j.action_template_id,j.target_player_id,j.target_location_id,
        j.status,j.queue_position,j.duration_seconds,j.started_at,j.completes_at,j.result_text,j.reserved_json,j.context_json
      FROM action_jobs j JOIN action_templates t ON t.id=j.action_template_id
      WHERE j.player_id=? AND j.status IN ('running','queued','paused')
      ORDER BY CASE j.status WHEN 'running' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END,j.queue_position,j.created_at
    `).all(playerId) as ActionJobRow[]).map(mapActionJob);
  }

  private skillLevel(playerId: string, skillId: string | undefined) {
    if (!skillId) return 0;
    this.ensurePlayerSystems(playerId);
    return (this.db.prepare("SELECT level FROM player_skills WHERE player_id=? AND skill_id=?").get(playerId, skillId) as { level: number } | undefined)?.level ?? 0;
  }

  private addSkillExperience(playerId: string, skillId: string | undefined, gain: number, at: string) {
    if (!skillId || gain <= 0) return;
    this.ensurePlayerSystems(playerId, new Date(at));
    const row = this.db.prepare("SELECT level,experience FROM player_skills WHERE player_id=? AND skill_id=?").get(playerId, skillId) as { level: number; experience: number } | undefined;
    if (!row) return;
    let level = row.level;
    let experience = row.experience + Math.floor(gain);
    while (level < 100) {
      const required = 100 * (level + 1);
      if (experience < required) break;
      experience -= required;
      level += 1;
    }
    this.db.prepare("UPDATE player_skills SET level=?,experience=?,updated_at=? WHERE player_id=? AND skill_id=?")
      .run(level, experience, at, playerId, skillId);
  }

  private applyActionOutcome(playerId: string, job: ActionJobRow, completedAt: Date) {
    this.settleCultivationInternal(playerId, completedAt, false);
    const template = this.getTemplateRow(job.action_template_id);
    const requirements = parseRequirements(template.requirements_json);
    const context = JSON.parse(job.context_json) as Record<string, unknown>;
    let check = parseCheck(template.check_json);
    let outcomes = parseOutcomes(template.outcomes_json);
    let resultDetail = template.name;
    if (typeof context.recipeId === "string") {
      const recipe = this.db.prepare("SELECT name,skill_id,difficulty,outputs_json FROM recipe_definitions WHERE id=?").get(context.recipeId) as {
        name: string; skill_id: string | null; difficulty: number; outputs_json: string;
      } | undefined;
      if (!recipe) throw new Error("行动使用的配方已经不存在。");
      check = { skillId: recipe.skill_id ?? undefined, attribute: "comprehension", difficulty: recipe.difficulty };
      outcomes = {
        success: {
          skillExperience: Math.max(8, Math.floor(job.duration_seconds / 300)),
          items: Object.entries(JSON.parse(recipe.outputs_json) as Record<string, number>)
            .map(([definitionId, quantity]) => ({ definitionId, quantity })),
        },
        failure: { skillExperience: Math.max(3, Math.floor(job.duration_seconds / 900)) },
      };
      resultDetail = recipe.name;
    } else if (typeof context.farmOperation === "string") {
      check = { skillId: "farming", attribute: "constitution", difficulty: context.farmOperation === "harvest" ? 35 : 25 };
      outcomes = { success: { skillExperience: 10 }, failure: { skillExperience: 4 } };
      resultDetail = context.farmOperation === "plant" ? "播种" : context.farmOperation === "water" ? "浇水" : "收获";
    }
    const row = this.getPlayerRow(playerId);
    const attributes: BaseAttributes = {
      strength: row.strength, agility: row.agility, constitution: row.constitution,
      root: row.root, comprehension: row.comprehension, spirit: row.spirit,
    };
    const needs = this.settleNeedsInternal(playerId, completedAt);
    const skillId = check.skillId ?? requirements.skillId;
    const chance = actionSuccessChance({ attributes, skillLevel: this.skillLevel(playerId, skillId), needs, check });
    let success = chance >= 100 || this.randomPercent() < chance;
    let qinggongDestination: Location | null = null;
    if (template.id === "action-qinggong") {
      const destinationId = typeof context.destinationId === "string" ? context.destinationId : "";
      const sourceLocationId = typeof context.sourceLocationId === "string" ? context.sourceLocationId : "";
      const target = sourceLocationId === row.current_location
        ? this.getQinggongTargets(playerId).find((item) => item.locationId === destinationId)
        : undefined;
      if (!target) success = false;
      else qinggongDestination = this.getLocation(target.locationId);
    }
    const outcome = success ? outcomes.success : outcomes.failure;
    const timestamp = completedAt.toISOString();
    const nextNeeds = applyNeedDeltas(needs, outcome.needDeltas);
    nextNeeds.updatedAt = timestamp;
    this.writeNeeds(playerId, nextNeeds);

    const derived = deriveStats(attributes, row.realm_index);
    const hp = Math.max(0, Math.min(derived.maxHp, row.hp + (outcome.hpDelta ?? 0)));
    const silver = Math.max(0, row.silver + (outcome.silverDelta ?? 0));
    this.db.prepare("UPDATE players SET hp=?,silver=?,updated_at=?,last_seen_at=? WHERE id=?")
      .run(hp, silver, timestamp, timestamp, playerId);

    if (outcome.cultivationDelta) {
      const advanced = this.advanceCultivation(row, outcome.cultivationDelta);
      this.db.prepare(`
        UPDATE player_progression SET realm_level=?,cultivation_progress=?,unspent_points=?,updated_at=? WHERE player_id=?
      `).run(advanced.level, advanced.progress, advanced.unspentPoints, timestamp, playerId);
      this.db.prepare(`
        INSERT INTO cultivation_logs(player_id,kind,delta,realm_index,realm_level,detail,created_at)
        VALUES (?,'action',?,?,?,?,?)
      `).run(playerId, outcome.cultivationDelta, row.realm_index, advanced.level, template.name, timestamp);
    }
    this.addSkillExperience(playerId, skillId, outcome.skillExperience ?? 0, timestamp);

    if (success && outcome.statusId === "eagle-eye") {
      const level = this.skillLevel(playerId, "eagle-eye");
      const bonus = Math.min(5, 1 + Math.floor(level / 20));
      const duration = Math.max(1, outcome.statusDurationSeconds ?? 1800);
      this.db.prepare("UPDATE players SET vision_bonus_until=?,vision_depth_bonus=?,updated_at=? WHERE id=?")
        .run(new Date(completedAt.getTime() + duration * 1000).toISOString(), bonus, timestamp, playerId);
    }

    if (success && qinggongDestination) {
      this.db.prepare("UPDATE players SET current_location=?,updated_at=?,last_seen_at=? WHERE id=?")
        .run(qinggongDestination.id, timestamp, timestamp, playerId);
      this.db.prepare("UPDATE player_progression SET training_anchor_at=?,updated_at=? WHERE player_id=?")
        .run(qinggongDestination.trainingMultiplier > 0 ? timestamp : null, timestamp, playerId);
      this.db.prepare(`
        INSERT INTO player_visited_locations(player_id,location_id,first_visited_at,last_visited_at)
        VALUES (?,?,?,?) ON CONFLICT(player_id,location_id) DO UPDATE SET last_visited_at=excluded.last_visited_at
      `).run(playerId, qinggongDestination.id, timestamp, timestamp);
    }

    this.consumeReservations(job.id, timestamp);
    for (const item of outcome.items ?? []) {
      this.grantItem(playerId, item.definitionId, item.quantity, item.quality ?? 1, item.bound ?? false, timestamp);
    }

    if (success && typeof context.farmOperation === "string" && typeof context.plotId === "string") {
      if (context.farmOperation === "plant" && typeof context.cropId === "string") {
        const crop = this.db.prepare("SELECT growth_seconds FROM crop_definitions WHERE id=?").get(context.cropId) as { growth_seconds: number };
        this.db.prepare(`
          UPDATE farm_plots SET owner_player_id=?,crop_id=?,planted_at=?,matures_at=?,water=100,disease=0,
            state='growing',version=version+1,updated_at=? WHERE id=? AND state='empty'
        `).run(
          playerId, context.cropId, timestamp,
          new Date(completedAt.getTime() + crop.growth_seconds * 1000).toISOString(),timestamp, context.plotId,
        );
      } else if (context.farmOperation === "water") {
        this.db.prepare("UPDATE farm_plots SET water=MIN(100,water+50),version=version+1,updated_at=? WHERE id=? AND state='growing'")
          .run(timestamp, context.plotId);
      } else if (context.farmOperation === "harvest") {
        const crop = this.db.prepare(`
          SELECT c.harvest_item_id,c.stages_json,p.fertility,p.water,p.disease FROM farm_plots p
          JOIN crop_definitions c ON c.id=p.crop_id WHERE p.id=? AND p.state='growing'
        `).get(context.plotId) as { harvest_item_id: string; stages_json: string; fertility: number; water: number; disease: number } | undefined;
        if (crop) {
          const baseYield = Number((JSON.parse(crop.stages_json) as { yield?: number }).yield ?? 1);
          const modifier = Math.max(0.25, (crop.fertility + crop.water + (100 - crop.disease)) / 300);
          this.grantItem(playerId, crop.harvest_item_id, Math.max(1, Math.floor(baseYield * modifier)), 1, false, timestamp);
          this.db.prepare(`
            UPDATE farm_plots SET owner_player_id=NULL,crop_id=NULL,planted_at=NULL,matures_at=NULL,
              water=100,disease=0,state='empty',version=version+1,updated_at=? WHERE id=?
          `).run(timestamp, context.plotId);
        }
      }
    }

    let privateDetail = "";
    if (template.id === "action-observe") {
      const location = this.getLocation(row.current_location);
      const facilities = (this.db.prepare(`
        SELECT facility_type FROM location_facilities WHERE location_id=? AND is_active=1 ORDER BY facility_type
      `).all(row.current_location) as Array<{ facility_type: string }>).map((item) => item.facility_type);
      privateDetail = `观察结果：${location.description} 可用设施：${facilities.join("、") || "无"}。`;
    } else if (template.id === "action-listen") {
      const nearbyIds = this.getNeighborhood(row.current_location, 3).locations.map((location) => location.id);
      const traces = nearbyIds.length === 0 ? [] : this.db.prepare(`
        SELECT l.result_text FROM action_logs l
        JOIN action_templates t ON t.id=l.action_template_id
        WHERE l.created_at<=? AND l.from_location IN (${placeholders(nearbyIds)})
          AND t.visibility='public' AND t.adult=0
        ORDER BY l.id DESC LIMIT 3
      `).all(timestamp, ...nearbyIds) as Array<{ result_text: string }>;
      privateDetail = traces.length > 0
        ? `聆听结果：${traces.map((trace) => trace.result_text).join("；")}`
        : "聆听结果：没有听到明显动静。";
    }
    const movementDetail = success && qinggongDestination ? `抵达${qinggongDestination.name}。` : "";
    const content = `${template.result_template.replaceAll("{name}", row.name)} ${resultDetail}${success ? "成功" : "失败"}。${movementDetail}${privateDetail}`;
    const destinationId = success && qinggongDestination ? qinggongDestination.id : row.current_location;
    this.db.prepare(`
      INSERT INTO action_logs(player_id,kind,action_template_id,action_job_id,from_location,to_location,result_text,created_at)
      VALUES (?,'action',?,?,?,?,?,?)
    `).run(playerId, template.id, job.id, row.current_location, destinationId, content, timestamp);
    if (template.visibility === "public") {
      this.db.prepare("INSERT INTO world_events(player_id,event_type,content,created_at) VALUES (?,'action',?,?)")
        .run(playerId, content, timestamp);
    } else {
      this.db.prepare("INSERT INTO private_events(player_id,event_type,content,created_at) VALUES (?,'action',?,?)")
        .run(playerId, content, timestamp);
    }
    this.db.prepare("UPDATE action_jobs SET status='completed',result_text=?,updated_at=? WHERE id=?")
      .run(`${success ? "成功" : "失败"}（${chance}%） · ${content}`, timestamp, job.id);
  }

  private startNextQueuedJob(playerId: string, at: Date) {
    const next = this.db.prepare(`
      SELECT j.id,CASE WHEN j.duration_seconds>0 THEN j.duration_seconds ELSE t.duration_seconds END AS duration_seconds
      FROM action_jobs j JOIN action_templates t ON t.id=j.action_template_id
      WHERE j.player_id=? AND j.status='queued' ORDER BY j.queue_position,j.created_at LIMIT 1
    `).get(playerId) as { id: string; duration_seconds: number } | undefined;
    if (!next) return false;
    const startedAt = at.toISOString();
    const completesAt = new Date(at.getTime() + next.duration_seconds * 1000).toISOString();
    this.db.prepare("UPDATE action_jobs SET status='running',queue_position=0,started_at=?,completes_at=?,updated_at=? WHERE id=?")
      .run(startedAt, completesAt, startedAt, next.id);
    this.db.prepare("UPDATE action_jobs SET queue_position=queue_position-1 WHERE player_id=? AND status='queued' AND queue_position>0")
      .run(playerId);
    return true;
  }

  private settleActionQueueInternal(playerId: string, at: Date) {
    this.getPlayerRow(playerId);
    this.settleNeedsInternal(playerId, at);
    let completed = 0;
    for (let guard = 0; guard < 32; guard += 1) {
      const running = this.db.prepare(`
        SELECT j.id,t.name AS action_name,j.player_id,j.action_template_id,j.target_player_id,j.target_location_id,
          j.status,j.queue_position,j.duration_seconds,j.started_at,j.completes_at,j.result_text,j.reserved_json,j.context_json
        FROM action_jobs j JOIN action_templates t ON t.id=j.action_template_id
        WHERE j.player_id=? AND j.status='running' LIMIT 1
      `).get(playerId) as ActionJobRow | undefined;
      if (!running) {
        if (!this.startNextQueuedJob(playerId, at)) break;
        continue;
      }
      if (!running.completes_at || new Date(running.completes_at).getTime() > at.getTime()) break;
      const completedAt = new Date(running.completes_at);
      this.applyActionOutcome(playerId, running, completedAt);
      completed += 1;
      this.startNextQueuedJob(playerId, completedAt);
    }
    return completed;
  }

  settleActionQueue(playerId: string, offline = false) {
    return inTransaction(this.db, () => ({
      completed: this.settleActionQueueInternal(playerId, this.now()),
      offline,
    }));
  }

  settleDueActions(playerId: string) {
    const due = this.db.prepare(`
      SELECT 1 FROM action_jobs WHERE player_id=? AND status='running' AND completes_at<=? LIMIT 1
    `).get(playerId, this.now().toISOString());
    return due ? this.settleActionQueue(playerId, false).completed : 0;
  }

  private unavailableReason(playerId: string, template: ActionTemplateRow) {
    const requirements = parseRequirements(template.requirements_json);
    const player = this.getPlayerRow(playerId);
    if (requirements.attribute && player[requirements.attribute] < (requirements.minimumAttribute ?? 0)) {
      return `${requirements.attribute}需要达到${requirements.minimumAttribute}`;
    }
    if (requirements.skillId && this.skillLevel(playerId, requirements.skillId) < (requirements.minimumSkillLevel ?? 0)) {
      return `技能熟练度需要达到${requirements.minimumSkillLevel}`;
    }
    return null;
  }

  private readActionState(playerId: string): ActionSystemState {
    const player = this.getPlayer(playerId);
    const needs = player.needs;
    const rows = this.db.prepare(`
      SELECT t.id,b.id AS binding_id,t.name,t.description,t.category,t.target_kind,t.duration_seconds,
        t.requirements_json,t.check_json,t.costs_json,t.outcomes_json,t.result_template,t.adult,
        t.visibility,t.cooldown_seconds,t.version
      FROM location_action_bindings b JOIN action_templates t ON t.id=b.action_template_id
      WHERE b.location_id=? AND b.is_active=1 AND t.is_active=1
      ORDER BY b.priority DESC,t.category,t.name,t.id
    `).all(player.currentLocation) as ActionTemplateRow[];
    const jobs = this.actionJobs(playerId);
    return {
      available: rows.map((row) => {
        const check = parseCheck(row.check_json);
        const outcomes = parseOutcomes(row.outcomes_json);
        const reason = this.unavailableReason(playerId, row);
        return {
          id: row.id,
          bindingId: row.binding_id,
          name: row.name,
          description: row.description,
          category: row.category,
          targetKind: row.target_kind,
          durationSeconds: row.duration_seconds,
          successChance: actionSuccessChance({
            attributes: player.attributes,
            skillLevel: this.skillLevel(playerId, check.skillId),
            needs,
            check,
          }),
          adult: row.adult === 1,
          visibility: row.visibility,
          available: reason === null,
          unavailableReason: reason,
          outcomeSummary: actionOutcomeSummary(outcomes.success),
        };
      }),
      current: jobs.find((job) => job.status === "running" || job.status === "paused") ?? null,
      queued: jobs.filter((job) => job.status === "queued"),
      maxQueued: 8,
      needs,
      needPenalty: needPenalty(needs),
    };
  }

  getActionState(playerId: string) {
    this.settleActionQueue(playerId);
    return this.readActionState(playerId);
  }

  getQinggongTargets(playerId: string): QinggongTarget[] {
    const player = this.getPlayer(playerId);
    const source = this.getLocation(player.currentLocation);
    const range = Math.min(7, 2 + Math.floor(this.skillLevel(playerId, "qinggong") / 20));
    const rows = this.db.prepare(`
      ${this.locationSelect()} WHERE l.is_active=1 AND l.layer_id=?
        AND l.grid_x BETWEEN ? AND ? AND l.grid_y BETWEEN ? AND ? AND l.id<>?
      ORDER BY l.grid_y,l.grid_x,l.id
    `).all(
      source.layerId, source.gridX - range, source.gridX + range,
      source.gridY - range, source.gridY + range, source.id,
    ) as LocationRow[];
    return rows.flatMap((row): QinggongTarget[] => {
      const location = mapLocation(row);
      const dx = location.gridX - source.gridX;
      const dy = location.gridY - source.gridY;
      const distance = Math.max(Math.abs(dx), Math.abs(dy));
      const direction = straightDirection(dx, dy);
      if (!direction || distance < 2 || distance > range) return [];
      return [{
        locationId: location.id,
        locationName: location.name,
        direction,
        distance,
        durationSeconds: 15 + 10 * distance,
      }];
    });
  }

  startQinggong(playerId: string, destinationId: string) {
    return inTransaction(this.db, () => {
      const player = this.getPlayerRow(playerId);
      const target = this.getQinggongTargets(playerId).find((item) => item.locationId === destinationId);
      if (!target) throw new Error("轻功只能前往同层二至七格内的八方向直线地点。");
      const queued = this.enqueueSystemJob({
        playerId,
        templateId: "action-qinggong",
        durationSeconds: target.durationSeconds,
        context: { sourceLocationId: player.current_location, destinationId },
      });
      return {
        actionState: this.readActionState(playerId),
        message: queued.running ? `前往${target.locationName}的轻功已加入等待队列。` : `开始施展轻功前往${target.locationName}。`,
      };
    });
  }

  startAction(playerId: string, actionTemplateId: string) {
    return inTransaction(this.db, () => {
      const now = this.now();
      this.settleActionQueueInternal(playerId, now);
      const player = this.getPlayerRow(playerId);
      const template = this.db.prepare(`
        SELECT t.id,b.id AS binding_id,t.name,t.description,t.category,t.target_kind,t.duration_seconds,
          t.requirements_json,t.check_json,t.costs_json,t.outcomes_json,t.result_template,t.adult,
          t.visibility,t.cooldown_seconds,t.version
        FROM location_action_bindings b JOIN action_templates t ON t.id=b.action_template_id
        WHERE b.location_id=? AND b.action_template_id=? AND b.is_active=1 AND t.is_active=1
      `).get(player.current_location, actionTemplateId) as ActionTemplateRow | undefined;
      if (!template) throw new Error("这里无法进行这项行动。");
      const reason = this.unavailableReason(playerId, template);
      if (reason) throw new Error(reason);
      if (template.target_kind === "player") throw new Error("这项行动需要先选择目标。");
      const jobs = this.actionJobs(playerId);
      const queuedCount = jobs.filter((job) => job.status === "queued").length;
      if (queuedCount >= 8) throw new Error("等待队列最多只能安排8项行动。");
      const running = jobs.some((job) => job.status === "running" || job.status === "paused");
      const id = randomUUID();
      const timestamp = now.toISOString();
      const position = running ? queuedCount + 1 : 0;
      const status = running ? "queued" : "running";
      const completesAt = running ? null : new Date(now.getTime() + template.duration_seconds * 1000).toISOString();
      this.db.prepare(`
        INSERT INTO action_jobs(
          id,player_id,action_template_id,binding_id,target_location_id,status,queue_position,
          started_at,completes_at,duration_seconds,reserved_json,context_json,created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,'{}','{}',?,?)
      `).run(
        id, playerId, template.id, template.binding_id, player.current_location, status, position,
        running ? null : timestamp, completesAt, template.duration_seconds, timestamp, timestamp,
      );
      if (!running && template.duration_seconds === 0) this.settleActionQueueInternal(playerId, now);
      return {
        actionState: this.readActionState(playerId),
        message: running
          ? `${template.name}已加入等待队列。`
          : template.duration_seconds === 0
            ? `${template.name}完成。`
            : `${template.name}已经开始。`,
      };
    });
  }

  cancelAction(playerId: string, jobId: string) {
    return inTransaction(this.db, () => {
      const now = this.now();
      this.settleActionQueueInternal(playerId, now);
      const job = this.db.prepare("SELECT status FROM action_jobs WHERE id=? AND player_id=?").get(jobId, playerId) as { status: string } | undefined;
      if (!job || !["running", "queued", "paused"].includes(job.status)) throw new Error("这项行动已经无法取消。");
      this.db.prepare("UPDATE action_jobs SET status='cancelled',updated_at=? WHERE id=?").run(now.toISOString(), jobId);
      this.db.prepare("DELETE FROM item_reservations WHERE job_id=?").run(jobId);
      if (job.status === "running") this.startNextQueuedJob(playerId, now);
      const queued = this.db.prepare("SELECT id FROM action_jobs WHERE player_id=? AND status='queued' ORDER BY queue_position,created_at").all(playerId) as Array<{ id: string }>;
      const update = this.db.prepare("UPDATE action_jobs SET queue_position=? WHERE id=?");
      queued.forEach((row, index) => update.run(index + 1, row.id));
      return { actionState: this.readActionState(playerId), message: "行动已取消。" };
    });
  }

  reorderActionQueue(playerId: string, jobIds: string[]) {
    return inTransaction(this.db, () => {
      this.settleActionQueueInternal(playerId, this.now());
      const current = (this.db.prepare("SELECT id FROM action_jobs WHERE player_id=? AND status='queued' ORDER BY queue_position,created_at").all(playerId) as Array<{ id: string }>).map((row) => row.id);
      if (jobIds.length !== current.length || new Set(jobIds).size !== current.length || current.some((id) => !jobIds.includes(id))) {
        throw new Error("等待队列内容已经变化，请刷新后再试。");
      }
      const update = this.db.prepare("UPDATE action_jobs SET queue_position=?,updated_at=? WHERE id=?");
      const timestamp = this.now().toISOString();
      jobIds.forEach((id, index) => update.run(index + 1, timestamp, id));
      return { actionState: this.readActionState(playerId), message: "等待队列顺序已更新。" };
    });
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

  getPrivateEvents(playerId: string, limit = 12): PrivateEvent[] {
    return (this.db.prepare(`
      SELECT id,event_type,content,created_at FROM private_events
      WHERE player_id=? ORDER BY id DESC LIMIT ?
    `).all(playerId, limit) as Array<{ id: number; event_type: string; content: string; created_at: string }>).map((row) => ({
      id: row.id, eventType: row.event_type, content: row.content, createdAt: row.created_at,
    }));
  }

  getRecentChat(limit = 50) {
    const rows = this.db.prepare(`
      SELECT c.id,c.player_id,p.name AS player_name,c.content,c.created_at
      FROM chat_messages c JOIN players p ON p.id=c.player_id ORDER BY c.id DESC LIMIT ?
    `).all(limit) as Array<{ id: number; player_id: string; player_name: string; content: string; created_at: string }>;
    return rows.reverse().map((row) => ({ id: row.id, playerId: row.player_id, playerName: row.player_name, content: row.content, createdAt: row.created_at })) satisfies ChatMessage[];
  }

  getSnapshot(playerId: string, onlinePlayerIds: string[]): GameSnapshot {
    this.settleActionQueue(playerId, false);
    this.settleCultivation(playerId, false);
    const self = this.getPlayer(playerId);
    const current = this.getLocation(self.currentLocation);
    const neighborhood = this.getNeighborhood(self.currentLocation, self.visionDepth);
    const allOnlinePlayers = this.getOnlinePlayers(onlinePlayerIds);
    const visibleLocationIds = new Set(neighborhood.locations.map((location) => location.id));
    const onlinePlayers = allOnlinePlayers.filter((player) => visibleLocationIds.has(player.currentLocation));
    return {
      self, world: this.getWorldStatus(allOnlinePlayers.length), currentLayer: this.getLayer(current.layerId),
      regions: neighborhood.regions, locations: neighborhood.locations, routes: neighborhood.routes,
      transitions: this.getTransitions(self.currentLocation), actions: this.getActions([self.currentLocation]),
      actionState: this.readActionState(playerId),
      inventory: this.getInventoryState(playerId),
      qinggongTargets: this.getQinggongTargets(playerId),
      onlinePlayers, recentEvents: this.getRecentEvents(), privateEvents: this.getPrivateEvents(playerId), chatMessages: this.getRecentChat(),
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
      this.settleActionQueueInternal(playerId, this.now());
      if (this.db.prepare("SELECT 1 FROM action_jobs WHERE player_id=? AND status IN ('running','paused')").get(playerId)) {
        throw new Error("当前行动尚未完成，请先等待或取消行动。");
      }
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
