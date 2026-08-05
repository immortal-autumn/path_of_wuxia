import type { DatabaseSync } from "node:sqlite";
import type { ActionCategory, ActionCheck, ActionOutcome, ActionRequirement, ActionTargetKind, ActionVisibility } from "./types";

type CatalogLocation = { id: string; name: string; regionId: string | null };

type CatalogAction = {
  id: string;
  name: string;
  description: string;
  category: ActionCategory;
  targetKind?: ActionTargetKind;
  durationSeconds: number;
  facilityTypes: string[];
  requirements?: ActionRequirement;
  check?: ActionCheck;
  costs?: ActionOutcome;
  success?: ActionOutcome;
  failure?: ActionOutcome;
  resultTemplate: string;
  visibility?: ActionVisibility;
  adult?: boolean;
  cooldownSeconds?: number;
};

export const ACTION_SKILLS = [
  ["perception", "观察", "发现环境细节、人物状态与隐蔽线索。", "spirit", "perception", "passive"],
  ["hearing", "聆听", "辨别附近声响与行动痕迹。", "spirit", "perception", "passive"],
  ["eagle-eye", "鹰眼", "立即扩大地图视野，效果结束后可再次发动。", "spirit", "perception", "active"],
  ["qinggong", "轻功", "立即沿八方向越过多个网格，发动后进入冷却。", "agility", "movement", "active"],
  ["stealth", "潜行", "隐蔽行动、追踪与偷窃。", "agility", "movement", "active"],
  ["farming", "农耕", "耕地、播种、照料与收获作物。", "constitution", "production", "passive"],
  ["cooking", "烹饪", "处理食材并制作饮食。", "comprehension", "production", "passive"],
  ["medicine", "医术", "疗伤、诊断与处理药材。", "comprehension", "production", "passive"],
  ["alchemy", "炼丹", "以药材炼制丹药。", "root", "production", "passive"],
  ["smithing", "锻造", "打造、修理武器与护具。", "strength", "production", "passive"],
  ["crafting", "制作", "加工材料并使用工坊设施。", "comprehension", "production", "passive"],
  ["unarmed", "拳掌", "徒手攻防与切磋。", "strength", "combat", "passive"],
] as const;

export const ACTION_CATALOG: CatalogAction[] = [
  {
    id: "action-observe", name: "观察四周", description: "用十秒查看当前地点的细节。", category: "perception",
    durationSeconds: 10, facilityTypes: ["surroundings"], requirements: { skillId: "perception" },
    check: { attribute: "spirit", skillId: "perception", difficulty: -30 }, success: { skillExperience: 8 },
    failure: { skillExperience: 3 }, resultTemplate: "{name}仔细观察了四周。", visibility: "private",
  },
  {
    id: "action-listen", name: "凝神聆听", description: "用半分钟静心分辨附近的声响与活动。", category: "perception",
    durationSeconds: 30, facilityTypes: ["surroundings"], requirements: { skillId: "hearing" },
    check: { attribute: "spirit", skillId: "hearing", difficulty: -20 }, success: { skillExperience: 10 },
    failure: { skillExperience: 4 }, resultTemplate: "{name}凝神听取附近的动静。", visibility: "private",
  },
  {
    id: "action-eagle-eye", name: "开启鹰眼", description: "立即扩展感知，随后三十分钟内看见更远地点。", category: "perception",
    durationSeconds: 0, facilityTypes: ["surroundings"], requirements: { skillId: "eagle-eye" },
    check: { attribute: "spirit", skillId: "eagle-eye", difficulty: -10 },
    success: { skillExperience: 12, statusId: "eagle-eye", statusDurationSeconds: 1800 },
    failure: { skillExperience: 5 }, resultTemplate: "{name}尝试将感知延伸至远方。", visibility: "private", cooldownSeconds: 1800,
  },
  {
    id: "action-drink-water", name: "饮水", description: "花两分钟慢慢补充水分。", category: "life",
    durationSeconds: 120, facilityTypes: ["water", "kitchen"], success: { needDeltas: { hydration: 35, bladder: 10 } },
    resultTemplate: "{name}喝了些水，精神清醒了不少。",
  },
  {
    id: "action-use-toilet", name: "如厕", description: "处理如厕需求并整理卫生。", category: "life",
    durationSeconds: 300, facilityTypes: ["toilet"], success: { needDeltas: { bladder: -90, hygiene: -3 } },
    resultTemplate: "{name}解决了如厕需求。", visibility: "private",
  },
  {
    id: "action-wash", name: "洗漱", description: "清洁面容与双手。", category: "life",
    durationSeconds: 600, facilityTypes: ["wash", "bath"], success: { needDeltas: { hygiene: 35 } },
    resultTemplate: "{name}认真洗漱了一番。", visibility: "private",
  },
  {
    id: "action-bathe", name: "沐浴", description: "完整沐浴并放松身体。", category: "life",
    durationSeconds: 1800, facilityTypes: ["bath"], success: { needDeltas: { hygiene: 85, fatigue: -5 } },
    resultTemplate: "{name}沐浴完毕，换上了干净衣物。", visibility: "private",
  },
  {
    id: "action-eat-meal", name: "用餐", description: "用二十分钟吃一顿简单饭食。", category: "life",
    durationSeconds: 1200, facilityTypes: ["dining", "kitchen"], success: { needDeltas: { satiety: 50, hydration: 5, bladder: 5 } },
    resultTemplate: "{name}安静地吃完了一顿饭。",
  },
  {
    id: "action-rest", name: "休息一小时", description: "坐下休息，让身体稍作恢复。", category: "life",
    durationSeconds: 3600, facilityTypes: ["bed", "social", "road-camp"], success: { hpDelta: 10, needDeltas: { fatigue: -15 } },
    resultTemplate: "{name}休息了一小时。",
  },
  {
    id: "action-sleep", name: "睡眠八小时", description: "安排一次完整睡眠。", category: "life",
    durationSeconds: 28_800, facilityTypes: ["bed"], success: { hpDelta: 50, needDeltas: { fatigue: -100, hygiene: -8, satiety: -20, hydration: -25, bladder: 35 } },
    resultTemplate: "{name}完成了一次八小时睡眠。", visibility: "private",
  },
  {
    id: "action-cultivate-hour", name: "静心修炼一小时", description: "在适合的设施中完成一小时吐纳。", category: "cultivation",
    durationSeconds: 3600, facilityTypes: ["training"], check: { attribute: "root", difficulty: 30 },
    success: { cultivationDelta: 120, skillExperience: 8, needDeltas: { fatigue: 8, hydration: -4 } },
    failure: { cultivationDelta: 40, needDeltas: { fatigue: 8, hydration: -4 } },
    resultTemplate: "{name}完成了一小时吐纳修炼。",
  },
  {
    id: "action-body-training", name: "练体一小时", description: "以一小时进行基础力量与体能训练。", category: "cultivation",
    durationSeconds: 3600, facilityTypes: ["gym", "training"], requirements: { skillId: "unarmed" },
    check: { attribute: "constitution", skillId: "unarmed", difficulty: 40 },
    success: { skillExperience: 18, hpDelta: -2, needDeltas: { fatigue: 15, hydration: -8, hygiene: -5 } },
    failure: { skillExperience: 8, hpDelta: -8, needDeltas: { fatigue: 18, hydration: -8, hygiene: -5 } },
    resultTemplate: "{name}完成了一小时练体。",
  },
  {
    id: "action-study", name: "研读一小时", description: "在书房集中阅读与研究。", category: "cultivation",
    durationSeconds: 3600, facilityTypes: ["study", "lore"], check: { attribute: "comprehension", difficulty: 40 },
    success: { skillExperience: 12, cultivationDelta: 30, needDeltas: { fatigue: 5 } },
    failure: { skillExperience: 4, needDeltas: { fatigue: 5 } },resultTemplate: "{name}专心研读了一小时。",
  },
  {
    id: "action-work-shift", name: "做工八小时", description: "在城镇或市场完成一班现实八小时的工作。", category: "production",
    durationSeconds: 28_800, facilityTypes: ["settlement", "market"], check: { attribute: "constitution", difficulty: 45 },
    success: { cashWenDelta: 40_000, needDeltas: { fatigue: 35, satiety: -25, hydration: -30, hygiene: -10, bladder: 25 } },
    failure: { cashWenDelta: 15_000, needDeltas: { fatigue: 35, satiety: -25, hydration: -30, hygiene: -10, bladder: 25 } },
    resultTemplate: "{name}完成了一班工作。",
  },
  {
    id: "action-road-camp", name: "临时扎营", description: "在道路或野外花一小时整理临时休息处。", category: "life",
    durationSeconds: 3600, facilityTypes: ["road", "wilderness"], check: { attribute: "constitution", difficulty: 35 },
    success: { hpDelta: 5, needDeltas: { fatigue: -10 } }, failure: { needDeltas: { fatigue: -3 } },
    resultTemplate: "{name}在野外整理出一处临时营地。",
  },
  {
    id: "action-qinggong", name: "施展轻功", description: "沿八方向跨越多个网格抵达指定地点。", category: "movement",
    durationSeconds: 0, facilityTypes: [], requirements: { skillId: "qinggong" },
    check: { attribute: "agility", skillId: "qinggong", difficulty: 0 },
    success: { skillExperience: 15, needDeltas: { fatigue: 3, hydration: -2 } },
    failure: { skillExperience: 6, hpDelta: -5, needDeltas: { fatigue: 5 } },
    resultTemplate: "{name}施展轻功越过数格。", cooldownSeconds: 60,
  },
  {
    id: "action-private-intimacy", name: "私密亲昵", description: "仅在双方确认成年、开启成人内容并逐次同意后进行。", category: "intimate",
    targetKind: "player", durationSeconds: 900, facilityTypes: [], adult: true, visibility: "participants",
    requirements: { sameLocation: true, targetOnline: true },
    success: { needDeltas: { fatigue: 2 }, skillExperience: 1 },
    resultTemplate: "{name}与受邀者完成了一次双方同意的私密互动。",
  },
];

const HOME_FACILITIES: Record<string, string[]> = {
  "home-entrance": ["wardrobe"],
  "home-front-garden": ["garden", "farm"],
  "home-hall": ["social"],
  "home-guest-bathroom": ["toilet", "wash"],
  "home-living-room": ["social"],
  "home-dining-room": ["dining", "social"],
  "home-kitchen": ["kitchen", "water"],
  "home-garage": ["storage", "workshop"],
  "home-main-bathroom": ["toilet", "wash", "bath"],
  "home-main-bedroom": ["bed", "social"],
  "home-ying-study": ["study"],
  "home-lou-study": ["study"],
  "home-guest-bedroom": ["bed"],
  "home-training-room": ["training"],
  "home-gym": ["gym", "training"],
  "home-workshop": ["workshop", "alchemy", "smithy"],
  "home-storage": ["storage"],
  "home-utility-room": ["maintenance", "water"],
  "home-back-garden": ["garden", "farm"],
  "home-greenhouse": ["greenhouse", "farm"],
  "home-pavilion": ["social", "garden"],
};

const KAIFENG_INTERIOR_FACILITIES: Record<string, string[]> = {
  "kaifeng-palace-ground": ["settlement", "lore", "social"],
  "kaifeng-prefecture-ground": ["settlement", "study", "lore"],
  "kaifeng-xiangguo-ground": ["settlement", "lore"],
  "kaifeng-guozijian-ground": ["settlement", "study", "lore"],
  "kaifeng-panlou-ground": ["settlement", "market", "social"],
};

function isFastTravelHub(location: CatalogLocation) {
  return [
    "home-entrance",
    "song-gate",
    "song-overview-entry",
    "song-landmark-bridge-zhou",
    "song-landmark-office-kaifeng",
    "song-landmark-temple-xiangguo",
    "song-landmark-academy-guozijian",
    "song-landmark-market-patlou",
  ].includes(location.id)
    || location.id.startsWith("song-landmark-gate-");
}

function facilitiesFor(location: CatalogLocation) {
  const result = new Set(["surroundings", ...(HOME_FACILITIES[location.id] ?? [])]);
  if (isFastTravelHub(location)) result.add("fast-travel");
  const interiorPrefix = Object.keys(KAIFENG_INTERIOR_FACILITIES).find((prefix) => location.id.startsWith(prefix.replace("-ground", "-")));
  if (interiorPrefix) {
    for (const facility of KAIFENG_INTERIOR_FACILITIES[interiorPrefix]) result.add(facility);
  }
  if (location.id === "kaifeng-xiangguo-market-court" || location.id.includes("xiangguo-east-market") || location.id.includes("xiangguo-west-market")) {
    result.add("market");
  }
  if (location.id === "kaifeng-panlou-kitchen") {
    result.add("kitchen");
    result.add("water");
  }
  if (location.id === "kaifeng-panlou-main-hall" || location.id.includes("panlou-east-room") || location.id.includes("panlou-west-room")) {
    result.add("dining");
  }
  if (location.id.startsWith("kaifeng-shop-")) {
    result.add("settlement");
    result.add("market");
    result.add("shop");
  }
  if (
    location.id.startsWith("song-street-")
    && !["街", "沿岸", "牙道", "驿道"].some((part) => location.name.includes(part))
  ) {
    result.add("market");
    result.add("shop");
  }
  if (
    location.name.includes("官道") || location.name === "楼门路" || location.name.includes("道路")
    || location.name.includes("航路") || (location.regionId === "song" && ["街", "沿岸", "牙道", "驿道", "桥", "门"].some((part) => location.name.includes(part)))
  ) result.add("road");
  if (location.name.includes("治所")) result.add("settlement");
  if (location.regionId === "song") result.add("settlement");
  if (
    location.name.includes("驿市")
    || (location.regionId === "song" && ["市", "瓦子", "行", "酒店", "相国寺", "甜水巷", "清风楼"].some((part) => location.name.includes(part)))
  ) result.add("market");
  return [...result];
}

export function seedActionCatalog(db: DatabaseSync, locations: CatalogLocation[], revision: number, now: string) {
  db.prepare("UPDATE action_templates SET is_active=0 WHERE seed_revision>0 AND seed_revision<?").run(revision);
  db.prepare("UPDATE location_facilities SET is_active=0 WHERE seed_revision>0 AND seed_revision<?").run(revision);
  db.prepare("UPDATE location_action_bindings SET is_active=0 WHERE seed_revision>0 AND seed_revision<?").run(revision);

  const skillInsert = db.prepare(`
    INSERT INTO skill_definitions(id,name,description,attribute_key,category,skill_kind,is_active,seed_revision)
    VALUES (?,?,?,?,?,?,1,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,
      attribute_key=excluded.attribute_key,category=excluded.category,skill_kind=excluded.skill_kind,is_active=1,seed_revision=excluded.seed_revision
    WHERE skill_definitions.seed_revision>0
  `);
  for (const skill of ACTION_SKILLS) skillInsert.run(...skill, revision);

  const facilityInsert = db.prepare(`
    INSERT INTO location_facilities(
      id,location_id,facility_type,quality,capacity,config_json,version,is_active,seed_revision,created_at,updated_at
    ) VALUES (?,?,?,1,1,'{}',1,1,?,?,?)
    ON CONFLICT(location_id,facility_type) DO UPDATE SET is_active=1,seed_revision=excluded.seed_revision,updated_at=excluded.updated_at
  `);
  const facilities = new Map<string, Array<{ id: string; type: string }>>();
  for (const location of locations) {
    const rows = facilitiesFor(location).map((type) => ({ id: `facility-${location.id}-${type}`, type }));
    facilities.set(location.id, rows);
    for (const facility of rows) facilityInsert.run(facility.id, location.id, facility.type, revision, now, now);
  }

  const templateInsert = db.prepare(`
    INSERT INTO action_templates(
      id,name,description,category,target_kind,duration_seconds,requirements_json,check_json,costs_json,
      outcomes_json,result_template,adult,visibility,cooldown_seconds,version,is_active,seed_revision,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,1,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,category=excluded.category,
      target_kind=excluded.target_kind,duration_seconds=excluded.duration_seconds,requirements_json=excluded.requirements_json,
      check_json=excluded.check_json,costs_json=excluded.costs_json,outcomes_json=excluded.outcomes_json,
      result_template=excluded.result_template,adult=excluded.adult,visibility=excluded.visibility,
      cooldown_seconds=excluded.cooldown_seconds,is_active=1,
      seed_revision=excluded.seed_revision,updated_at=excluded.updated_at
    WHERE action_templates.seed_revision>0
  `);
  const bindingInsert = db.prepare(`
    INSERT INTO location_action_bindings(
      id,location_id,action_template_id,facility_id,priority,is_active,seed_revision,created_at,updated_at
    ) VALUES (?,?,?,?,0,1,?,?,?)
    ON CONFLICT(location_id,action_template_id) DO UPDATE SET facility_id=excluded.facility_id,
      is_active=1,seed_revision=excluded.seed_revision,updated_at=excluded.updated_at
    WHERE location_action_bindings.seed_revision>0
  `);
  for (const action of ACTION_CATALOG) {
    const requirements = { ...(action.requirements ?? {}) };
    templateInsert.run(
      action.id, action.name, action.description, action.category, action.targetKind ?? "self", action.durationSeconds,
      JSON.stringify(requirements), JSON.stringify(action.check ?? {}), JSON.stringify(action.costs ?? {}),
      JSON.stringify({ success: action.success ?? {}, failure: action.failure ?? {} }),action.resultTemplate,
      action.adult ? 1 : 0, action.visibility ?? "public", action.cooldownSeconds ?? 0, revision, now, now,
    );
    for (const location of locations) {
      const facility = facilities.get(location.id)?.find((item) => action.facilityTypes.includes(item.type));
      if (!facility) continue;
      bindingInsert.run(`binding-${location.id}-${action.id}`, location.id, action.id, facility.id, revision, now, now);
    }
  }
}
