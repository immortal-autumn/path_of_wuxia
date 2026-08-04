import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

type SeedItem = {
  id: string;
  name: string;
  description: string;
  category: string;
  stackable?: boolean;
  maxStack?: number;
  baseValue: number;
  maxDurability?: number;
  equipmentSlot?: string;
  tags?: string[];
  effects?: Record<string, unknown>;
};

export const ITEM_CATALOG: SeedItem[] = [
  { id: "water-flask", name: "清水", description: "可以直接饮用的一筒清水。", category: "drink", stackable: true, maxStack: 99, baseValue: 20, tags: ["water"], effects: { needDeltas: { hydration: 30, bladder: 10 } } },
  { id: "simple-meal", name: "家常饭", description: "一份朴素但完整的饭食。", category: "food", stackable: true, maxStack: 50, baseValue: 80, effects: { needDeltas: { satiety: 50, hydration: 5, bladder: 5 } } },
  { id: "tea", name: "清茶", description: "点茶法冲调的一盏温茶。", category: "drink", stackable: true, maxStack: 50, baseValue: 45, effects: { needDeltas: { hydration: 18, fatigue: -4, bladder: 8 } } },
  { id: "healing-poultice", name: "止血药膏", description: "用于处理普通外伤的成药。", category: "medicine", stackable: true, maxStack: 20, baseValue: 320, effects: { hpDelta: 30 } },
  { id: "rice-seed", name: "稻种", description: "可播种在农田中的稻种。", category: "seed", stackable: true, maxStack: 999, baseValue: 12 },
  { id: "herb-seed", name: "药草种子", description: "可培育常用药草。", category: "seed", stackable: true, maxStack: 999, baseValue: 25 },
  { id: "rice", name: "稻米", description: "收获并脱壳后的稻米。", category: "ingredient", stackable: true, maxStack: 999, baseValue: 35 },
  { id: "herb", name: "药草", description: "常见的药用植物。", category: "ingredient", stackable: true, maxStack: 999, baseValue: 60 },
  { id: "wood", name: "木材", description: "制作和修理使用的木材。", category: "material", stackable: true, maxStack: 999, baseValue: 90 },
  { id: "iron-ore", name: "铁料", description: "尚未精炼成器的铁料。", category: "material", stackable: true, maxStack: 999, baseValue: 160 },
  { id: "cotton-robe", name: "棉布衣", description: "结实的日常衣物。", category: "armor", baseValue: 1_500, maxDurability: 100, equipmentSlot: "body", effects: { defense: 3 } },
  { id: "cloth-boots", name: "布靴", description: "便于日常行走的布靴。", category: "armor", baseValue: 900, maxDurability: 80, equipmentSlot: "feet", effects: { speed: 2 } },
  { id: "wooden-sword", name: "木剑", description: "练习剑法使用的木剑。", category: "weapon", baseValue: 800, maxDurability: 80, equipmentSlot: "weapon", effects: { attack: 5 } },
  { id: "iron-sword", name: "铁剑", description: "东京铁器作锻造的普通铁剑。", category: "weapon", baseValue: 6_000, maxDurability: 180, equipmentSlot: "weapon", effects: { attack: 14 } },
  { id: "farm-hoe", name: "锄头", description: "翻地与农耕使用的工具。", category: "tool", baseValue: 1_800, maxDurability: 120, equipmentSlot: "tool", effects: { farming: 5 } },
  { id: "moxa", name: "熟艾", description: "医馆炮制后用于温灸的艾绒。", category: "medicine", stackable: true, maxStack: 50, baseValue: 140 },
  { id: "tea-cake", name: "茶饼", description: "蒸青研膏后压制的茶饼。", category: "drink", stackable: true, maxStack: 30, baseValue: 280 },
  { id: "sweet-cake", name: "蜜糕", description: "东京食店常见的甜糕。", category: "food", stackable: true, maxStack: 30, baseValue: 65, effects: { needDeltas: { satiety: 18, hydration: -2 } } },
  { id: "salt", name: "食盐", description: "官引流通的日用食盐。", category: "ingredient", stackable: true, maxStack: 200, baseValue: 75 },
  { id: "lamp-oil", name: "灯油", description: "供灯烛使用的一小罐油。", category: "general", stackable: true, maxStack: 50, baseValue: 55 },
  { id: "silk-bolt", name: "绫罗一匹", description: "绫罗铺出售的成匹丝织物。", category: "textile", stackable: true, maxStack: 20, baseValue: 8_000 },
  { id: "linen-bolt", name: "麻布一匹", description: "适合裁制日常衣物的麻布。", category: "textile", stackable: true, maxStack: 30, baseValue: 1_200 },
  { id: "paper", name: "楮纸", description: "书铺出售的书写用纸。", category: "books", stackable: true, maxStack: 100, baseValue: 90 },
  { id: "ink-stick", name: "松烟墨", description: "文房铺出售的松烟墨锭。", category: "books", stackable: true, maxStack: 30, baseValue: 260 },
  { id: "classic-book", name: "经义抄本", description: "书铺抄印的经义读本。", category: "books", stackable: true, maxStack: 10, baseValue: 1_600 },
  { id: "bronze-mirror", name: "铜镜", description: "铜器铺打磨的日用镜。", category: "craft", baseValue: 2_400, maxDurability: 100 },
  { id: "soap-bean", name: "澡豆", description: "浴堂与香药铺常用的清洁香料。", category: "bath", stackable: true, maxStack: 30, baseValue: 120, effects: { needDeltas: { hygiene: 20 } } },
  { id: "travel-ration", name: "干粮", description: "邸店为行旅备下的耐存干粮。", category: "food", stackable: true, maxStack: 50, baseValue: 110, effects: { needDeltas: { satiety: 30, hydration: -5 } } },
];

export const RECIPE_CATALOG = [
  { id: "recipe-simple-meal", name: "烹制家常饭", description: "用稻米和清水烹制两份饭食。", facility: "kitchen", skill: "cooking", duration: 1800, difficulty: 30, inputs: { rice: 2, "water-flask": 1 }, outputs: { "simple-meal": 2 } },
  { id: "recipe-tea", name: "泡制清茶", description: "以药草和清水泡制两份清茶。", facility: "kitchen", skill: "cooking", duration: 600, difficulty: 25, inputs: { herb: 1, "water-flask": 1 }, outputs: { tea: 2 } },
  { id: "recipe-poultice", name: "调制止血药膏", description: "将药草处理成外伤药膏。", facility: "workshop", skill: "medicine", duration: 1800, difficulty: 40, inputs: { herb: 2 }, outputs: { "healing-poultice": 1 } },
  { id: "recipe-wooden-sword", name: "制作木剑", description: "加工木材制成练习木剑。", facility: "workshop", skill: "crafting", duration: 7200, difficulty: 35, inputs: { wood: 5 }, outputs: { "wooden-sword": 1 } },
  { id: "recipe-iron-sword", name: "锻造铁剑", description: "以铁矿和木材锻造一柄铁剑。", facility: "smithy", skill: "smithing", duration: 28800, difficulty: 55, inputs: { "iron-ore": 8, wood: 2 }, outputs: { "iron-sword": 1 } },
] as const;

export const CROP_CATALOG = [
  { id: "crop-rice", name: "水稻", seed: "rice-seed", harvest: "rice", growth: 120 * 24 * 60 * 60, yield: 20 },
  { id: "crop-herb", name: "药草", seed: "herb-seed", harvest: "herb", growth: 30 * 24 * 60 * 60, yield: 10 },
] as const;

function stableInstanceId(playerId: string, definitionId: string) {
  return `starter-${createHash("sha256").update(`${playerId}:${definitionId}`).digest("hex").slice(0, 24)}`;
}

export function ensureStarterInventory(db: DatabaseSync, playerId: string, now: string) {
  if (db.prepare("SELECT 1 FROM player_starter_grants WHERE player_id=?").get(playerId)) return;
  const insert = db.prepare(`
    INSERT OR IGNORE INTO item_instances(
      id,definition_id,owner_player_id,quantity,quality,durability,affixes_json,bound,equipped_slot,created_at,updated_at
    ) SELECT ?,id,?,?,1,max_durability,'[]',?,?,?,? FROM item_definitions WHERE id=?
  `);
  const starters = [
    ["cotton-robe", 1, 1, "body"], ["cloth-boots", 1, 1, "feet"], ["wooden-sword", 1, 1, "weapon"],
    ["water-flask", 3, 1, null], ["simple-meal", 2, 1, null], ["rice-seed", 6, 0, null],
    ["herb-seed", 4, 0, null], ["wood", 8, 0, null], ["iron-ore", 4, 0, null], ["farm-hoe", 1, 1, "tool"],
  ] as const;
  for (const [definitionId, quantity, bound, equippedSlot] of starters) {
    insert.run(stableInstanceId(playerId, definitionId), playerId, quantity, bound, equippedSlot, now, now, definitionId);
  }
  db.prepare("INSERT OR IGNORE INTO player_starter_grants(player_id,granted_at) VALUES (?,?)").run(playerId, now);
}

export function seedItemCatalog(db: DatabaseSync, revision: number, now: string) {
  const itemInsert = db.prepare(`
    INSERT INTO item_definitions(
      id,name,description,category,stackable,max_stack,base_value,max_durability,equipment_slot,tags_json,effects_json,
      version,is_active,seed_revision
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,1,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,category=excluded.category,
      stackable=excluded.stackable,max_stack=excluded.max_stack,base_value=excluded.base_value,
      max_durability=excluded.max_durability,equipment_slot=excluded.equipment_slot,tags_json=excluded.tags_json,
      effects_json=excluded.effects_json,is_active=1,seed_revision=excluded.seed_revision
  `);
  for (const item of ITEM_CATALOG) {
    itemInsert.run(
      item.id, item.name, item.description, item.category, item.stackable ? 1 : 0, item.maxStack ?? 1,
      item.baseValue, item.maxDurability ?? 0, item.equipmentSlot ?? null,
      JSON.stringify(item.tags ?? []), JSON.stringify(item.effects ?? {}), revision,
    );
  }

  const recipeInsert = db.prepare(`
    INSERT INTO recipe_definitions(
      id,name,description,facility_type,skill_id,duration_seconds,difficulty,inputs_json,outputs_json,
      version,is_active,seed_revision
    ) VALUES (?,?,?,?,?,?,?,?,?,1,1,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,
      facility_type=excluded.facility_type,skill_id=excluded.skill_id,duration_seconds=excluded.duration_seconds,
      difficulty=excluded.difficulty,inputs_json=excluded.inputs_json,outputs_json=excluded.outputs_json,
      is_active=1,seed_revision=excluded.seed_revision
  `);
  for (const recipe of RECIPE_CATALOG) {
    recipeInsert.run(
      recipe.id, recipe.name, recipe.description, recipe.facility, recipe.skill, recipe.duration,
      recipe.difficulty, JSON.stringify(recipe.inputs), JSON.stringify(recipe.outputs), revision,
    );
  }

  const cropInsert = db.prepare(`
    INSERT INTO crop_definitions(
      id,name,seed_item_id,harvest_item_id,growth_seconds,stages_json,seed_revision,is_active
    ) VALUES (?,?,?,?,?,?,?,1)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,seed_item_id=excluded.seed_item_id,
      harvest_item_id=excluded.harvest_item_id,growth_seconds=excluded.growth_seconds,
      stages_json=excluded.stages_json,seed_revision=excluded.seed_revision,is_active=1
  `);
  for (const crop of CROP_CATALOG) {
    cropInsert.run(crop.id, crop.name, crop.seed, crop.harvest, crop.growth, JSON.stringify({ yield: crop.yield }), revision);
  }

  const systemActionInsert = db.prepare(`
    INSERT INTO action_templates(
      id,name,description,category,target_kind,duration_seconds,requirements_json,check_json,costs_json,
      outcomes_json,result_template,adult,visibility,cooldown_seconds,version,is_active,seed_revision,created_at,updated_at
    ) VALUES (?,?,?,'production',?,0,'{}','{}','{}','{"success":{},"failure":{}}',?,0,'public',0,1,1,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,
      target_kind=excluded.target_kind,result_template=excluded.result_template,is_active=1,
      seed_revision=excluded.seed_revision,updated_at=excluded.updated_at
  `);
  for (const action of [
    ["action-craft-recipe", "按配方制作", "使用当前设施按配方制作物品。", "self", "{name}完成了一次配方制作。"],
    ["action-farm-plant", "播种", "在空农田中播下作物种子。", "plot", "{name}完成了播种。"],
    ["action-farm-water", "浇水", "为正在生长的作物补充水分。", "plot", "{name}完成了浇水。"],
    ["action-farm-harvest", "收获", "收获已经成熟的作物。", "plot", "{name}完成了收获。"],
  ] as const) systemActionInsert.run(...action, revision, now, now);

  const plotInsert = db.prepare(`
    INSERT OR IGNORE INTO farm_plots(
      id,facility_id,state,version,created_at,updated_at
    ) SELECT 'plot-'||id,id,'empty',1,?,? FROM location_facilities WHERE facility_type='farm' AND is_active=1
  `);
  plotInsert.run(now, now);

  const playerRows = db.prepare("SELECT id FROM players").all() as Array<{ id: string }>;
  for (const player of playerRows) ensureStarterInventory(db, player.id, now);
}
