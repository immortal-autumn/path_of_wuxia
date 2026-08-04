import type { DatabaseSync } from "node:sqlite";
import { agentTokenHash, npcAgentToken, npcTradeAgentToken } from "./npc-auth";
import { deriveStats } from "./progression";
import { canonicalJson, fallbackNpcTradeStrategy, npcTradeStrategyHash } from "./npc-trade";

export const NPC_POPULATION = 240;

const FAMILY_NAMES = ["沈", "顾", "谢", "陆", "裴", "苏", "叶", "楚", "宁", "洛", "白", "秦", "江", "柳", "温", "萧"];
const GIVEN_NAMES = ["听澜", "照夜", "临风", "知微", "怀瑾", "清和", "无尘", "青崖", "长歌", "星河", "问舟", "霁月", "凌霜", "砚秋", "云归", "观棋", "景行", "含章", "疏影", "逐风"];
const PROFESSIONS = ["行商", "农人", "医者", "镖师", "书生", "猎人", "工匠", "游侠", "厨师", "药师"];

export function npcStableKey(index: number) {
  return `npc-${String(index + 1).padStart(3, "0")}`;
}

function availableName(db: DatabaseSync, npcId: string, index: number) {
  for (let offset = 0; offset < FAMILY_NAMES.length * GIVEN_NAMES.length; offset += 1) {
    const cursor = (index + offset) % (FAMILY_NAMES.length * GIVEN_NAMES.length);
    const candidate = `${FAMILY_NAMES[cursor % FAMILY_NAMES.length]}${GIVEN_NAMES[Math.floor(cursor / FAMILY_NAMES.length)]}`;
    const held = db.prepare("SELECT id FROM players WHERE name=?").get(candidate) as { id: string } | undefined;
    if (!held || held.id === npcId) return candidate;
  }
  return `${FAMILY_NAMES[index % FAMILY_NAMES.length]}${GIVEN_NAMES[index % GIVEN_NAMES.length]}${index + 1}`;
}

export function ensureNpcPopulation(db: DatabaseSync, now: string, count = NPC_POPULATION) {
  const locations = db.prepare(`
    SELECT id FROM locations WHERE is_active=1 ORDER BY
      CASE WHEN id='home-entrance' THEN 0 WHEN region_id IS NOT NULL THEN 1 ELSE 2 END,id
  `).all() as Array<{ id: string }>;
  if (locations.length === 0) throw new Error("NPC population requires at least one active location.");
  const initial = deriveStats({ strength: 10, agility: 10, constitution: 10, root: 10, comprehension: 10, spirit: 10 }, 0);
  const playerInsert = db.prepare(`
    INSERT OR IGNORE INTO players(
      id,name,title,hp,max_hp,stamina,max_stamina,cultivation,silver,current_location,
      controller_kind,adult_status,adult_content_enabled,created_at,updated_at,last_seen_at
    ) VALUES (?,?,?,?,?,?,?,0,?,?, 'npc','unknown',0,?,?,?)
  `);
  const profileInsert = db.prepare(`
    INSERT INTO npc_profiles(
      player_id,stable_key,controller_mode,personality_json,goals_json,profession,home_location_id,next_think_at,created_at,updated_at
    ) VALUES (?,?,'utility',?,?,?,?,?,?,?)
    ON CONFLICT(player_id) DO UPDATE SET stable_key=excluded.stable_key,updated_at=excluded.updated_at
  `);
  for (let index = 0; index < count; index += 1) {
    const stableKey = npcStableKey(index);
    const playerId = stableKey;
    const location = locations[Math.floor((index * locations.length) / count)]?.id ?? locations[0].id;
    const name = availableName(db, playerId, index);
    playerInsert.run(
      playerId, name, PROFESSIONS[index % PROFESSIONS.length], initial.maxHp, initial.maxHp,
      initial.maxEndurance, initial.maxEndurance, 10 + (index % 40), location, now, now, now,
    );
    profileInsert.run(
      playerId, stableKey,
      JSON.stringify({ temperament: ["沉稳", "好奇", "谨慎", "豪爽"][index % 4], sociability: 30 + (index * 17) % 71 }),
      JSON.stringify(["维持生活需求", "探索附近地点", "提升技能"]),
      PROFESSIONS[index % PROFESSIONS.length], location, now, now, now,
    );
    db.prepare("DELETE FROM agent_credentials WHERE player_id=? AND label IN ('npc-runner','npc-trade-runner')").run(playerId);
    db.prepare(`
      INSERT INTO agent_credentials(token_hash,player_id,label,scope,created_at) VALUES (?,?,'npc-runner','gameplay',?)
    `).run(agentTokenHash(npcAgentToken(stableKey)), playerId, now);
    db.prepare(`
      INSERT INTO agent_credentials(token_hash,player_id,label,scope,created_at) VALUES (?,?,'npc-trade-runner','market-trade',?)
    `).run(agentTokenHash(npcTradeAgentToken(stableKey)), playerId, now);
    const tradeStrategy = fallbackNpcTradeStrategy(stableKey);
    db.prepare(`
      INSERT OR IGNORE INTO npc_trade_strategies(
        id,player_id,version,schema_version,source,strategy_json,strategy_hash,active,created_at
      ) VALUES (?, ?,1,1,'builtin',?,?,1,?)
    `).run(
      `npc-trade-strategy-${stableKey}-1`, playerId,
      canonicalJson(tradeStrategy), npcTradeStrategyHash(tradeStrategy), now,
    );
  }
}
