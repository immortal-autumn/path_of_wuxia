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
import { agentTokenHash } from "./npc-auth";
import { formatCashWen } from "./currency";
import type {
  ActionJob,
  ActionOutcome,
  ActionRule,
  ActionRuleLocationState,
  ActionRuleSnapshot,
  ActionSystemState,
  ActionTemplate,
  ActionDefinition,
  BaseAttributes,
  ChatMessage,
  CombatState,
  Direction,
  GameMutation,
  GameSnapshot,
  InventoryState,
  InteractionRequest,
  ItemInstance,
  Location,
  LootPile,
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
  Relationship,
  RouteType,
  SessionIdentity,
  ShopState,
  ShopSummary,
  SocialState,
  TradeOffer,
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
  id: string; name: string; title: string; hp: number; cash_wen: number; current_location: string;
  strength: number; agility: number; constitution: number; root: number; comprehension: number; spirit: number;
  unspent_points: number; realm_index: number; realm_level: number; cultivation_progress: number;
  endurance: number; training_anchor_at: string | null; training_multiplier: number;
  vision_bonus_until: string | null; vision_depth_bonus: number;
  injury_until: string | null;
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
type CombatRow = {
  id: string; location_id: string; attacker_id: string; defender_id: string; status: string; round: number;
  acting_player_id: string | null; turn_deadline: string | null; attacker_misses: number; defender_misses: number;
  winner_id: string | null; loser_id: string | null;
};
type EditableActionRule = Omit<ActionTemplate, "version">;

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
  if (outcome.cashWenDelta) parts.push(`钱贯${outcome.cashWenDelta > 0 ? "+" : "-"}${formatCashWen(Math.abs(outcome.cashWenDelta))}`);
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
  const effects: string[] = [];
  if (action.cashWenDelta) effects.push(`钱贯${action.cashWenDelta > 0 ? "+" : "-"}${formatCashWen(Math.abs(action.cashWenDelta))}`);
  if (action.hpDelta) effects.push(`气血${action.hpDelta > 0 ? "+" : ""}${action.hpDelta}`);
  return effects.join(" · ");
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

type StoredTradeOffer = { cashWen: number; items: Array<{ itemId: string; quantity: number }> };
type ShopRow = {
  id: string; location_id: string; name: string; category: string;
  opens_minute: number; closes_minute: number; till_wen: number;
};

function chinaMinuteOfDay(at: Date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(at);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}

function shopIsOpen(shop: Pick<ShopRow, "opens_minute" | "closes_minute">, at: Date) {
  const minute = chinaMinuteOfDay(at);
  if (shop.opens_minute === shop.closes_minute) return true;
  if (shop.opens_minute < shop.closes_minute) return minute >= shop.opens_minute && minute < shop.closes_minute;
  return minute >= shop.opens_minute || minute < shop.closes_minute;
}

function parseStoredTradeOffer(value: string): StoredTradeOffer {
  const parsed = JSON.parse(value) as Partial<StoredTradeOffer>;
  return {
    cashWen: Number.isInteger(parsed.cashWen) && (parsed.cashWen ?? 0) >= 0 ? parsed.cashWen! : 0,
    items: Array.isArray(parsed.items)
      ? parsed.items.flatMap((item) => (
        item && typeof item.itemId === "string" && Number.isInteger(item.quantity) && item.quantity > 0
          ? [{ itemId: item.itemId, quantity: item.quantity }]
          : []
      ))
      : [],
  };
}

export class GameService {
  constructor(
    private readonly db: GameDatabase = getGameDatabase(),
    private readonly now: () => Date = () => new Date(),
    private readonly randomPercent: () => number = () => randomInt(100),
  ) {}

  private changeCashWen(
    playerId: string,
    deltaWen: number,
    reason: string,
    referenceType: string,
    referenceId: string,
    at = this.now().toISOString(),
  ) {
    if (!Number.isSafeInteger(deltaWen)) throw new Error("钱贯变动数值不合法。");
    const wallet = this.db.prepare("SELECT cash_wen FROM player_wallets WHERE player_id=?").get(playerId) as { cash_wen: number } | undefined;
    if (!wallet) throw new Error("角色钱袋尚未建立。");
    const balance = wallet.cash_wen + deltaWen;
    if (!Number.isSafeInteger(balance) || balance < 0) throw new Error("钱贯不足。");
    this.db.prepare("UPDATE player_wallets SET cash_wen=?,updated_at=? WHERE player_id=?").run(balance, at, playerId);
    this.db.prepare(`
      INSERT INTO currency_ledger(
        id,player_id,delta_wen,balance_after_wen,reason,reference_type,reference_id,created_at
      ) VALUES (?,?,?,?,?,?,?,?)
    `).run(randomUUID(), playerId, deltaWen, balance, reason, referenceType, referenceId, at);
    return balance;
  }

  private assertCanTakeGameAction(playerId: string) {
    const player = this.getPlayerRow(playerId);
    if (player.hp <= 0) throw new Error("角色已经落败，请先返回玄关复起。");
    if (this.db.prepare(`
      SELECT 1 FROM combat_sessions WHERE status='active' AND (attacker_id=? OR defender_id=?) LIMIT 1
    `).get(playerId, playerId)) throw new Error("战斗尚未结束，当前只能选择战斗行动。");
    return player;
  }

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
    const now = this.now().getTime();
    return (this.db.prepare(`
      SELECT s.id,s.name,s.description,s.attribute_key,s.category,s.skill_kind,ps.level,ps.experience
      FROM player_skills ps JOIN skill_definitions s ON s.id=ps.skill_id
      WHERE ps.player_id=? AND s.is_active=1 ORDER BY s.skill_kind,s.category,s.id
    `).all(playerId) as Array<{
      id: string; name: string; description: string; attribute_key: keyof BaseAttributes;
      category: string; skill_kind: "active" | "passive"; level: number; experience: number;
    }>).map((row) => {
      const activeAction = row.skill_kind === "active" ? this.db.prepare(`
        SELECT t.id,t.name,t.outcomes_json,c.available_at FROM action_templates t
        LEFT JOIN player_action_cooldowns c ON c.player_id=? AND c.action_template_id=t.id
        WHERE t.is_active=1 AND t.adult=0 AND t.target_kind='self'
          AND json_extract(t.requirements_json,'$.skillId')=?
          AND (t.id='action-qinggong' OR EXISTS (
            SELECT 1 FROM location_action_bindings b JOIN players p ON p.current_location=b.location_id
            WHERE p.id=? AND b.action_template_id=t.id AND b.is_active=1
          ))
        ORDER BY t.id LIMIT 1
      `).get(playerId, row.id, playerId) as {
        id: string; name: string; outcomes_json: string; available_at: string | null;
      } | undefined : undefined;
      const activeState = row.skill_kind === "active" ? this.db.prepare(`
        SELECT active.action_template_id,active.started_at,active.expires_at,template.outcomes_json
        FROM player_active_skills active JOIN action_templates template ON template.id=active.action_template_id
        WHERE active.player_id=? AND active.skill_id=? AND active.expires_at>?
      `).get(playerId, row.id, new Date(now).toISOString()) as {
        action_template_id: string; started_at: string; expires_at: string; outcomes_json: string;
      } | undefined : undefined;
      const durationSource = activeAction?.outcomes_json ?? activeState?.outcomes_json;
      return {
        id: row.id, name: row.name, description: row.description, attributeKey: row.attribute_key,
        category: row.category, kind: row.skill_kind, level: row.level, experience: row.experience,
        effectDurationSeconds: durationSource ? parseOutcomes(durationSource).success.statusDurationSeconds ?? 0 : 0,
        cooldownUntil: activeAction?.available_at && new Date(activeAction.available_at).getTime() > now
          ? activeAction.available_at : null,
        activeStartedAt: activeState?.started_at ?? null,
        activeUntil: activeState?.expires_at ?? null,
        activeActionId: activeAction?.id ?? null, activeActionName: activeAction?.name ?? null,
      };
    });
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
      this.assertCanTakeGameAction(playerId);
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
      this.assertCanTakeGameAction(playerId);
      const changed = this.db.prepare("UPDATE item_instances SET equipped_slot=NULL,updated_at=? WHERE id=? AND owner_player_id=? AND equipped_slot IS NOT NULL")
        .run(this.now().toISOString(), itemInstanceId, playerId).changes;
      if (!changed) throw new Error("这件物品当前没有装备。");
      return { inventory: this.getInventoryState(playerId), player: this.getPlayer(playerId), message: "物品已卸下。" };
    });
  }

  useItem(playerId: string, itemInstanceId: string) {
    return inTransaction(this.db, () => {
      this.assertCanTakeGameAction(playerId);
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
    targetPlayerId = null,
    inputs = {},
  }: {
    playerId: string;
    templateId: string;
    durationSeconds: number;
    context: Record<string, unknown>;
    targetPlayerId?: string | null;
    inputs?: Record<string, number>;
  }) {
    this.assertCanTakeGameAction(playerId);
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
        id,player_id,action_template_id,target_player_id,target_location_id,status,queue_position,started_at,completes_at,
        duration_seconds,reserved_json,context_json,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,'{}',?,?,?)
    `).run(
      id, playerId, templateId, targetPlayerId, player.current_location, running ? "queued" : "running", running ? queuedCount + 1 : 0,
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

  private shopForPlayer(playerId: string, shopId: string) {
    const row = this.db.prepare(`
      SELECT shop.id,shop.location_id,shop.name,shop.category,shop.opens_minute,shop.closes_minute,shop.till_wen
      FROM players player
      JOIN shop_service_locations service_location ON service_location.location_id=player.current_location
      JOIN shops shop ON shop.id=service_location.shop_id AND shop.is_active=1
      WHERE player.id=? AND shop.id=?
    `).get(playerId, shopId) as ShopRow | undefined;
    if (!row) throw new Error("这家店铺不在当前位置。");
    return row;
  }

  private assertShopMutationAllowed(playerId: string, shopId: string) {
    this.assertCanTakeGameAction(playerId);
    if (this.db.prepare("SELECT 1 FROM action_jobs WHERE player_id=? AND status IN ('running','paused') LIMIT 1").get(playerId)) {
      throw new Error("进行中的行动结束或取消后才能买卖。");
    }
    const shop = this.shopForPlayer(playerId, shopId);
    if (!shopIsOpen(shop, this.now())) throw new Error("店铺当前已经打烊。");
    return shop;
  }

  getCurrentShopSummary(playerId: string): ShopSummary | null {
    const player = this.getPlayerRow(playerId);
    const shop = this.db.prepare(`
      SELECT shop.id,shop.location_id,shop.name,shop.category,shop.opens_minute,shop.closes_minute,shop.till_wen
      FROM shop_service_locations service_location JOIN shops shop ON shop.id=service_location.shop_id
      WHERE service_location.location_id=? AND shop.is_active=1
    `).get(player.current_location) as ShopRow | undefined;
    return shop ? { id: shop.id, name: shop.name, category: shop.category, isOpen: shopIsOpen(shop, this.now()) } : null;
  }

  inspectShop(playerId: string, shopId: string): ShopState {
    const shop = this.shopForPlayer(playerId, shopId);
    const stock = this.db.prepare(`
      SELECT stock.item_definition_id,definition.name,definition.description,definition.category,
        stock.quantity,stock.buy_price_wen,stock.sell_price_wen
      FROM shop_stock stock JOIN item_definitions definition ON definition.id=stock.item_definition_id
      WHERE stock.shop_id=? AND definition.is_active=1 ORDER BY definition.category,definition.name,definition.id
    `).all(shop.id) as Array<{
      item_definition_id: string; name: string; description: string; category: string;
      quantity: number; buy_price_wen: number; sell_price_wen: number;
    }>;
    return {
      id: shop.id,
      locationId: shop.location_id,
      name: shop.name,
      category: shop.category,
      isOpen: shopIsOpen(shop, this.now()),
      opensMinute: shop.opens_minute,
      closesMinute: shop.closes_minute,
      tillWen: shop.till_wen,
      stock: stock.map((item) => ({
        definitionId: item.item_definition_id,
        name: item.name,
        description: item.description,
        category: item.category,
        quantity: item.quantity,
        buyPriceWen: item.buy_price_wen,
        sellPriceWen: item.sell_price_wen,
      })),
    };
  }

  private shopPayloadHash(payload: Record<string, unknown>) {
    return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  }

  private replayedShopTransaction(playerId: string, requestId: string, payloadHash: string) {
    const prior = this.db.prepare(`
      SELECT payload_hash FROM shop_transactions WHERE player_id=? AND request_id=?
    `).get(playerId, requestId) as { payload_hash: string } | undefined;
    if (!prior) return false;
    if (prior.payload_hash !== payloadHash) throw new Error("同一请求编号不能用于不同的店铺交易。");
    return true;
  }

  buyFromShop(playerId: string, requestId: string, shopId: string, definitionId: string, quantity: number) {
    return inTransaction(this.db, () => {
      const payloadHash = this.shopPayloadHash({ side: "buy", shopId, definitionId, quantity });
      if (this.replayedShopTransaction(playerId, requestId, payloadHash)) {
        return { shop: this.inspectShop(playerId, shopId), inventory: this.getInventoryState(playerId), player: this.getPlayer(playerId), message: "这笔购买已经完成。" };
      }
      const shop = this.assertShopMutationAllowed(playerId, shopId);
      const stock = this.db.prepare(`
        SELECT quantity,buy_price_wen FROM shop_stock WHERE shop_id=? AND item_definition_id=?
      `).get(shop.id, definitionId) as { quantity: number; buy_price_wen: number } | undefined;
      if (!stock) throw new Error("店铺没有经营这种货物。");
      if (stock.quantity < quantity) throw new Error("店铺库存不足。");
      const totalWen = stock.buy_price_wen * quantity;
      if (!Number.isSafeInteger(totalWen) || totalWen <= 0) throw new Error("购买金额不合法。");
      const at = this.now().toISOString();
      this.changeCashWen(playerId, -totalWen, `在${shop.name}购物`, "shop-buy", requestId, at);
      const changed = this.db.prepare(`
        UPDATE shop_stock SET quantity=quantity-?,updated_at=?
        WHERE shop_id=? AND item_definition_id=? AND quantity>=?
      `).run(quantity, at, shop.id, definitionId, quantity);
      if (changed.changes !== 1) throw new Error("店铺库存刚刚发生变化，请重试。");
      this.db.prepare("UPDATE shops SET till_wen=till_wen+?,updated_at=? WHERE id=?").run(totalWen, at, shop.id);
      this.grantItem(playerId, definitionId, quantity, 1, false, at);
      this.db.prepare(`
        INSERT INTO shop_transactions(
          id,request_id,shop_id,player_id,side,item_definition_id,quantity,unit_price_wen,total_wen,payload_hash,created_at
        ) VALUES (?,?,?,?,'buy',?,?,?,?,?,?)
      `).run(randomUUID(), requestId, shop.id, playerId, definitionId, quantity, stock.buy_price_wen, totalWen, payloadHash, at);
      return { shop: this.inspectShop(playerId, shopId), inventory: this.getInventoryState(playerId), player: this.getPlayer(playerId), message: `已花费${formatCashWen(totalWen)}购得${quantity}件货物。` };
    });
  }

  sellToShop(playerId: string, requestId: string, shopId: string, itemId: string, quantity: number) {
    return inTransaction(this.db, () => {
      const payloadHash = this.shopPayloadHash({ side: "sell", shopId, itemId, quantity });
      if (this.replayedShopTransaction(playerId, requestId, payloadHash)) {
        return { shop: this.inspectShop(playerId, shopId), inventory: this.getInventoryState(playerId), player: this.getPlayer(playerId), message: "这笔出售已经完成。" };
      }
      const shop = this.assertShopMutationAllowed(playerId, shopId);
      const item = this.db.prepare(`
        SELECT instance.id,instance.definition_id,instance.quantity,instance.bound,instance.equipped_slot,
          COALESCE((SELECT SUM(quantity) FROM item_reservations WHERE item_instance_id=instance.id),0) AS reserved
        FROM item_instances instance WHERE instance.id=? AND instance.owner_player_id=?
      `).get(itemId, playerId) as {
        id: string; definition_id: string; quantity: number; bound: number; equipped_slot: string | null; reserved: number;
      } | undefined;
      if (!item) throw new Error("要出售的物品已经不存在。");
      if (item.bound) throw new Error("绑定物品不能出售。");
      if (item.equipped_slot) throw new Error("请先卸下物品再出售。");
      if (quantity > item.quantity - item.reserved) throw new Error("可出售数量不足或物品已被行动预留。");
      const stock = this.db.prepare(`
        SELECT sell_price_wen FROM shop_stock WHERE shop_id=? AND item_definition_id=?
      `).get(shop.id, item.definition_id) as { sell_price_wen: number } | undefined;
      if (!stock) throw new Error("这家店不收购这种物品。");
      const totalWen = stock.sell_price_wen * quantity;
      if (!Number.isSafeInteger(totalWen) || totalWen <= 0) throw new Error("出售金额不合法。");
      if (shop.till_wen < totalWen) throw new Error("店铺柜上现钱不足，暂时无法收购。");
      const at = this.now().toISOString();
      if (quantity === item.quantity) this.db.prepare("DELETE FROM item_instances WHERE id=?").run(item.id);
      else this.db.prepare("UPDATE item_instances SET quantity=quantity-?,updated_at=? WHERE id=?").run(quantity, at, item.id);
      this.db.prepare("UPDATE shop_stock SET quantity=quantity+?,updated_at=? WHERE shop_id=? AND item_definition_id=?")
        .run(quantity, at, shop.id, item.definition_id);
      this.db.prepare("UPDATE shops SET till_wen=till_wen-?,updated_at=? WHERE id=?").run(totalWen, at, shop.id);
      this.changeCashWen(playerId, totalWen, `向${shop.name}售货`, "shop-sell", requestId, at);
      this.db.prepare(`
        INSERT INTO shop_transactions(
          id,request_id,shop_id,player_id,side,item_definition_id,quantity,unit_price_wen,total_wen,payload_hash,created_at
        ) VALUES (?,?,?,?,'sell',?,?,?,?,?,?)
      `).run(randomUUID(), requestId, shop.id, playerId, item.definition_id, quantity, stock.sell_price_wen, totalWen, payloadHash, at);
      return { shop: this.inspectShop(playerId, shopId), inventory: this.getInventoryState(playerId), player: this.getPlayer(playerId), message: `已售得${formatCashWen(totalWen)}。` };
    });
  }

  private playerSelect() {
    return `
      SELECT p.id,p.name,p.title,p.hp,wallet.cash_wen,p.current_location,
             pr.strength,pr.agility,pr.constitution,pr.root,pr.comprehension,pr.spirit,
             pr.unspent_points,pr.realm_index,pr.realm_level,pr.cultivation_progress,
             pr.endurance,pr.training_anchor_at,COALESCE(le.multiplier,0) AS training_multiplier,
             p.vision_bonus_until,p.vision_depth_bonus,p.injury_until
      FROM players p JOIN player_progression pr ON pr.player_id=p.id
      JOIN player_wallets wallet ON wallet.player_id=p.id
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
      cashWen: row.cash_wen, currentLocation: row.current_location, attributes, derived,
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
      defeated: row.hp <= 0,
      injuryUntil: row.injury_until,
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
      this.db.prepare("INSERT INTO player_wallets(player_id,cash_wen,updated_at) VALUES (?,20000,?)").run(playerId, createdAt);
      this.db.prepare(`
        INSERT INTO currency_ledger(
          id,player_id,delta_wen,balance_after_wen,reason,reference_type,reference_id,created_at
        ) VALUES (?,?,20000,20000,'初始钱贯','opening','player',?)
      `).run(randomUUID(), playerId, createdAt);
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

  getPlayerByAgentToken(token: string | undefined) {
    if (!token) return null;
    const row = this.db.prepare(`
      SELECT p.id FROM agent_credentials credential JOIN players p ON p.id=credential.player_id
      WHERE credential.token_hash=? AND credential.revoked_at IS NULL
        AND (credential.expires_at IS NULL OR credential.expires_at>?) AND p.controller_kind='npc'
    `).get(agentTokenHash(token), this.now().toISOString()) as { id: string } | undefined;
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
    const fastTravelDestinationIds = (this.db.prepare(`
      SELECT location.id FROM locations location
      JOIN player_visited_locations visited ON visited.location_id=location.id AND visited.player_id=?
      JOIN location_facilities facility ON facility.location_id=location.id
        AND facility.facility_type='fast-travel' AND facility.is_active=1
      WHERE location.is_active=1
      ORDER BY location.layer_id,location.name,location.id
    `).all(playerId) as Array<{ id: string }>).map((row) => row.id);
    return {
      layers: this.getLayers().filter((layer) => visitedLayerIds.has(layer.id)),
      locations,
      routes,
      fastTravelDestinationIds,
    };
  }

  getActions(locationIds?: string[]) {
    let sql = `
      SELECT a.id,a.location_id,a.name,a.description,a.cash_wen_delta,a.hp_delta
      FROM action_definitions a JOIN locations l ON l.id=a.location_id WHERE l.is_active=1
    `;
    const params: string[] = [];
    if (locationIds) {
      if (locationIds.length === 0) return [];
      sql += ` AND a.location_id IN (${placeholders(locationIds)})`;
      params.push(...locationIds);
    }
    return (this.db.prepare(`${sql} ORDER BY a.id`).all(...params) as Array<{
      id: string; location_id: string; name: string; description: string; cash_wen_delta: number; hp_delta: number;
    }>).map((row) => ({
      id: row.id, locationId: row.location_id, name: row.name, description: row.description,
      cashWenDelta: row.cash_wen_delta, hpDelta: row.hp_delta,
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
    if (template.target_kind === "player") {
      const target = job.target_player_id
        ? this.db.prepare("SELECT current_location,adult_status,adult_content_enabled FROM players WHERE id=?").get(job.target_player_id) as {
            current_location: string; adult_status: string; adult_content_enabled: number;
          } | undefined
        : undefined;
      if (!target || (requirements.sameLocation && target.current_location !== row.current_location)) success = false;
      if (template.adult === 1 && (
        !target || target.adult_status !== "adult" || target.adult_content_enabled !== 1
        || (this.db.prepare("SELECT adult_status,adult_content_enabled FROM players WHERE id=?").get(playerId) as { adult_status: string; adult_content_enabled: number }).adult_status !== "adult"
        || (this.db.prepare("SELECT adult_content_enabled FROM players WHERE id=?").get(playerId) as { adult_content_enabled: number }).adult_content_enabled !== 1
      )) success = false;
    }
    const outcome = success ? outcomes.success : outcomes.failure;
    const timestamp = completedAt.toISOString();
    const nextNeeds = applyNeedDeltas(needs, outcome.needDeltas);
    nextNeeds.updatedAt = timestamp;
    this.writeNeeds(playerId, nextNeeds);

    const derived = deriveStats(attributes, row.realm_index);
    const hp = Math.max(0, Math.min(derived.maxHp, row.hp + (outcome.hpDelta ?? 0)));
    this.db.prepare("UPDATE players SET hp=?,updated_at=?,last_seen_at=? WHERE id=?")
      .run(hp, timestamp, timestamp, playerId);
    if (outcome.cashWenDelta) {
      this.changeCashWen(playerId, outcome.cashWenDelta, template.name, "action-job", job.id, timestamp);
    }

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
    const content = `${template.result_template.replaceAll("{name}", row.name)} ${resultDetail}${success ? "成功" : "失败"}。${privateDetail}`;
    this.db.prepare(`
      INSERT INTO action_logs(player_id,kind,action_template_id,action_job_id,from_location,to_location,result_text,created_at)
      VALUES (?,'action',?,?,?,?,?,?)
    `).run(playerId, template.id, job.id, row.current_location, row.current_location, content, timestamp);
    if (template.visibility === "public") {
      this.db.prepare("INSERT INTO world_events(player_id,event_type,content,created_at) VALUES (?,'action',?,?)")
        .run(playerId, content, timestamp);
    } else {
      this.db.prepare("INSERT INTO private_events(player_id,event_type,content,created_at) VALUES (?,'action',?,?)")
        .run(playerId, content, timestamp);
      if (template.visibility === "participants" && job.target_player_id && job.target_player_id !== playerId) {
        this.db.prepare("INSERT INTO private_events(player_id,event_type,content,created_at) VALUES (?,'action',?,?)")
          .run(job.target_player_id, content, timestamp);
      }
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

  private activeSkillIdForTemplate(template: ActionTemplateRow) {
    const skillId = parseRequirements(template.requirements_json).skillId;
    if (!skillId) return null;
    const skill = this.db.prepare("SELECT skill_kind FROM skill_definitions WHERE id=? AND is_active=1").get(skillId) as {
      skill_kind: string;
    } | undefined;
    return skill?.skill_kind === "active" ? skillId : null;
  }

  private readActionState(playerId: string): ActionSystemState {
    const player = this.getPlayer(playerId);
    const needs = player.needs;
    const rows = (this.db.prepare(`
      SELECT t.id,b.id AS binding_id,t.name,t.description,t.category,t.target_kind,t.duration_seconds,
        t.requirements_json,t.check_json,t.costs_json,t.outcomes_json,t.result_template,t.adult,
        t.visibility,t.cooldown_seconds,t.version
      FROM location_action_bindings b JOIN action_templates t ON t.id=b.action_template_id
      WHERE b.location_id=? AND b.is_active=1 AND t.is_active=1
      ORDER BY b.priority DESC,t.category,t.name,t.id
    `).all(player.currentLocation) as ActionTemplateRow[]).filter((row) => this.activeSkillIdForTemplate(row) === null);
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

  private mapActionRule(row: {
    id: string; name: string; description: string; category: ActionTemplate["category"];
    target_kind: ActionTemplate["targetKind"]; duration_seconds: number; requirements_json: string;
    check_json: string; costs_json: string; outcomes_json: string; result_template: string; adult: number;
    visibility: ActionTemplate["visibility"]; cooldown_seconds: number; version: number; is_active: number; seed_revision: number;
  }): ActionRule {
    const outcomes = parseOutcomes(row.outcomes_json);
    return {
      id: row.id, name: row.name, description: row.description, category: row.category,
      targetKind: row.target_kind, durationSeconds: row.duration_seconds,
      requirements: parseRequirements(row.requirements_json), check: parseCheck(row.check_json),
      costs: actionOutcomeSchema.parse(JSON.parse(row.costs_json)), success: outcomes.success, failure: outcomes.failure,
      resultTemplate: row.result_template, adult: row.adult === 1, visibility: row.visibility,
      cooldownSeconds: row.cooldown_seconds, version: row.version, isActive: row.is_active === 1, seedRevision: row.seed_revision,
    };
  }

  getActionRuleSnapshot(): ActionRuleSnapshot {
    const actions = (this.db.prepare(`
      SELECT id,name,description,category,target_kind,duration_seconds,requirements_json,check_json,costs_json,
        outcomes_json,result_template,adult,visibility,cooldown_seconds,version,is_active,seed_revision
      FROM action_templates WHERE is_active=1 ORDER BY category,name,id
    `).all() as Parameters<GameService["mapActionRule"]>[0][]).map((row) => this.mapActionRule(row));
    return { actions, layers: this.getLayers() };
  }

  private validateEditableActionRule(action: EditableActionRule) {
    const name = cleanText(action.name, "行动名称", 80);
    const description = cleanText(action.description, "行动说明", 400);
    const resultTemplate = cleanText(action.resultTemplate, "结果文本", 800);
    const requirements = parseRequirements(JSON.stringify(action.requirements));
    const check = parseCheck(JSON.stringify(action.check));
    const costs = actionOutcomeSchema.parse(action.costs);
    const success = actionOutcomeSchema.parse(action.success);
    const failure = actionOutcomeSchema.parse(action.failure);
    if (action.adult && (
      action.targetKind !== "player" || action.visibility !== "participants"
      || requirements.sameLocation !== true || requirements.targetOnline !== true
    )) throw new Error("成人规则必须以在线同地点玩家为目标，并且只对双方参与者可见。");
    return { ...action, name, description, resultTemplate, requirements, check, costs, success, failure };
  }

  createActionRule(action: EditableActionRule) {
    return inTransaction(this.db, () => {
      if (this.db.prepare("SELECT 1 FROM action_templates WHERE id=?").get(action.id)) throw new Error("行动规则 ID 已存在。");
      const safe = this.validateEditableActionRule(action);
      const timestamp = this.now().toISOString();
      this.db.prepare(`
        INSERT INTO action_templates(
          id,name,description,category,target_kind,duration_seconds,requirements_json,check_json,costs_json,
          outcomes_json,result_template,adult,visibility,cooldown_seconds,version,is_active,seed_revision,created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,1,0,?,?)
      `).run(
        safe.id, safe.name, safe.description, safe.category, safe.targetKind, safe.durationSeconds,
        JSON.stringify(safe.requirements), JSON.stringify(safe.check), JSON.stringify(safe.costs),
        JSON.stringify({ success: safe.success, failure: safe.failure }), safe.resultTemplate,
        safe.adult ? 1 : 0, safe.visibility, safe.cooldownSeconds, timestamp, timestamp,
      );
      return { rules: this.getActionRuleSnapshot(), message: "行动规则已创建。" };
    });
  }

  updateActionRule(actionId: string, expectedVersion: number, action: Omit<EditableActionRule, "id">) {
    return inTransaction(this.db, () => {
      const safe = this.validateEditableActionRule({ ...action, id: actionId });
      const timestamp = this.now().toISOString();
      const changed = this.db.prepare(`
        UPDATE action_templates SET name=?,description=?,category=?,target_kind=?,duration_seconds=?,requirements_json=?,
          check_json=?,costs_json=?,outcomes_json=?,result_template=?,adult=?,visibility=?,cooldown_seconds=?,
          version=version+1,seed_revision=0,updated_at=? WHERE id=? AND version=? AND is_active=1
      `).run(
        safe.name, safe.description, safe.category, safe.targetKind, safe.durationSeconds,
        JSON.stringify(safe.requirements), JSON.stringify(safe.check), JSON.stringify(safe.costs),
        JSON.stringify({ success: safe.success, failure: safe.failure }), safe.resultTemplate,
        safe.adult ? 1 : 0, safe.visibility, safe.cooldownSeconds, timestamp, actionId, expectedVersion,
      ).changes;
      if (!changed) throw new Error("行动规则已被其他编辑者修改，请刷新后重试。");
      return { rules: this.getActionRuleSnapshot(), message: "行动规则已保存。" };
    });
  }

  deleteActionRule(actionId: string) {
    return inTransaction(this.db, () => {
      if (this.db.prepare("SELECT 1 FROM action_jobs WHERE action_template_id=? AND status IN ('running','queued','paused')").get(actionId)) {
        throw new Error("仍有角色正在使用这条行动规则。");
      }
      const timestamp = this.now().toISOString();
      const changed = this.db.prepare(`
        UPDATE action_templates SET is_active=0,seed_revision=0,version=version+1,updated_at=? WHERE id=? AND is_active=1
      `).run(timestamp, actionId).changes;
      if (!changed) throw new Error("行动规则不存在或已经删除。");
      this.db.prepare("UPDATE location_action_bindings SET is_active=0,seed_revision=0,updated_at=? WHERE action_template_id=?")
        .run(timestamp, actionId);
      return { rules: this.getActionRuleSnapshot(), message: "行动规则已停用。" };
    });
  }

  getActionRuleLocationState(locationId: string): ActionRuleLocationState {
    const location = this.getLocation(locationId);
    const facilities = (this.db.prepare(`
      SELECT id,location_id,facility_type,quality,capacity,config_json,version FROM location_facilities
      WHERE location_id=? AND is_active=1 ORDER BY facility_type,id
    `).all(locationId) as Array<{
      id: string; location_id: string; facility_type: string; quality: number; capacity: number; config_json: string; version: number;
    }>).map((row) => ({
      id: row.id, locationId: row.location_id, facilityType: row.facility_type, quality: row.quality,
      capacity: row.capacity, config: JSON.parse(row.config_json) as Record<string, unknown>, version: row.version,
    }));
    const bindings = (this.db.prepare(`
      SELECT b.id,b.location_id,b.action_template_id,t.name AS action_name,b.facility_id,f.facility_type,b.priority
      FROM location_action_bindings b JOIN action_templates t ON t.id=b.action_template_id
      LEFT JOIN location_facilities f ON f.id=b.facility_id
      WHERE b.location_id=? AND b.is_active=1 AND t.is_active=1 ORDER BY b.priority DESC,t.name,b.id
    `).all(locationId) as Array<{
      id: string; location_id: string; action_template_id: string; action_name: string;
      facility_id: string | null; facility_type: string | null; priority: number;
    }>).map((row) => ({
      id: row.id, locationId: row.location_id, actionId: row.action_template_id, actionName: row.action_name,
      facilityId: row.facility_id, facilityType: row.facility_type, priority: row.priority,
    }));
    return { location, facilities, bindings };
  }

  upsertActionRuleBinding(locationId: string, actionId: string, facilityId: string | null, priority = 0) {
    return inTransaction(this.db, () => {
      this.getLocation(locationId);
      const action = this.db.prepare("SELECT target_kind,adult FROM action_templates WHERE id=? AND is_active=1").get(actionId) as {
        target_kind: string; adult: number;
      } | undefined;
      if (!action) throw new Error("行动规则不存在或已停用。");
      if (action.adult || !["self", "location"].includes(action.target_kind)) {
        throw new Error("成人或需要具体目标的行动不能绑定为地点快捷行动。");
      }
      if (facilityId && !this.db.prepare("SELECT 1 FROM location_facilities WHERE id=? AND location_id=? AND is_active=1").get(facilityId, locationId)) {
        throw new Error("所选设施不属于这个地点。");
      }
      const timestamp = this.now().toISOString();
      this.db.prepare(`
        INSERT INTO location_action_bindings(
          id,location_id,action_template_id,facility_id,priority,is_active,seed_revision,created_at,updated_at
        ) VALUES (?,?,?,?,?,1,0,?,?)
        ON CONFLICT(location_id,action_template_id) DO UPDATE SET facility_id=excluded.facility_id,priority=excluded.priority,
          is_active=1,seed_revision=0,updated_at=excluded.updated_at
      `).run(randomUUID(), locationId, actionId, facilityId, priority, timestamp, timestamp);
      return { state: this.getActionRuleLocationState(locationId), message: "地点行动绑定已保存。" };
    });
  }

  deleteActionRuleBinding(bindingId: string) {
    return inTransaction(this.db, () => {
      const row = this.db.prepare("SELECT location_id FROM location_action_bindings WHERE id=? AND is_active=1").get(bindingId) as {
        location_id: string;
      } | undefined;
      if (!row) throw new Error("地点行动绑定不存在。");
      this.db.prepare("UPDATE location_action_bindings SET is_active=0,seed_revision=0,updated_at=? WHERE id=?")
        .run(this.now().toISOString(), bindingId);
      return { state: this.getActionRuleLocationState(row.location_id), message: "地点行动绑定已移除。" };
    });
  }

  private activeCooldownUntil(playerId: string, actionTemplateId: string) {
    const row = this.db.prepare(`
      SELECT available_at FROM player_action_cooldowns WHERE player_id=? AND action_template_id=?
    `).get(playerId, actionTemplateId) as { available_at: string } | undefined;
    return row && new Date(row.available_at).getTime() > this.now().getTime() ? row.available_at : null;
  }

  private activeSkillUntil(playerId: string, skillId: string) {
    const row = this.db.prepare(`
      SELECT expires_at FROM player_active_skills WHERE player_id=? AND skill_id=?
    `).get(playerId, skillId) as { expires_at: string } | undefined;
    return row && new Date(row.expires_at).getTime() > this.now().getTime() ? row.expires_at : null;
  }

  private resolveInstantSkillAction(playerId: string, template: ActionTemplateRow, destination: Location | null = null) {
    const now = this.now();
    const timestamp = now.toISOString();
    if (template.cooldown_seconds <= 0) throw new Error("主动技能尚未配置冷却时间。");
    const unavailableReason = this.unavailableReason(playerId, template);
    if (unavailableReason) throw new Error(unavailableReason);
    this.settleCultivationInternal(playerId, now, false);
    const row = this.getPlayerRow(playerId);
    const requirements = parseRequirements(template.requirements_json);
    const check = parseCheck(template.check_json);
    const outcomes = parseOutcomes(template.outcomes_json);
    const attributes: BaseAttributes = {
      strength: row.strength, agility: row.agility, constitution: row.constitution,
      root: row.root, comprehension: row.comprehension, spirit: row.spirit,
    };
    const needs = this.settleNeedsInternal(playerId, now);
    const skillId = check.skillId ?? requirements.skillId;
    const chance = actionSuccessChance({ attributes, skillLevel: this.skillLevel(playerId, skillId), needs, check });
    const success = chance >= 100 || this.randomPercent() < chance;
    const outcome = success ? outcomes.success : outcomes.failure;
    const nextNeeds = applyNeedDeltas(needs, outcome.needDeltas);
    nextNeeds.updatedAt = timestamp;
    this.writeNeeds(playerId, nextNeeds);
    const derived = deriveStats(attributes, row.realm_index);
    this.db.prepare("UPDATE players SET hp=?,updated_at=?,last_seen_at=? WHERE id=?").run(
      Math.max(0, Math.min(derived.maxHp, row.hp + (outcome.hpDelta ?? 0))),
      timestamp, timestamp, playerId,
    );
    if (outcome.cashWenDelta) {
      this.changeCashWen(playerId, outcome.cashWenDelta, template.name, "skill", template.id, timestamp);
    }
    if (outcome.cultivationDelta) {
      const advanced = this.advanceCultivation(row, outcome.cultivationDelta);
      this.db.prepare("UPDATE player_progression SET realm_level=?,cultivation_progress=?,unspent_points=?,updated_at=? WHERE player_id=?")
        .run(advanced.level, advanced.progress, advanced.unspentPoints, timestamp, playerId);
      this.db.prepare(`
        INSERT INTO cultivation_logs(player_id,kind,delta,realm_index,realm_level,detail,created_at)
        VALUES (?,'skill',?,?,?,?,?)
      `).run(playerId, outcome.cultivationDelta, row.realm_index, advanced.level, template.name, timestamp);
    }
    this.addSkillExperience(playerId, skillId, outcome.skillExperience ?? 0, timestamp);
    for (const item of outcome.items ?? []) this.grantItem(playerId, item.definitionId, item.quantity, item.quality ?? 1, item.bound ?? false, timestamp);
    const activeSkillId = this.activeSkillIdForTemplate(template);
    if (success && activeSkillId && outcome.statusDurationSeconds) {
      const expiresAt = new Date(now.getTime() + outcome.statusDurationSeconds * 1000).toISOString();
      this.db.prepare(`
        INSERT INTO player_active_skills(player_id,skill_id,action_template_id,started_at,expires_at,updated_at)
        VALUES (?,?,?,?,?,?) ON CONFLICT(player_id,skill_id) DO UPDATE SET
          action_template_id=excluded.action_template_id,started_at=excluded.started_at,
          expires_at=excluded.expires_at,updated_at=excluded.updated_at
      `).run(playerId, activeSkillId, template.id, timestamp, expiresAt, timestamp);
    }
    if (success && outcome.statusId === "eagle-eye") {
      const level = this.skillLevel(playerId, "eagle-eye");
      const bonus = Math.min(5, 1 + Math.floor(level / 20));
      this.db.prepare("UPDATE players SET vision_bonus_until=?,vision_depth_bonus=?,updated_at=? WHERE id=?").run(
        new Date(now.getTime() + Math.max(1, outcome.statusDurationSeconds ?? 1800) * 1000).toISOString(), bonus, timestamp, playerId,
      );
    }
    if (success && destination) {
      this.db.prepare("UPDATE players SET current_location=?,updated_at=?,last_seen_at=? WHERE id=?")
        .run(destination.id, timestamp, timestamp, playerId);
      this.db.prepare("UPDATE player_progression SET training_anchor_at=?,updated_at=? WHERE player_id=?")
        .run(destination.trainingMultiplier > 0 ? timestamp : null, timestamp, playerId);
      this.db.prepare(`
        INSERT INTO player_visited_locations(player_id,location_id,first_visited_at,last_visited_at)
        VALUES (?,?,?,?) ON CONFLICT(player_id,location_id) DO UPDATE SET last_visited_at=excluded.last_visited_at
      `).run(playerId, destination.id, timestamp, timestamp);
    }
    const cooldownUntil = new Date(now.getTime() + template.cooldown_seconds * 1000).toISOString();
    this.db.prepare(`
      INSERT INTO player_action_cooldowns(player_id,action_template_id,available_at,updated_at) VALUES (?,?,?,?)
      ON CONFLICT(player_id,action_template_id) DO UPDATE SET available_at=excluded.available_at,updated_at=excluded.updated_at
    `).run(playerId, template.id, cooldownUntil, timestamp);
    const destinationText = success && destination ? `，抵达${destination.name}` : "";
    const content = `${template.result_template.replaceAll("{name}", row.name)} ${template.name}${success ? "成功" : "失败"}${destinationText}。`;
    this.db.prepare(`
      INSERT INTO action_logs(player_id,kind,action_template_id,from_location,to_location,result_text,created_at)
      VALUES (?,'skill',?,?,?,?,?)
    `).run(playerId, template.id, row.current_location, success && destination ? destination.id : row.current_location, content, timestamp);
    let event: WorldEvent | null = null;
    if (template.visibility === "public") {
      const inserted = this.db.prepare("INSERT INTO world_events(player_id,event_type,content,created_at) VALUES (?,'skill',?,?)")
        .run(playerId, content, timestamp);
      event = mapEvent(this.db.prepare("SELECT id,player_id,event_type,content,created_at FROM world_events WHERE id=?").get(inserted.lastInsertRowid) as EventRow);
    } else {
      this.db.prepare("INSERT INTO private_events(player_id,event_type,content,created_at) VALUES (?,'skill',?,?)").run(playerId, content, timestamp);
    }
    return { success, event, cooldownUntil, message: `${content} 冷却至${cooldownUntil}。` };
  }

  getQinggongTargets(playerId: string): QinggongTarget[] {
    const player = this.getPlayer(playerId);
    const source = this.getLocation(player.currentLocation);
    const range = Math.min(7, 2 + Math.floor(this.skillLevel(playerId, "qinggong") / 20));
    const cooldownUntil = this.activeCooldownUntil(playerId, "action-qinggong");
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
        available: cooldownUntil === null,
        cooldownUntil,
      }];
    });
  }

  useQinggong(playerId: string, destinationId: string) {
    return inTransaction(this.db, () => {
      this.assertCanTakeGameAction(playerId);
      this.settleActionQueueInternal(playerId, this.now());
      if (this.db.prepare("SELECT 1 FROM action_jobs WHERE player_id=? AND status IN ('running','paused')").get(playerId)) {
        throw new Error("当前行动尚未完成，请先等待或取消行动。");
      }
      const target = this.getQinggongTargets(playerId).find((item) => item.locationId === destinationId);
      if (!target) throw new Error("轻功只能前往同层二至七格内的八方向直线地点。");
      if (!target.available) throw new Error(`轻功冷却中，请等待至${target.cooldownUntil}。`);
      return this.resolveInstantSkillAction(playerId, this.getTemplateRow("action-qinggong"), this.getLocation(destinationId));
    });
  }

  useActiveSkill(playerId: string, skillId: string) {
    return inTransaction(this.db, () => {
      this.assertCanTakeGameAction(playerId);
      if (skillId === "qinggong") throw new Error("请在地图上选择带轻功边框的落点。");
      const skill = this.db.prepare("SELECT skill_kind FROM skill_definitions WHERE id=? AND is_active=1").get(skillId) as {
        skill_kind: string;
      } | undefined;
      if (!skill || skill.skill_kind !== "active") throw new Error("这不是可主动发动的技能。");
      const player = this.getPlayerRow(playerId);
      const template = this.db.prepare(`
        SELECT t.id,b.id AS binding_id,t.name,t.description,t.category,t.target_kind,t.duration_seconds,
          t.requirements_json,t.check_json,t.costs_json,t.outcomes_json,t.result_template,t.adult,
          t.visibility,t.cooldown_seconds,t.version
        FROM action_templates t JOIN location_action_bindings b ON b.action_template_id=t.id
        WHERE b.location_id=? AND b.is_active=1 AND t.is_active=1 AND t.adult=0 AND t.target_kind='self'
          AND json_extract(t.requirements_json,'$.skillId')=? ORDER BY t.id LIMIT 1
      `).get(player.current_location, skillId) as ActionTemplateRow | undefined;
      if (!template) throw new Error("当前位置没有可发动的主动技能规则。");
      const reason = this.unavailableReason(playerId, template);
      if (reason) throw new Error(reason);
      const activeUntil = this.activeSkillUntil(playerId, skillId);
      if (activeUntil) throw new Error(`技能正在持续中，可先主动停止或等待至${activeUntil}。`);
      const cooldownUntil = this.activeCooldownUntil(playerId, template.id);
      if (cooldownUntil) throw new Error(`技能冷却中，请等待至${cooldownUntil}。`);
      return this.resolveInstantSkillAction(playerId, template);
    });
  }

  stopActiveSkill(playerId: string, skillId: string) {
    return inTransaction(this.db, () => {
      const player = this.getPlayerRow(playerId);
      const active = this.db.prepare(`
        SELECT active.action_template_id,active.expires_at,skill.name
        FROM player_active_skills active JOIN skill_definitions skill ON skill.id=active.skill_id
        WHERE active.player_id=? AND active.skill_id=? AND active.expires_at>?
      `).get(playerId, skillId, this.now().toISOString()) as {
        action_template_id: string; expires_at: string; name: string;
      } | undefined;
      if (!active) throw new Error("这项技能当前没有持续中的效果。");
      const timestamp = this.now().toISOString();
      this.db.prepare("DELETE FROM player_active_skills WHERE player_id=? AND skill_id=?").run(playerId, skillId);
      if (skillId === "eagle-eye") {
        this.db.prepare("UPDATE players SET vision_bonus_until=NULL,vision_depth_bonus=0,updated_at=? WHERE id=?")
          .run(timestamp, playerId);
      }
      const content = `${player.name}主动停止了${active.name}，技能冷却保持不变。`;
      this.db.prepare(`
        INSERT INTO action_logs(player_id,kind,action_template_id,from_location,to_location,result_text,created_at)
        VALUES (?,'skill-stop',?,?,?,?,?)
      `).run(playerId, active.action_template_id, player.current_location, player.current_location, content, timestamp);
      this.db.prepare("INSERT INTO private_events(player_id,event_type,content,created_at) VALUES (?,'skill-stop',?,?)")
        .run(playerId, content, timestamp);
      return { message: content };
    });
  }

  startAction(playerId: string, actionTemplateId: string) {
    return inTransaction(this.db, () => {
      this.assertCanTakeGameAction(playerId);
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
      const activeSkillId = this.activeSkillIdForTemplate(template);
      if (activeSkillId) {
        throw new Error(activeSkillId === "qinggong" ? "请在地图上选择轻功落点。" : "请从角色属性栏的技能页发动这项技能。");
      }
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

  private cleanupExpiredSocial(at = this.now()) {
    const timestamp = at.toISOString();
    this.db.prepare("UPDATE interaction_requests SET status='expired',updated_at=? WHERE status='pending' AND expires_at<=?")
      .run(timestamp, timestamp);
    this.db.prepare("UPDATE trade_sessions SET status='expired',updated_at=? WHERE status IN ('pending','active') AND expires_at<=?")
      .run(timestamp, timestamp);
  }

  private assertDirectInteraction(playerId: string, targetPlayerId: string) {
    if (playerId === targetPlayerId) throw new Error("不能把自己作为互动目标。");
    const rows = this.db.prepare("SELECT id,name,current_location FROM players WHERE id IN (?,?)").all(playerId, targetPlayerId) as Array<{
      id: string; name: string; current_location: string;
    }>;
    const player = rows.find((row) => row.id === playerId);
    const target = rows.find((row) => row.id === targetPlayerId);
    if (!player || !target) throw new Error("互动目标不存在。");
    this.assertCanTakeGameAction(playerId);
    this.assertCanTakeGameAction(targetPlayerId);
    if (player.current_location !== target.current_location) throw new Error("双方必须在同一地点才能直接互动。");
    if (this.db.prepare(`
      SELECT 1 FROM player_blocks WHERE (player_id=? AND blocked_player_id=?) OR (player_id=? AND blocked_player_id=?)
    `).get(playerId, targetPlayerId, targetPlayerId, playerId)) throw new Error("当前无法与对方互动。");
    return { player, target };
  }

  private assertAdultConsentReady(playerId: string, targetPlayerId: string) {
    const rows = this.db.prepare("SELECT id,adult_status,adult_content_enabled FROM players WHERE id IN (?,?)").all(playerId, targetPlayerId) as Array<{
      id: string; adult_status: string; adult_content_enabled: number;
    }>;
    if (rows.length !== 2 || rows.some((row) => row.adult_status !== "adult" || row.adult_content_enabled !== 1)) {
      throw new Error("成人互动要求双方确认成年并开启成人内容。");
    }
  }

  updateAdultProfile(playerId: string, adultStatus: "unknown" | "adult" | "minor", adultContentEnabled: boolean) {
    return inTransaction(this.db, () => {
      this.getPlayerRow(playerId);
      const enabled = adultStatus === "adult" && adultContentEnabled;
      const timestamp = this.now().toISOString();
      this.db.prepare("UPDATE players SET adult_status=?,adult_content_enabled=?,updated_at=? WHERE id=?")
        .run(adultStatus, enabled ? 1 : 0, timestamp, playerId);
      if (!enabled) {
        this.db.prepare(`
          UPDATE interaction_requests SET status='cancelled',updated_at=?
          WHERE status='pending' AND request_type='intimate' AND (from_player_id=? OR to_player_id=?)
        `).run(timestamp, playerId, playerId);
      }
      return {
        social: this.getSocialState(playerId),
        message: adultStatus === "adult"
          ? `成年状态已确认，成人内容${enabled ? "已开启" : "未开启"}。`
          : adultStatus === "minor" ? "已标记为未成年，成人内容已强制关闭。" : "成年状态已重置为未知。",
      };
    });
  }

  greetPlayer(playerId: string, targetPlayerId: string) {
    return inTransaction(this.db, () => {
      const { player, target } = this.assertDirectInteraction(playerId, targetPlayerId);
      const timestamp = this.now().toISOString();
      const content = `${player.name}向${target.name}抱拳问候。`;
      const result = this.db.prepare("INSERT INTO world_events(player_id,event_type,content,created_at) VALUES (?,'social',?,?)")
        .run(playerId, content, timestamp);
      const event = this.db.prepare("SELECT id,player_id,event_type,content,created_at FROM world_events WHERE id=?")
        .get(result.lastInsertRowid) as EventRow;
      return { event: mapEvent(event), affectedPlayerIds: [playerId, targetPlayerId], message: content };
    });
  }

  requestInteraction(playerId: string, targetPlayerId: string, requestType: string, actionId?: string) {
    return inTransaction(this.db, () => {
      this.cleanupExpiredSocial();
      const { target } = this.assertDirectInteraction(playerId, targetPlayerId);
      const relationshipType = requestType.startsWith("relationship.") ? requestType.slice("relationship.".length) : null;
      const allowedRelationships = new Set(["friend", "sworn", "mentor", "lover", "spouse"]);
      if (relationshipType && !allowedRelationships.has(relationshipType)) throw new Error("不支持这种关系请求。");
      const payload: Record<string, unknown> = {};
      if (requestType === "intimate") {
        this.assertAdultConsentReady(playerId, targetPlayerId);
        const templateId = actionId ?? "action-private-intimacy";
        const template = this.db.prepare(`
          SELECT id FROM action_templates WHERE id=? AND is_active=1 AND adult=1
            AND target_kind='player' AND visibility='participants'
        `).get(templateId) as { id: string } | undefined;
        if (!template) throw new Error("成人互动规则不存在或隐私设置不安全。");
        payload.actionId = template.id;
      } else if (!relationshipType) {
        throw new Error("不支持这种互动请求。");
      }
      if (this.db.prepare(`
        SELECT 1 FROM interaction_requests WHERE status='pending' AND request_type=?
          AND ((from_player_id=? AND to_player_id=?) OR (from_player_id=? AND to_player_id=?))
      `).get(requestType, playerId, targetPlayerId, targetPlayerId, playerId)) throw new Error("双方已有相同的待处理请求。");
      if (relationshipType) {
        const [a, b] = [playerId, targetPlayerId].sort();
        if (this.db.prepare("SELECT 1 FROM player_relationships WHERE player_a_id=? AND player_b_id=? AND relation_type=? AND status='active'").get(a, b, relationshipType)) {
          throw new Error("双方已经建立了这种关系。");
        }
      }
      const now = this.now();
      const id = randomUUID();
      this.db.prepare(`
        INSERT INTO interaction_requests(id,request_type,from_player_id,to_player_id,status,payload_json,expires_at,created_at,updated_at)
        VALUES (?,?,?,?,'pending',?,?,?,?)
      `).run(id, requestType, playerId, targetPlayerId, JSON.stringify(payload), new Date(now.getTime() + 5 * 60_000).toISOString(), now.toISOString(), now.toISOString());
      return { affectedPlayerIds: [playerId, targetPlayerId], message: `已向${target.name}发送请求。` };
    });
  }

  respondInteraction(playerId: string, requestId: string, accept: boolean, onlinePlayerIds: string[] = []) {
    return inTransaction(this.db, () => {
      this.cleanupExpiredSocial();
      const request = this.db.prepare(`
        SELECT id,request_type,from_player_id,to_player_id,payload_json FROM interaction_requests
        WHERE id=? AND to_player_id=? AND status='pending' AND expires_at>?
      `).get(requestId, playerId, this.now().toISOString()) as {
        id: string; request_type: string; from_player_id: string; to_player_id: string; payload_json: string;
      } | undefined;
      if (!request) throw new Error("请求不存在、已处理或已过期。");
      const timestamp = this.now().toISOString();
      if (!accept) {
        this.db.prepare("UPDATE interaction_requests SET status='declined',updated_at=? WHERE id=?").run(timestamp, request.id);
        return { affectedPlayerIds: [request.from_player_id, request.to_player_id], message: "已拒绝请求。" };
      }
      this.assertDirectInteraction(playerId, request.from_player_id);
      if (onlinePlayerIds.length > 0 && !onlinePlayerIds.includes(request.from_player_id)) throw new Error("请求方当前不在线。");
      if (request.request_type.startsWith("relationship.")) {
        const relationType = request.request_type.slice("relationship.".length);
        const [a, b] = [request.from_player_id, request.to_player_id].sort();
        let roleA: string | null = null;
        let roleB: string | null = null;
        if (relationType === "mentor") {
          if (request.from_player_id === a) { roleA = "mentor"; roleB = "disciple"; }
          else { roleA = "disciple"; roleB = "mentor"; }
        }
        this.db.prepare(`
          INSERT INTO player_relationships(
            id,player_a_id,player_b_id,relation_type,status,role_a,role_b,requested_by,created_at,updated_at
          ) VALUES (?,?,?,?,'active',?,?,?,?,?)
          ON CONFLICT(player_a_id,player_b_id,relation_type) DO UPDATE SET
            status='active',role_a=excluded.role_a,role_b=excluded.role_b,requested_by=excluded.requested_by,updated_at=excluded.updated_at
        `).run(randomUUID(), a, b, relationType, roleA, roleB, request.from_player_id, timestamp, timestamp);
      } else if (request.request_type === "intimate") {
        this.assertAdultConsentReady(request.from_player_id, request.to_player_id);
        const payload = JSON.parse(request.payload_json) as { actionId?: unknown };
        if (typeof payload.actionId !== "string") throw new Error("私密行动请求缺少规则。");
        const template = this.getTemplateRow(payload.actionId);
        if (template.adult !== 1 || template.visibility !== "participants" || template.target_kind !== "player") {
          throw new Error("私密行动规则不再满足安全条件。");
        }
        this.enqueueSystemJob({
          playerId: request.from_player_id,
          templateId: template.id,
          targetPlayerId: request.to_player_id,
          durationSeconds: template.duration_seconds,
          context: { interactionRequestId: request.id },
        });
      } else {
        throw new Error("不支持这种互动请求。");
      }
      this.db.prepare("UPDATE interaction_requests SET status='accepted',updated_at=? WHERE id=?").run(timestamp, request.id);
      return { affectedPlayerIds: [request.from_player_id, request.to_player_id], message: "已接受请求。" };
    });
  }

  endRelationship(playerId: string, relationshipId: string) {
    return inTransaction(this.db, () => {
      const row = this.db.prepare(`
        SELECT player_a_id,player_b_id FROM player_relationships
        WHERE id=? AND status='active' AND (player_a_id=? OR player_b_id=?)
      `).get(relationshipId, playerId, playerId) as { player_a_id: string; player_b_id: string } | undefined;
      if (!row) throw new Error("关系不存在或已经结束。");
      this.db.prepare("UPDATE player_relationships SET status='ended',updated_at=? WHERE id=?").run(this.now().toISOString(), relationshipId);
      return { affectedPlayerIds: [row.player_a_id, row.player_b_id], message: "关系已结束。" };
    });
  }

  setPlayerBlocked(playerId: string, targetPlayerId: string, blocked: boolean) {
    return inTransaction(this.db, () => {
      this.getPlayerRow(playerId);
      this.getPlayerRow(targetPlayerId);
      if (playerId === targetPlayerId) throw new Error("不能屏蔽自己。");
      const timestamp = this.now().toISOString();
      if (blocked) {
        this.db.prepare("INSERT OR IGNORE INTO player_blocks(player_id,blocked_player_id,created_at) VALUES (?,?,?)")
          .run(playerId, targetPlayerId, timestamp);
        this.db.prepare(`
          UPDATE interaction_requests SET status='cancelled',updated_at=? WHERE status='pending'
            AND ((from_player_id=? AND to_player_id=?) OR (from_player_id=? AND to_player_id=?))
        `).run(timestamp, playerId, targetPlayerId, targetPlayerId, playerId);
        this.db.prepare(`
          UPDATE trade_sessions SET status='cancelled',updated_at=? WHERE status IN ('pending','active')
            AND ((player_a_id=? AND player_b_id=?) OR (player_a_id=? AND player_b_id=?))
        `).run(timestamp, playerId, targetPlayerId, targetPlayerId, playerId);
      } else {
        this.db.prepare("DELETE FROM player_blocks WHERE player_id=? AND blocked_player_id=?").run(playerId, targetPlayerId);
      }
      return { affectedPlayerIds: [playerId, targetPlayerId], message: blocked ? "已屏蔽对方。" : "已取消屏蔽。" };
    });
  }

  requestTrade(playerId: string, targetPlayerId: string) {
    return inTransaction(this.db, () => {
      this.cleanupExpiredSocial();
      const { target } = this.assertDirectInteraction(playerId, targetPlayerId);
      if (this.db.prepare(`
        SELECT 1 FROM trade_sessions WHERE status IN ('pending','active')
          AND ((player_a_id=? AND player_b_id=?) OR (player_a_id=? AND player_b_id=?))
      `).get(playerId, targetPlayerId, targetPlayerId, playerId)) throw new Error("双方已有待处理或进行中的交易。");
      const now = this.now();
      this.db.prepare(`
        INSERT INTO trade_sessions(
          id,player_a_id,player_b_id,status,offer_a_json,offer_b_json,confirmed_a,confirmed_b,expires_at,created_at,updated_at
        ) VALUES (?,?,?,'pending','{"cashWen":0,"items":[]}','{"cashWen":0,"items":[]}',0,0,?,?,?)
      `).run(randomUUID(), playerId, targetPlayerId, new Date(now.getTime() + 5 * 60_000).toISOString(), now.toISOString(), now.toISOString());
      return { affectedPlayerIds: [playerId, targetPlayerId], message: `已向${target.name}发出交易请求。` };
    });
  }

  respondTrade(playerId: string, tradeId: string, accept: boolean, onlinePlayerIds: string[] = []) {
    return inTransaction(this.db, () => {
      this.cleanupExpiredSocial();
      const row = this.db.prepare(`
        SELECT player_a_id,player_b_id FROM trade_sessions
        WHERE id=? AND player_b_id=? AND status='pending' AND expires_at>?
      `).get(tradeId, playerId, this.now().toISOString()) as { player_a_id: string; player_b_id: string } | undefined;
      if (!row) throw new Error("交易请求不存在、已处理或已过期。");
      const timestamp = this.now().toISOString();
      if (accept) {
        this.assertDirectInteraction(playerId, row.player_a_id);
        if (onlinePlayerIds.length > 0 && !onlinePlayerIds.includes(row.player_a_id)) throw new Error("交易发起方当前不在线。");
        this.db.prepare("UPDATE trade_sessions SET status='active',expires_at=?,updated_at=? WHERE id=?")
          .run(new Date(this.now().getTime() + 30 * 60_000).toISOString(), timestamp, tradeId);
      } else {
        this.db.prepare("UPDATE trade_sessions SET status='declined',updated_at=? WHERE id=?").run(timestamp, tradeId);
      }
      return { affectedPlayerIds: [row.player_a_id, row.player_b_id], message: accept ? "交易已开始。" : "已拒绝交易。" };
    });
  }

  private validateTradeOffer(playerId: string, offer: StoredTradeOffer) {
    const player = this.getPlayerRow(playerId);
    if (offer.cashWen > player.cash_wen) throw new Error("交易报价中的钱贯不足。");
    if (offer.items.length > 16 || new Set(offer.items.map((item) => item.itemId)).size !== offer.items.length) {
      throw new Error("交易物品报价不合法。");
    }
    const result: Array<{
      id: string; definition_id: string; quantity: number; quality: number; durability: number;
      affixes_json: string; bound: number; equipped_slot: string | null; reserved: number;
    }> = [];
    for (const offered of offer.items) {
      const item = this.db.prepare(`
        SELECT i.id,i.definition_id,i.quantity,i.quality,i.durability,i.affixes_json,i.bound,i.equipped_slot,
          COALESCE((SELECT SUM(quantity) FROM item_reservations WHERE item_instance_id=i.id),0) AS reserved
        FROM item_instances i WHERE i.id=? AND i.owner_player_id=?
      `).get(offered.itemId, playerId) as typeof result[number] | undefined;
      if (!item) throw new Error("交易物品已经不存在。");
      if (item.bound || item.equipped_slot) throw new Error("绑定或已装备物品不能交易。");
      if (offered.quantity > item.quantity - item.reserved) throw new Error("交易物品数量不足或已经被行动预留。");
      result.push(item);
    }
    return result;
  }

  offerTrade(playerId: string, tradeId: string, cashWen: number, items: Array<{ itemId: string; quantity: number }>) {
    return inTransaction(this.db, () => {
      this.cleanupExpiredSocial();
      const row = this.db.prepare(`
        SELECT player_a_id,player_b_id FROM trade_sessions
        WHERE id=? AND status='active' AND expires_at>? AND (player_a_id=? OR player_b_id=?)
      `).get(tradeId, this.now().toISOString(), playerId, playerId) as { player_a_id: string; player_b_id: string } | undefined;
      if (!row) throw new Error("交易不存在、未开始或已过期。");
      this.assertDirectInteraction(row.player_a_id, row.player_b_id);
      const offer = { cashWen, items } satisfies StoredTradeOffer;
      this.validateTradeOffer(playerId, offer);
      const side = row.player_a_id === playerId ? "a" : "b";
      this.db.prepare(`UPDATE trade_sessions SET offer_${side}_json=?,confirmed_a=0,confirmed_b=0,updated_at=? WHERE id=?`)
        .run(JSON.stringify(offer), this.now().toISOString(), tradeId);
      return { affectedPlayerIds: [row.player_a_id, row.player_b_id], message: "交易报价已更新，双方确认已重置。" };
    });
  }

  private transferTradeItems(fromPlayerId: string, toPlayerId: string, offer: StoredTradeOffer, at: string) {
    const validated = new Map(this.validateTradeOffer(fromPlayerId, offer).map((item) => [item.id, item]));
    for (const offered of offer.items) {
      const item = validated.get(offered.itemId)!;
      if (offered.quantity === item.quantity) {
        this.db.prepare("UPDATE item_instances SET owner_player_id=?,equipped_slot=NULL,updated_at=? WHERE id=?")
          .run(toPlayerId, at, item.id);
      } else {
        this.db.prepare("UPDATE item_instances SET quantity=quantity-?,updated_at=? WHERE id=?")
          .run(offered.quantity, at, item.id);
        this.db.prepare(`
          INSERT INTO item_instances(
            id,definition_id,owner_player_id,quantity,quality,durability,affixes_json,bound,equipped_slot,created_at,updated_at
          ) VALUES (?,?,?,?,?,?,?,0,NULL,?,?)
        `).run(randomUUID(), item.definition_id, toPlayerId, offered.quantity, item.quality, item.durability, item.affixes_json, at, at);
      }
    }
  }

  confirmTrade(playerId: string, tradeId: string) {
    return inTransaction(this.db, () => {
      this.cleanupExpiredSocial();
      let row = this.db.prepare(`
        SELECT player_a_id,player_b_id,offer_a_json,offer_b_json,confirmed_a,confirmed_b FROM trade_sessions
        WHERE id=? AND status='active' AND expires_at>? AND (player_a_id=? OR player_b_id=?)
      `).get(tradeId, this.now().toISOString(), playerId, playerId) as {
        player_a_id: string; player_b_id: string; offer_a_json: string; offer_b_json: string;
        confirmed_a: number; confirmed_b: number;
      } | undefined;
      if (!row) throw new Error("交易不存在、未开始或已过期。");
      this.assertDirectInteraction(row.player_a_id, row.player_b_id);
      const offerA = parseStoredTradeOffer(row.offer_a_json);
      const offerB = parseStoredTradeOffer(row.offer_b_json);
      this.validateTradeOffer(row.player_a_id, offerA);
      this.validateTradeOffer(row.player_b_id, offerB);
      const side = row.player_a_id === playerId ? "a" : "b";
      this.db.prepare(`UPDATE trade_sessions SET confirmed_${side}=1,updated_at=? WHERE id=?`)
        .run(this.now().toISOString(), tradeId);
      row = this.db.prepare(`
        SELECT player_a_id,player_b_id,offer_a_json,offer_b_json,confirmed_a,confirmed_b FROM trade_sessions WHERE id=?
      `).get(tradeId) as typeof row;
      if (!row || !row.confirmed_a || !row.confirmed_b) {
        return { affectedPlayerIds: row ? [row.player_a_id, row.player_b_id] : [playerId], message: "已确认报价，等待对方确认。" };
      }
      const timestamp = this.now().toISOString();
      const finalA = parseStoredTradeOffer(row.offer_a_json);
      const finalB = parseStoredTradeOffer(row.offer_b_json);
      this.validateTradeOffer(row.player_a_id, finalA);
      this.validateTradeOffer(row.player_b_id, finalB);
      this.changeCashWen(
        row.player_a_id, finalB.cashWen - finalA.cashWen, "玩家直接交易", "trade", tradeId, timestamp,
      );
      this.changeCashWen(
        row.player_b_id, finalA.cashWen - finalB.cashWen, "玩家直接交易", "trade", tradeId, timestamp,
      );
      this.transferTradeItems(row.player_a_id, row.player_b_id, finalA, timestamp);
      this.transferTradeItems(row.player_b_id, row.player_a_id, finalB, timestamp);
      this.db.prepare("UPDATE trade_sessions SET status='completed',updated_at=? WHERE id=?").run(timestamp, tradeId);
      for (const participant of [row.player_a_id, row.player_b_id]) {
        this.db.prepare("INSERT INTO private_events(player_id,event_type,content,created_at) VALUES (?,'trade','交易已经由双方确认并完成。',?)")
          .run(participant, timestamp);
      }
      return { affectedPlayerIds: [row.player_a_id, row.player_b_id], message: "交易完成。" };
    });
  }

  cancelTrade(playerId: string, tradeId: string) {
    return inTransaction(this.db, () => {
      const row = this.db.prepare(`
        SELECT player_a_id,player_b_id FROM trade_sessions
        WHERE id=? AND status IN ('pending','active') AND (player_a_id=? OR player_b_id=?)
      `).get(tradeId, playerId, playerId) as { player_a_id: string; player_b_id: string } | undefined;
      if (!row) throw new Error("交易已经无法取消。");
      this.db.prepare("UPDATE trade_sessions SET status='cancelled',updated_at=? WHERE id=?").run(this.now().toISOString(), tradeId);
      return { affectedPlayerIds: [row.player_a_id, row.player_b_id], message: "交易已取消。" };
    });
  }

  private displayTradeOffer(value: string): TradeOffer {
    const offer = parseStoredTradeOffer(value);
    return {
      cashWen: offer.cashWen,
      items: offer.items.map((offered) => {
        const row = this.db.prepare(`
          SELECT i.definition_id,d.name FROM item_instances i JOIN item_definitions d ON d.id=i.definition_id WHERE i.id=?
        `).get(offered.itemId) as { definition_id: string; name: string } | undefined;
        return {
          itemId: offered.itemId,
          definitionId: row?.definition_id ?? "missing",
          name: row?.name ?? "已不存在的物品",
          quantity: offered.quantity,
        };
      }),
    };
  }

  getSocialState(playerId: string): SocialState {
    this.getPlayerRow(playerId);
    this.cleanupExpiredSocial();
    const profile = this.db.prepare("SELECT adult_status,adult_content_enabled FROM players WHERE id=?").get(playerId) as {
      adult_status: SocialState["adultProfile"]["status"]; adult_content_enabled: number;
    };
    const relationships = (this.db.prepare(`
      SELECT r.id,r.relation_type,r.status,r.affinity,r.trust,r.intimacy,r.hostility,
        CASE WHEN r.player_a_id=? THEN r.player_b_id ELSE r.player_a_id END AS other_player_id,
        CASE WHEN r.player_a_id=? THEN pb.name ELSE pa.name END AS other_player_name,
        CASE WHEN r.player_a_id=? THEN r.role_a ELSE r.role_b END AS own_role
      FROM player_relationships r JOIN players pa ON pa.id=r.player_a_id JOIN players pb ON pb.id=r.player_b_id
      WHERE r.status='active' AND (r.player_a_id=? OR r.player_b_id=?) ORDER BY r.updated_at DESC
    `).all(playerId, playerId, playerId, playerId, playerId) as Array<{
      id: string; relation_type: string; status: string; affinity: number; trust: number; intimacy: number; hostility: number;
      other_player_id: string; other_player_name: string; own_role: string | null;
    }>).map((row): Relationship => ({
      id: row.id, otherPlayerId: row.other_player_id, otherPlayerName: row.other_player_name,
      relationType: row.relation_type, status: row.status, role: row.own_role,
      affinity: row.affinity, trust: row.trust, intimacy: row.intimacy, hostility: row.hostility,
    }));
    const requests = (this.db.prepare(`
      SELECT r.id,r.request_type,r.from_player_id,pf.name AS from_player_name,r.to_player_id,pt.name AS to_player_name,
        r.status,r.payload_json,r.expires_at FROM interaction_requests r
      JOIN players pf ON pf.id=r.from_player_id JOIN players pt ON pt.id=r.to_player_id
      WHERE r.status='pending' AND (r.from_player_id=? OR r.to_player_id=?) ORDER BY r.created_at DESC
    `).all(playerId, playerId) as Array<{
      id: string; request_type: string; from_player_id: string; from_player_name: string; to_player_id: string;
      to_player_name: string; status: string; payload_json: string; expires_at: string;
    }>).map((row): InteractionRequest => ({
      id: row.id, requestType: row.request_type, fromPlayerId: row.from_player_id, fromPlayerName: row.from_player_name,
      toPlayerId: row.to_player_id, toPlayerName: row.to_player_name, status: row.status,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>, expiresAt: row.expires_at,
    }));
    const trades = (this.db.prepare(`
      SELECT t.*,pa.name AS player_a_name,pb.name AS player_b_name FROM trade_sessions t
      JOIN players pa ON pa.id=t.player_a_id JOIN players pb ON pb.id=t.player_b_id
      WHERE t.status IN ('pending','active') AND (t.player_a_id=? OR t.player_b_id=?) ORDER BY t.created_at DESC
    `).all(playerId, playerId) as Array<{
      id: string; player_a_id: string; player_b_id: string; player_a_name: string; player_b_name: string; status: string;
      offer_a_json: string; offer_b_json: string; confirmed_a: number; confirmed_b: number; expires_at: string;
    }>).map((row) => {
      const ownIsA = row.player_a_id === playerId;
      return {
        id: row.id, status: row.status,
        otherPlayerId: ownIsA ? row.player_b_id : row.player_a_id,
        otherPlayerName: ownIsA ? row.player_b_name : row.player_a_name,
        requestedBySelf: ownIsA,
        ownOffer: this.displayTradeOffer(ownIsA ? row.offer_a_json : row.offer_b_json),
        otherOffer: this.displayTradeOffer(ownIsA ? row.offer_b_json : row.offer_a_json),
        ownConfirmed: (ownIsA ? row.confirmed_a : row.confirmed_b) === 1,
        otherConfirmed: (ownIsA ? row.confirmed_b : row.confirmed_a) === 1,
        expiresAt: row.expires_at,
      };
    });
    return {
      adultProfile: { status: profile.adult_status, contentEnabled: profile.adult_content_enabled === 1 },
      relationships,
      incomingRequests: requests.filter((request) => request.toPlayerId === playerId),
      outgoingRequests: requests.filter((request) => request.fromPlayerId === playerId),
      trades,
    };
  }

  private getCombatRow(combatId: string) {
    return this.db.prepare(`
      SELECT id,location_id,attacker_id,defender_id,status,round,acting_player_id,turn_deadline,
        attacker_misses,defender_misses,winner_id,loser_id FROM combat_sessions WHERE id=?
    `).get(combatId) as CombatRow | undefined;
  }

  startCombat(playerId: string, targetPlayerId: string) {
    return inTransaction(this.db, () => {
      if (playerId === targetPlayerId) throw new Error("不能攻击自己。");
      const attacker = this.assertCanTakeGameAction(playerId);
      const defender = this.assertCanTakeGameAction(targetPlayerId);
      if (attacker.current_location !== defender.current_location) throw new Error("只能攻击同一地点的角色。");
      for (const participant of [playerId, targetPlayerId]) {
        this.settleActionQueueInternal(participant, this.now());
        if (this.db.prepare("SELECT 1 FROM action_jobs WHERE player_id=? AND status IN ('running','paused','queued')").get(participant)) {
          throw new Error("参战者仍有进行中或排队的行动。");
        }
      }
      const now = this.now();
      const id = randomUUID();
      this.db.prepare(`
        INSERT INTO combat_sessions(
          id,location_id,attacker_id,defender_id,status,round,acting_player_id,turn_deadline,
          attacker_misses,defender_misses,created_at,updated_at
        ) VALUES (?,?,?,?,'active',1,?,?,0,0,?,?)
      `).run(id, attacker.current_location, playerId, targetPlayerId, playerId, new Date(now.getTime() + 30_000).toISOString(), now.toISOString(), now.toISOString());
      const content = `${attacker.name}向${defender.name}发起战斗。`;
      const inserted = this.db.prepare("INSERT INTO world_events(player_id,event_type,content,created_at) VALUES (?,'combat',?,?)")
        .run(playerId, content, now.toISOString());
      const event = this.db.prepare("SELECT id,player_id,event_type,content,created_at FROM world_events WHERE id=?")
        .get(inserted.lastInsertRowid) as EventRow;
      return { combatId: id, affectedPlayerIds: [playerId, targetPlayerId], event: mapEvent(event), message: content };
    });
  }

  private insertCombatTurn(combat: CombatRow, playerId: string, choice: string, resultText: string, at: string) {
    this.db.prepare(`
      INSERT INTO combat_turns(combat_id,round,player_id,choice,result_json,created_at) VALUES (?,?,?,?,?,?)
    `).run(combat.id, combat.round, playerId, choice, JSON.stringify({ text: resultText }), at);
  }

  private endCombatByFlee(combat: CombatRow, fleeingPlayerId: string, at: string, automatic: boolean) {
    const otherId = combat.attacker_id === fleeingPlayerId ? combat.defender_id : combat.attacker_id;
    const fleeing = this.getPlayer(fleeingPlayerId);
    const other = this.getPlayer(otherId);
    const text = automatic
      ? `${fleeing.name}连续三回合未响应，自动脱离了与${other.name}的战斗。`
      : `${fleeing.name}成功脱离了与${other.name}的战斗。`;
    this.insertCombatTurn(combat, fleeingPlayerId, automatic ? "auto-flee" : "flee", text, at);
    this.db.prepare(`
      UPDATE combat_sessions SET status='fled',acting_player_id=NULL,turn_deadline=NULL,winner_id=?,loser_id=?,ended_at=?,updated_at=? WHERE id=?
    `).run(otherId, fleeingPlayerId, at, at, combat.id);
    this.db.prepare("INSERT INTO world_events(player_id,event_type,content,created_at) VALUES (?,'combat',?,?)")
      .run(fleeingPlayerId, text, at);
    return text;
  }

  private defeatPlayer(combat: CombatRow, winnerId: string, loserId: string, at: string) {
    const winner = this.getPlayer(winnerId);
    const loser = this.getPlayer(loserId);
    const lootId = randomUUID();
    this.db.prepare(`
      INSERT INTO loot_piles(id,location_id,silver,cash_wen,source_player_id,created_at,updated_at) VALUES (?,?,0,?,?,?,?)
    `).run(lootId, combat.location_id, loser.cashWen, loserId, at, at);
    this.db.prepare(`
      UPDATE item_instances SET owner_player_id=NULL,loot_pile_id=?,equipped_slot=NULL,updated_at=?
      WHERE owner_player_id=? AND bound=0
    `).run(lootId, at, loserId);
    this.db.prepare("UPDATE players SET hp=0,updated_at=?,last_seen_at=? WHERE id=?").run(at, at, loserId);
    if (loser.cashWen > 0) this.changeCashWen(loserId, -loser.cashWen, "战败掉落", "loot", lootId, at);
    this.db.prepare(`
      UPDATE combat_sessions SET status='completed',acting_player_id=NULL,turn_deadline=NULL,winner_id=?,loser_id=?,ended_at=?,updated_at=? WHERE id=?
    `).run(winnerId, loserId, at, at, combat.id);
    const text = `${winner.name}击败${loser.name}；落败者的全部钱贯与未绑定物品掉落在当前地点。`;
    this.db.prepare("INSERT INTO world_events(player_id,event_type,content,created_at) VALUES (?,'defeat',?,?)").run(winnerId, text, at);
    for (const participant of [winnerId, loserId]) {
      this.db.prepare("INSERT INTO private_events(player_id,event_type,content,created_at) VALUES (?,'combat',?,?)").run(participant, text, at);
    }
    return text;
  }

  private resolveCombatTurn(combat: CombatRow, playerId: string, choice: "attack" | "power" | "defend" | "flee", at: Date, timedOut: boolean) {
    if (combat.status !== "active" || combat.acting_player_id !== playerId) throw new Error("现在不是你的战斗回合。");
    const timestamp = at.toISOString();
    const isAttacker = combat.attacker_id === playerId;
    const opponentId = isAttacker ? combat.defender_id : combat.attacker_id;
    const missColumn = isAttacker ? "attacker_misses" : "defender_misses";
    if (timedOut) {
      const misses = (isAttacker ? combat.attacker_misses : combat.defender_misses) + 1;
      this.db.prepare(`UPDATE combat_sessions SET ${missColumn}=?,updated_at=? WHERE id=?`).run(misses, timestamp, combat.id);
      if (misses >= 3) return { ended: true, text: this.endCombatByFlee(combat, playerId, timestamp, true) };
      choice = "defend";
    } else {
      this.db.prepare(`UPDATE combat_sessions SET ${missColumn}=0,updated_at=? WHERE id=?`).run(timestamp, combat.id);
    }
    const player = this.getPlayer(playerId);
    const opponent = this.getPlayer(opponentId);
    let resultText: string;
    if (choice === "flee") {
      const chance = Math.max(10, Math.min(90, 50 + player.derived.speed - opponent.derived.speed));
      if (this.randomPercent() < chance) return { ended: true, text: this.endCombatByFlee(combat, playerId, timestamp, false) };
      resultText = `${player.name}尝试脱离战斗，但被${opponent.name}拦下。`;
    } else if (choice === "defend") {
      resultText = timedOut ? `${player.name}回合超时，自动采取格挡。` : `${player.name}沉身格挡，准备承受下一次攻击。`;
    } else {
      const lastTurn = this.db.prepare(`
        SELECT player_id,choice FROM combat_turns WHERE combat_id=? ORDER BY id DESC LIMIT 1
      `).get(combat.id) as { player_id: string; choice: string } | undefined;
      const defending = lastTurn?.player_id === opponentId && ["defend", "timeout-defend"].includes(lastTurn.choice);
      const hitChance = Math.max(5, Math.min(95, 50 + player.derived.hitRate - opponent.derived.dodgeRate - (choice === "power" ? 20 : 0)));
      if (this.randomPercent() >= hitChance) {
        resultText = `${player.name}${choice === "power" ? "蓄力猛击" : "攻击"}${opponent.name}，但没有命中。`;
      } else {
        const base = Math.max(1, Math.floor((player.derived.minAttack + player.derived.maxAttack) / 2 - opponent.derived.defense * 0.5));
        const critical = this.randomPercent() < player.derived.criticalRate;
        let damage = Math.max(1, Math.floor(base * (choice === "power" ? 1.5 : 1) * (critical ? player.derived.criticalDamage / 100 : 1)));
        if (defending) damage = Math.max(1, Math.floor(damage / 2));
        const hp = Math.max(0, opponent.hp - damage);
        this.db.prepare("UPDATE players SET hp=?,updated_at=? WHERE id=?").run(hp, timestamp, opponentId);
        resultText = `${player.name}${choice === "power" ? "蓄力猛击" : "攻击"}${opponent.name}，造成${damage}点伤害${critical ? "（暴击）" : ""}${defending ? "（格挡减半）" : ""}。`;
        if (hp <= 0) {
          this.insertCombatTurn(combat, playerId, choice, resultText, timestamp);
          return { ended: true, text: `${resultText}${this.defeatPlayer(combat, playerId, opponentId, timestamp)}` };
        }
      }
    }
    this.insertCombatTurn(combat, playerId, timedOut ? "timeout-defend" : choice, resultText, timestamp);
    const deadlineBase = timedOut && combat.turn_deadline ? new Date(combat.turn_deadline) : at;
    this.db.prepare(`
      UPDATE combat_sessions SET round=round+1,acting_player_id=?,turn_deadline=?,updated_at=? WHERE id=?
    `).run(opponentId, new Date(deadlineBase.getTime() + 30_000).toISOString(), timestamp, combat.id);
    return { ended: false, text: resultText };
  }

  chooseCombatAction(playerId: string, combatId: string, choice: "attack" | "power" | "defend" | "flee") {
    return inTransaction(this.db, () => {
      const combat = this.getCombatRow(combatId);
      if (!combat || combat.status !== "active" || (combat.attacker_id !== playerId && combat.defender_id !== playerId)) {
        throw new Error("战斗不存在或已经结束。");
      }
      if (combat.turn_deadline && new Date(combat.turn_deadline).getTime() <= this.now().getTime()) {
        const timeoutResult = this.resolveCombatTurn(combat, combat.acting_player_id!, "defend", new Date(combat.turn_deadline), true);
        return {
          affectedPlayerIds: [combat.attacker_id, combat.defender_id],
          message: `该回合已经超时。${timeoutResult.text}`,
        };
      }
      const result = this.resolveCombatTurn(combat, playerId, choice, this.now(), false);
      return { affectedPlayerIds: [combat.attacker_id, combat.defender_id], message: result.text };
    });
  }

  settleDueCombats() {
    return inTransaction(this.db, () => {
      const affected = new Set<string>();
      for (let guard = 0; guard < 128; guard += 1) {
        const combat = this.db.prepare(`
          SELECT id,location_id,attacker_id,defender_id,status,round,acting_player_id,turn_deadline,
            attacker_misses,defender_misses,winner_id,loser_id FROM combat_sessions
          WHERE status='active' AND turn_deadline<=? ORDER BY turn_deadline,id LIMIT 1
        `).get(this.now().toISOString()) as CombatRow | undefined;
        if (!combat || !combat.acting_player_id || !combat.turn_deadline) break;
        this.resolveCombatTurn(combat, combat.acting_player_id, "defend", new Date(combat.turn_deadline), true);
        affected.add(combat.attacker_id);
        affected.add(combat.defender_id);
      }
      return [...affected];
    });
  }

  getCombatState(playerId: string): CombatState | null {
    const combat = this.db.prepare(`
      SELECT id,location_id,attacker_id,defender_id,status,round,acting_player_id,turn_deadline,
        attacker_misses,defender_misses,winner_id,loser_id FROM combat_sessions
      WHERE status='active' AND (attacker_id=? OR defender_id=?) ORDER BY created_at DESC LIMIT 1
    `).get(playerId, playerId) as CombatRow | undefined;
    if (!combat) return null;
    const ownIsAttacker = combat.attacker_id === playerId;
    const opponentId = ownIsAttacker ? combat.defender_id : combat.attacker_id;
    const opponent = this.getPlayer(opponentId);
    const recentTurns = (this.db.prepare(`
      SELECT t.id,t.round,t.player_id,p.name AS player_name,t.choice,t.result_json,t.created_at
      FROM combat_turns t JOIN players p ON p.id=t.player_id WHERE t.combat_id=? ORDER BY t.id DESC LIMIT 12
    `).all(combat.id) as Array<{
      id: number; round: number; player_id: string; player_name: string; choice: string; result_json: string; created_at: string;
    }>).map((turn) => ({
      id: turn.id, round: turn.round, playerId: turn.player_id, playerName: turn.player_name,
      choice: turn.choice, resultText: (JSON.parse(turn.result_json) as { text?: string }).text ?? turn.choice, createdAt: turn.created_at,
    }));
    return {
      id: combat.id, locationId: combat.location_id, status: combat.status, round: combat.round,
      actingPlayerId: combat.acting_player_id, turnDeadline: combat.turn_deadline, selfTurn: combat.acting_player_id === playerId,
      opponentId, opponentName: opponent.name, opponentHp: opponent.hp, opponentMaxHp: opponent.maxHp,
      ownMissedTurns: ownIsAttacker ? combat.attacker_misses : combat.defender_misses,
      opponentMissedTurns: ownIsAttacker ? combat.defender_misses : combat.attacker_misses,
      recentTurns,
    };
  }

  respawnPlayer(playerId: string) {
    return inTransaction(this.db, () => {
      const player = this.getPlayerRow(playerId);
      if (player.hp > 0) throw new Error("角色当前并未落败。");
      if (this.db.prepare("SELECT 1 FROM combat_sessions WHERE status='active' AND (attacker_id=? OR defender_id=?)").get(playerId, playerId)) {
        throw new Error("战斗尚未结算。");
      }
      const at = this.now();
      const derived = this.mapPlayer({ ...player, hp: 1 }).derived;
      this.db.prepare(`
        UPDATE players SET hp=?,current_location='home-entrance',injury_until=?,updated_at=?,last_seen_at=? WHERE id=?
      `).run(Math.max(1, Math.ceil(derived.maxHp / 2)), new Date(at.getTime() + 10 * 60_000).toISOString(), at.toISOString(), at.toISOString(), playerId);
      this.db.prepare("UPDATE player_progression SET training_anchor_at=NULL,updated_at=? WHERE player_id=?").run(at.toISOString(), playerId);
      this.db.prepare(`
        INSERT INTO player_visited_locations(player_id,location_id,first_visited_at,last_visited_at)
        VALUES (?,'home-entrance',?,?) ON CONFLICT(player_id,location_id) DO UPDATE SET last_visited_at=excluded.last_visited_at
      `).run(playerId, at.toISOString(), at.toISOString());
      this.db.prepare("INSERT INTO private_events(player_id,event_type,content,created_at) VALUES (?,'respawn','你带伤返回玄关复起。',?)")
        .run(playerId, at.toISOString());
      return { player: this.getPlayer(playerId), message: "已返回玄关复起，气血恢复一半。" };
    });
  }

  getLootPiles(locationId: string): LootPile[] {
    const rows = this.db.prepare(`
      SELECT pile.id,pile.location_id,pile.cash_wen,pile.source_player_id,p.name AS source_player_name
      FROM loot_piles pile LEFT JOIN players p ON p.id=pile.source_player_id WHERE pile.location_id=? ORDER BY pile.created_at DESC
    `).all(locationId) as Array<{
      id: string; location_id: string; cash_wen: number; source_player_id: string | null; source_player_name: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id, locationId: row.location_id, cashWen: row.cash_wen, sourcePlayerId: row.source_player_id,
      sourcePlayerName: row.source_player_name,
      items: (this.db.prepare(`
        SELECT d.name,i.quantity,i.quality FROM item_instances i JOIN item_definitions d ON d.id=i.definition_id
        WHERE i.loot_pile_id=? ORDER BY d.name,i.id
      `).all(row.id) as Array<{ name: string; quantity: number; quality: number }>),
    }));
  }

  takeLoot(playerId: string, lootPileId: string) {
    return inTransaction(this.db, () => {
      const player = this.assertCanTakeGameAction(playerId);
      const pile = this.db.prepare("SELECT location_id,cash_wen FROM loot_piles WHERE id=?").get(lootPileId) as {
        location_id: string; cash_wen: number;
      } | undefined;
      if (!pile || pile.location_id !== player.current_location) throw new Error("战利品不在当前位置或已经被取走。");
      const timestamp = this.now().toISOString();
      if (pile.cash_wen > 0) this.changeCashWen(playerId, pile.cash_wen, "拾取战利品", "loot", lootPileId, timestamp);
      this.db.prepare("UPDATE item_instances SET owner_player_id=?,loot_pile_id=NULL,updated_at=? WHERE loot_pile_id=?")
        .run(playerId, timestamp, lootPileId);
      this.db.prepare("DELETE FROM loot_piles WHERE id=?").run(lootPileId);
      this.db.prepare("INSERT INTO private_events(player_id,event_type,content,created_at) VALUES (?,'loot',?,?)")
        .run(playerId, `取得战利品与${formatCashWen(pile.cash_wen)}。`, timestamp);
      return { player: this.getPlayer(playerId), inventory: this.getInventoryState(playerId), message: "战利品已收入行囊。" };
    });
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
    const qinggongTargets = this.getQinggongTargets(playerId);
    const neighborhoodIds = new Set(neighborhood.locations.map((location) => location.id));
    const qinggongLocations = this.getLocations(qinggongTargets.map((target) => target.locationId), current.layerId)
      .filter((location) => !neighborhoodIds.has(location.id));
    const allOnlinePlayers = this.getOnlinePlayers(onlinePlayerIds);
    const visibleLocationIds = new Set(neighborhood.locations.map((location) => location.id));
    const onlinePlayers = allOnlinePlayers.filter((player) => visibleLocationIds.has(player.currentLocation));
    return {
      self, world: this.getWorldStatus(allOnlinePlayers.length), currentLayer: this.getLayer(current.layerId),
      regions: neighborhood.regions, locations: [...neighborhood.locations, ...qinggongLocations], routes: neighborhood.routes,
      transitions: this.getTransitions(self.currentLocation), actions: this.getActions([self.currentLocation]),
      actionState: this.readActionState(playerId),
      inventory: this.getInventoryState(playerId),
      shop: this.getCurrentShopSummary(playerId),
      social: this.getSocialState(playerId),
      combat: this.getCombatState(playerId),
      lootPiles: this.getLootPiles(self.currentLocation),
      qinggongTargets,
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
      if (["world-root", "home-ground"].includes(operation.layerId)) throw new Error("初始地图层不能删除。");
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
      this.db.prepare("INSERT OR IGNORE INTO action_definitions(id,location_id,name,description,stamina_delta,silver_delta,cultivation_delta,hp_delta,result_template,cash_wen_delta) VALUES (?,?,'观察','观察这个地点的环境。',0,0,0,0,'{name}在此观察四周。',0)").run(`observe-${id}`, id);
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
      this.assertCanTakeGameAction(playerId);
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

  fastTravel(playerId: string, destinationId: string): GameMutation {
    return inTransaction(this.db, () => {
      this.assertCanTakeGameAction(playerId);
      this.settleActionQueueInternal(playerId, this.now());
      if (this.db.prepare("SELECT 1 FROM action_jobs WHERE player_id=? AND status IN ('running','paused')").get(playerId)) {
        throw new Error("当前行动尚未完成，请先等待或取消行动。");
      }
      this.settleCultivationInternal(playerId, this.now(), false);
      const player = this.getPlayer(playerId);
      if (destinationId === player.currentLocation) throw new Error("你已经在这里了。");
      const destination = this.getLocation(destinationId);
      if (!this.db.prepare("SELECT 1 FROM player_visited_locations WHERE player_id=? AND location_id=?").get(playerId, destinationId)) {
        throw new Error("只能快速前往亲自到达过的地点。");
      }
      if (!this.db.prepare(`
        SELECT 1 FROM location_facilities
        WHERE location_id=? AND facility_type='fast-travel' AND is_active=1
      `).get(destinationId)) {
        throw new Error("这个地点不是已解锁的快速旅行枢纽。");
      }
      const at = this.now().toISOString();
      const content = `${player.name}循驿路快速前往${destination.region} - ${destination.name}。`;
      this.db.prepare("UPDATE players SET current_location=?,updated_at=?,last_seen_at=? WHERE id=?").run(destinationId, at, at, playerId);
      this.db.prepare("UPDATE player_progression SET training_anchor_at=?,updated_at=? WHERE player_id=?")
        .run(destination.trainingMultiplier > 0 ? at : null, at, playerId);
      this.db.prepare(`
        UPDATE player_visited_locations SET last_visited_at=? WHERE player_id=? AND location_id=?
      `).run(at, playerId, destinationId);
      this.db.prepare("INSERT INTO action_logs(player_id,kind,from_location,to_location,result_text,created_at) VALUES (?,'fast-travel',?,?,?,?)")
        .run(playerId, player.currentLocation, destinationId, content, at);
      const result = this.db.prepare("INSERT INTO world_events(player_id,event_type,content,created_at) VALUES (?,'fast-travel',?,?)")
        .run(playerId, content, at);
      const event = this.db.prepare("SELECT id,player_id,event_type,content,created_at FROM world_events WHERE id=?").get(result.lastInsertRowid) as EventRow;
      return { self: this.getPlayer(playerId), event: mapEvent(event), message: `快速旅行完成：已抵达${destination.name}` };
    });
  }

  act(playerId: string, actionId: string): GameMutation {
    return inTransaction(this.db, () => {
      this.assertCanTakeGameAction(playerId);
      this.settleCultivationInternal(playerId, this.now(), false);
      const player = this.getPlayer(playerId);
      const row = this.db.prepare(`
        SELECT id,location_id,name,description,cash_wen_delta,hp_delta,result_template FROM action_definitions WHERE id=?
      `).get(actionId) as { id: string; location_id: string; name: string; description: string; cash_wen_delta: number; hp_delta: number; result_template: string } | undefined;
      if (!row || row.location_id !== player.currentLocation) throw new Error("这里无法进行这项行动。");
      const action: ActionDefinition = { id: row.id, locationId: row.location_id, name: row.name, description: row.description, cashWenDelta: row.cash_wen_delta, hpDelta: row.hp_delta };
      if (player.cashWen + action.cashWenDelta < 0) throw new Error("钱贯不足。");
      const hp = Math.max(0, Math.min(player.maxHp, player.hp + action.hpDelta));
      const at = this.now().toISOString();
      const content = row.result_template.replace("{name}", player.name);
      this.db.prepare("UPDATE players SET hp=?,updated_at=?,last_seen_at=? WHERE id=?").run(hp, at, at, playerId);
      if (action.cashWenDelta) this.changeCashWen(playerId, action.cashWenDelta, action.name, "legacy-action", action.id, at);
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
