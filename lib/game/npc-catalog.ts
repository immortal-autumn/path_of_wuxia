import type { DatabaseSync } from "node:sqlite";
import { NPC_POPULATION, npcStableKey } from "./npc-seed";

export const NPC_CITY_SEED_REVISION = 2;

type Occupation = { cohort: string; key: string; name: string };

const NPC_DIALOGUE_TOPICS = [
  ["topic-greeting", "问候", "向对方问好。", "{npc}向你还礼，谈起今日东京城中的人情往来。", 1],
  ["topic-work", "营生", "询问对方的营生。", "{npc}说起自己作为{occupation}的一日营作。", 0],
  ["topic-city", "东京见闻", "询问附近见闻。", "{npc}提到御街、州桥与街市近来的消息。", 0],
  ["topic-market", "行市行情", "打听街市货价与客流。", "{npc}说起近来行市的货色、客商与议价门道。", 0],
  ["topic-craft", "手艺门道", "请教作坊里的手艺。", "{npc}谈到选料、火候与学徒打磨基本功的规矩。", 0],
  ["topic-law", "开封法度", "询问城中的法度与治安。", "{npc}提醒你遵守坊市规矩，也说起府衙近日处置的案情。", 0],
  ["topic-patrol", "巡城守门", "打听城门与巡更情形。", "{npc}说起交更时辰、城门盘验和夜间巡路的见闻。", 0],
  ["topic-learning", "经义学问", "请教读书与治学。", "{npc}谈起国子监讲学、经义章句与东京士林风气。", 0],
  ["topic-remedies", "药材诊疗", "请教常见药材与伤病。", "{npc}辨说几味常见药材，也提醒你伤重时莫要强撑。", 0],
  ["topic-performance", "瓦舍百戏", "询问东京的曲艺百戏。", "{npc}说起瓦舍勾栏的新曲、杂剧与台前幕后的辛苦。", 0],
  ["topic-neighborhood", "坊巷人情", "打听坊巷里的生活。", "{npc}讲起邻里往来、汲水买食和近日坊中的琐事。", 0],
  ["topic-travel", "商路脚程", "询问出行与运货路线。", "{npc}细说桥渡、城门与歇脚处，提醒你避开拥堵路段。", 0],
  ["topic-faith", "寺院香火", "询问寺院与香会。", "{npc}谈到大相国寺的斋会、钟鼓和往来香客。", 0],
  ["topic-waterways", "汴河舟运", "打听汴河与桥渡。", "{npc}说起漕舟到埠、桥下水势与沿岸脚店的消息。", 0],
  ["topic-gates", "城门出入", "询问城门与关津。", "{npc}告诉你各门往来的车马、盘验时辰与城外道路。", 0],
] as const;

function occupationTopicId(occupation: Occupation) {
  if (occupation.cohort === "shopkeeper" || occupation.cohort === "commerce_worker") return "topic-market";
  if (occupation.cohort === "assistant_artisan") return "topic-craft";
  if (occupation.cohort === "constable") return "topic-law";
  if (occupation.cohort === "patrol_guard") return "topic-patrol";
  if (occupation.key === "monk") return "topic-faith";
  if (occupation.key === "scholar") return "topic-learning";
  if (occupation.key === "healer") return "topic-remedies";
  if (occupation.key === "performer") return "topic-performance";
  if (occupation.key === "traveler") return "topic-travel";
  return "topic-neighborhood";
}

function areaTopicId(locationId: string) {
  if (locationId.includes("xiangguo")) return "topic-faith";
  if (locationId.includes("guozijian")) return "topic-learning";
  if (locationId.includes("gate-") || locationId.includes("-gate")) return "topic-gates";
  if (locationId.includes("bridge") || locationId.includes("river") || locationId.includes("water")) return "topic-waterways";
  if (locationId.includes("market") || locationId.includes("shop") || locationId.includes("street")) return "topic-market";
  return "topic-city";
}

function npcTopicIds(index: number, occupation: Occupation, workplace: string) {
  // Keep the first resident's original public conversation surface stable for saved tutorials and smoke tests.
  if (index === 0) return ["topic-greeting", "topic-work", "topic-city"];
  const topics = new Set(["topic-greeting", occupationTopicId(occupation), areaTopicId(workplace)]);
  for (const fallback of ["topic-work", "topic-city"]) {
    if (topics.size >= 3) break;
    topics.add(fallback);
  }
  return [...topics];
}

export function npcOccupation(index: number): Occupation {
  if (index < 120) return { cohort: "shopkeeper", key: "shopkeeper", name: "店主" };
  if (index < 128) return { cohort: "assistant_artisan", key: "assistant", name: "店铺帮工" };
  if (index < 136) return { cohort: "assistant_artisan", key: "artisan", name: "手艺人" };
  if (index < 144) return { cohort: "assistant_artisan", key: "apprentice", name: "学徒" };
  if (index < 152) return { cohort: "commerce_worker", key: "trader", name: "行商" };
  if (index < 160) return { cohort: "commerce_worker", key: "broker", name: "牙人" };
  if (index < 168) return { cohort: "commerce_worker", key: "porter", name: "脚夫" };
  if (index < 176) return { cohort: "constable", key: "constable", name: "巡检" };
  if (index < 184) return { cohort: "constable", key: "runner", name: "府衙公人" };
  if (index < 192) return { cohort: "patrol_guard", key: "patrol", name: "街巡" };
  if (index < 200) return { cohort: "patrol_guard", key: "guard", name: "门军" };
  if (index < 204) return { cohort: "specialist", key: "monk", name: "僧人" };
  if (index < 208) return { cohort: "specialist", key: "scholar", name: "士子" };
  if (index < 212) return { cohort: "specialist", key: "healer", name: "医者" };
  if (index < 216) return { cohort: "specialist", key: "performer", name: "艺人" };
  if (index < 228) return { cohort: "townsfolk", key: "resident", name: "坊民" };
  return { cohort: "townsfolk", key: "traveler", name: "行旅" };
}

function existingLocationIds(db: DatabaseSync, sql: string, ...params: Array<string | number>) {
  return (db.prepare(sql).all(...params) as Array<{ id: string }>).map((row) => row.id);
}

export function seedNpcCity(db: DatabaseSync, now: string) {
  const shops = db.prepare("SELECT id,location_id,name FROM shops WHERE is_active=1 ORDER BY id").all() as Array<{
    id: string; location_id: string; name: string;
  }>;
  if (shops.length !== 120) throw new Error("NPC city seed requires exactly 120 active shops.");
  const shopRooms = existingLocationIds(db, "SELECT id FROM locations WHERE is_active=1 AND id LIKE 'kaifeng-shop-%-room-%' ORDER BY id");
  const markets = existingLocationIds(db, `
    SELECT DISTINCT location.id FROM locations location JOIN location_facilities facility ON facility.location_id=location.id
    WHERE location.is_active=1 AND facility.is_active=1 AND facility.facility_type='market'
      AND (location.region_id='song' OR location.id LIKE 'kaifeng-%') ORDER BY location.id
  `);
  const prefecture = existingLocationIds(db, "SELECT id FROM locations WHERE is_active=1 AND id LIKE 'kaifeng-prefecture-%' ORDER BY id");
  const gates = existingLocationIds(db, "SELECT id FROM locations WHERE is_active=1 AND id LIKE 'song-landmark-gate-%' ORDER BY id");
  const streets = existingLocationIds(db, "SELECT id FROM locations WHERE is_active=1 AND region_id='song' ORDER BY id LIMIT 240");
  const specialist = [
    "kaifeng-xiangguo-main-hall", "kaifeng-guozijian-lecture-hall", "kaifeng-shop-medicine-room-3", "kaifeng-panlou-main-hall",
  ].filter((id) => db.prepare("SELECT 1 FROM locations WHERE id=? AND is_active=1").get(id));
  const routes = [
    ["route-npc-imperial", "御街巡行", ["song-landmark-gate-nanxun", "song-landmark-old-gate-zhuque", "song-landmark-bridge-zhou", "song-landmark-gate-xuande"]],
    ["route-npc-market", "潘楼街市", ["song-landmark-market-patlou", "song-landmark-bridge-zhou", "song-landmark-temple-xiangguo"]],
    ["route-npc-prefecture", "府署差役", ["song-landmark-office-kaifeng", "song-landmark-bridge-zhou", "song-landmark-gate-xuande"]],
    ["route-npc-river", "汴河脚程", ["song-landmark-bridge-zhou", "song-landmark-temple-xiangguo", "song-landmark-market-patlou"]],
    ["route-npc-south", "南城巡路", ["song-landmark-gate-nanxun", "song-landmark-old-gate-zhuque", "song-landmark-bridge-zhou"]],
    ["route-npc-east", "东关商路", ["song-overview-entry", "song-landmark-market-patlou", "song-landmark-bridge-zhou"]],
    ["route-npc-learning", "寺监访学", ["song-landmark-temple-xiangguo", "song-landmark-academy-guozijian", "song-landmark-bridge-zhou"]],
    ["route-npc-gates", "诸门巡更", ["song-landmark-gate-nanxun", "song-landmark-gate-east-water", "song-landmark-gate-xuande"]],
  ] as const;
  const routeInsert = db.prepare(`
    INSERT INTO npc_routes(id,name,loop,seed_revision,is_active) VALUES (?,?,1,?,1)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,seed_revision=excluded.seed_revision,is_active=1
  `);
  const stopInsert = db.prepare(`
    INSERT INTO npc_route_stops(route_id,sequence,location_id,dwell_minutes) VALUES (?,?,?,15)
    ON CONFLICT(route_id,sequence) DO UPDATE SET location_id=excluded.location_id
  `);
  for (const [routeId, name, stops] of routes) {
    routeInsert.run(routeId, name, NPC_CITY_SEED_REVISION);
    stops.forEach((locationId, sequence) => {
      if (db.prepare("SELECT 1 FROM locations WHERE id=? AND is_active=1").get(locationId)) stopInsert.run(routeId, sequence, locationId);
    });
  }

  const assignmentInsert = db.prepare(`
    INSERT INTO npc_assignments(
      player_id,cohort,occupation_key,occupation_name,workplace_location_id,home_location_id,
      shop_id,public_biography,seed_revision,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(player_id) DO UPDATE SET cohort=excluded.cohort,occupation_key=excluded.occupation_key,
      occupation_name=excluded.occupation_name,workplace_location_id=excluded.workplace_location_id,
      home_location_id=excluded.home_location_id,shop_id=excluded.shop_id,public_biography=excluded.public_biography,
      seed_revision=excluded.seed_revision,updated_at=excluded.updated_at
  `);
  const scheduleInsert = db.prepare(`
    INSERT INTO npc_schedule_entries(
      id,player_id,start_minute,end_minute,activity_kind,target_kind,target_location_id,route_id,seed_revision
    ) VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET activity_kind=excluded.activity_kind,target_kind=excluded.target_kind,
      target_location_id=excluded.target_location_id,route_id=excluded.route_id,seed_revision=excluded.seed_revision
  `);
  const scheduleSlots = [[0, 300, "歇宿"], [300, 420, "晨起"], [420, 720, "当值"], [720, 1080, "营生"], [1080, 1320, "晚间行止"], [1320, 1440, "归家"]] as const;

  for (let index = 0; index < NPC_POPULATION; index += 1) {
    const playerId = npcStableKey(index);
    const occupation = npcOccupation(index);
    let shopId: string | null = null;
    let workplace: string;
    if (index < 120) {
      const shop = shops[index];
      shopId = shop.id;
      workplace = shop.location_id;
    } else if (index < 144) {
      workplace = shopRooms[(index - 120) % Math.max(1, shopRooms.length)] ?? shops[(index - 120) % shops.length].location_id;
    } else if (index < 168) {
      workplace = markets[(index - 144) % Math.max(1, markets.length)] ?? shops[index % shops.length].location_id;
    } else if (index < 184) {
      workplace = prefecture[(index - 168) % Math.max(1, prefecture.length)] ?? "song-landmark-office-kaifeng";
    } else if (index < 200) {
      workplace = gates[(index - 184) % Math.max(1, gates.length)] ?? "song-landmark-gate-nanxun";
    } else if (index < 216) {
      workplace = specialist[(index - 200) % Math.max(1, specialist.length)] ?? "song-landmark-temple-xiangguo";
    } else {
      workplace = streets[(index - 216) % Math.max(1, streets.length)] ?? "song-landmark-bridge-zhou";
    }
    const home = index < 120
      ? (db.prepare(`
        SELECT service.location_id AS id FROM shop_service_locations service
        WHERE service.shop_id=? AND service.location_id<>? ORDER BY service.location_id DESC LIMIT 1
      `).get(shopId, workplace) as { id: string } | undefined)?.id ?? workplace
      : workplace;
    const isNew = !db.prepare("SELECT 1 FROM npc_assignments WHERE player_id=?").get(playerId);
    const currentIsKaifeng = db.prepare(`
      SELECT 1 FROM players player JOIN locations location ON location.id=player.current_location
      WHERE player.id=? AND location.is_active=1
        AND (location.region_id='song' OR location.layer_id LIKE 'kaifeng-%')
    `).get(playerId);
    if (isNew && !currentIsKaifeng) {
      db.prepare(`
        DELETE FROM item_reservations WHERE job_id IN (
          SELECT id FROM action_jobs WHERE player_id=? AND status IN ('running','queued','paused')
        )
      `).run(playerId);
      db.prepare(`
        UPDATE action_jobs SET status='cancelled',result_text='城市职住日程启用，旧行动已取消。',updated_at=?
        WHERE player_id=? AND status IN ('running','queued','paused')
      `).run(now, playerId);
      db.prepare("UPDATE players SET current_location=?,updated_at=? WHERE id=?").run(home, now, playerId);
    }
    const biography = `${occupation.name}，常在${index < 120 ? shops[index].name : "东京城中"}生活与营作。`;
    assignmentInsert.run(
      playerId, occupation.cohort, occupation.key, occupation.name, workplace, home,
      shopId, biography, NPC_CITY_SEED_REVISION, now, now,
    );
    db.prepare("UPDATE npc_profiles SET profession=?,home_location_id=?,updated_at=? WHERE player_id=?")
      .run(occupation.name, home, now, playerId);
    db.prepare("UPDATE players SET title=? WHERE id=?").run(occupation.name, playerId);
    const routeId = ["commerce_worker", "patrol_guard", "constable", "townsfolk"].includes(occupation.cohort)
      ? routes[index % routes.length][0] : null;
    for (let slot = 0; slot < scheduleSlots.length; slot += 1) {
      const [start, end, activity] = scheduleSlots[slot];
      const atHome = slot === 0 || slot === 5;
      const onRoute = routeId !== null && (slot === 1 || slot === 4);
      scheduleInsert.run(
        `schedule-${playerId}-${slot}`, playerId, start, end, activity,
        atHome ? "home" : onRoute ? "route" : "workplace",
        atHome ? home : onRoute ? null : workplace,
        onRoute ? routeId : null,
        NPC_CITY_SEED_REVISION,
      );
    }
  }

  const topicInsert = db.prepare(`
    INSERT INTO npc_dialogue_topics(id,title,player_prompt,reply_template,standing_delta,seed_revision,is_active)
    VALUES (?,?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET title=excluded.title,player_prompt=excluded.player_prompt,
      reply_template=excluded.reply_template,standing_delta=excluded.standing_delta,seed_revision=excluded.seed_revision,is_active=1
  `);
  for (const topic of NPC_DIALOGUE_TOPICS) topicInsert.run(...topic, NPC_CITY_SEED_REVISION);
  db.prepare(`
    DELETE FROM npc_dialogue_assignments
    WHERE player_id IN (SELECT player_id FROM npc_assignments WHERE seed_revision>0)
  `).run();
  const topicAssignment = db.prepare("INSERT OR IGNORE INTO npc_dialogue_assignments(player_id,topic_id) VALUES (?,?)");
  for (let index = 0; index < NPC_POPULATION; index += 1) {
    const assignment = db.prepare("SELECT cohort,occupation_key,occupation_name,workplace_location_id FROM npc_assignments WHERE player_id=?")
      .get(npcStableKey(index)) as {
        cohort: string; occupation_key: string; occupation_name: string; workplace_location_id: string;
      };
    const occupation = { cohort: assignment.cohort, key: assignment.occupation_key, name: assignment.occupation_name };
    for (const topicId of npcTopicIds(index, occupation, assignment.workplace_location_id)) {
      topicAssignment.run(npcStableKey(index), topicId);
    }
  }

  const commissionInsert = db.prepare(`
    INSERT INTO npc_commission_templates(
      id,title,description,objective_kind,objective_json,reward_wen,standing_reward,duration_seconds,seed_revision,is_active
    ) VALUES (?,?,?,?,?,?,?,?,?,1)
    ON CONFLICT(id) DO UPDATE SET title=excluded.title,description=excluded.description,objective_kind=excluded.objective_kind,
      objective_json=excluded.objective_json,reward_wen=excluded.reward_wen,standing_reward=excluded.standing_reward,
      duration_seconds=excluded.duration_seconds,seed_revision=excluded.seed_revision,is_active=1
  `);
  const commissions = [
    ["commission-visit-zhou", "州桥探路", "亲自抵达州桥后回来复命。", "visit", { locationId: "song-landmark-bridge-zhou" }, 300, 3],
    ["commission-observe", "留心街市", "完成一次观察四周后回来复命。", "action", { actionTemplateId: "action-observe" }, 240, 2],
    ["commission-deliver-rice", "送来稻米", "交付一份未绑定且未被预留的稻米。", "deliver", { definitionId: "rice", quantity: 1 }, 420, 4],
    ["commission-visit-market", "潘楼问市", "到潘楼街市察看客流后回来复命。", "visit", { locationId: "song-landmark-market-patlou" }, 360, 3],
    ["commission-visit-prefecture", "府署递话", "到开封府署走一趟，再回来说明沿途情形。", "visit", { locationId: "song-landmark-office-kaifeng" }, 380, 3],
    ["commission-visit-xiangguo", "寺前访客", "到大相国寺探看香客往来后回来复命。", "visit", { locationId: "song-landmark-temple-xiangguo" }, 360, 3],
    ["commission-visit-nanxun", "南薰门脚程", "到南薰门核对车马出入后回来复命。", "visit", { locationId: "song-landmark-gate-nanxun" }, 400, 3],
    ["commission-listen", "听辨动静", "完成一次凝神聆听，记下附近的公开动静。", "action", { actionTemplateId: "action-listen" }, 260, 2],
    ["commission-study", "温习经义", "完成一次研读，回来交流所得。", "action", { actionTemplateId: "action-study" }, 520, 4],
    ["commission-deliver-herb", "添补药材", "交付一份未绑定且未被预留的药草。", "deliver", { definitionId: "herb", quantity: 1 }, 520, 4],
    ["commission-deliver-wood", "送来木料", "交付一份未绑定且未被预留的木材。", "deliver", { definitionId: "wood", quantity: 1 }, 540, 4],
    ["commission-deliver-paper", "捎来楮纸", "交付一份未绑定且未被预留的楮纸。", "deliver", { definitionId: "paper", quantity: 1 }, 480, 4],
  ] as const;
  for (const [id, title, description, kind, objective, reward, standing] of commissions) {
    commissionInsert.run(
      id, title, description, kind, JSON.stringify(objective), reward, standing, 86_400, NPC_CITY_SEED_REVISION,
    );
  }
  db.prepare(`
    DELETE FROM npc_commission_offers
    WHERE npc_id IN (SELECT player_id FROM npc_assignments WHERE seed_revision>0)
  `).run();
  const offerInsert = db.prepare("INSERT OR IGNORE INTO npc_commission_offers(npc_id,template_id) VALUES (?,?)");
  const cohortCommissions: Record<string, readonly string[]> = {
    shopkeeper: ["commission-visit-zhou", "commission-observe", "commission-deliver-rice", "commission-visit-market", "commission-deliver-paper"],
    assistant_artisan: ["commission-listen", "commission-deliver-wood", "commission-observe"],
    commerce_worker: ["commission-visit-market", "commission-deliver-rice", "commission-listen"],
    constable: ["commission-visit-prefecture", "commission-listen"],
    patrol_guard: ["commission-visit-nanxun", "commission-listen"],
    specialist: ["commission-visit-xiangguo", "commission-study", "commission-deliver-herb"],
    townsfolk: ["commission-visit-zhou", "commission-observe", "commission-deliver-rice"],
  };
  for (let index = 0; index < NPC_POPULATION; index += 1) {
    const occupation = npcOccupation(index);
    const cohortTemplates = cohortCommissions[occupation.cohort];
    offerInsert.run(npcStableKey(index), cohortTemplates[index % cohortTemplates.length]);
  }

  db.prepare("DELETE FROM npc_relationships WHERE seed_revision>0").run();
  const relationshipInsert = db.prepare(`
    INSERT INTO npc_relationships(npc_a_id,npc_b_id,relationship_kind,public_note,seed_revision)
    VALUES (?,?,?,?,?)
  `);
  const addPairs = (start: number, count: number, kind: string, note: string, pairOffset = 1) => {
    for (let pair = 0; pair < count; pair += 1) {
      const a = npcStableKey(start + pair * 2);
      const b = npcStableKey(start + pair * 2 + pairOffset);
      relationshipInsert.run(a < b ? a : b, a < b ? b : a, kind, note, NPC_CITY_SEED_REVISION);
    }
  };
  for (let index = 0; index < 24; index += 1) {
    relationshipInsert.run(npcStableKey(index), npcStableKey(120 + index), "employment", "店主与帮工同在一处营生。", NPC_CITY_SEED_REVISION);
  }
  addPairs(144, 12, "business", "两人常结伴运货经商。");
  addPairs(168, 8, "colleague", "两人在府衙一同当值。");
  addPairs(184, 8, "patrol", "两人结伴巡城守门。");
  addPairs(200, 8, "peer", "两人常交流各自所学。");
  addPairs(216, 12, "household", "两人是同坊邻里或同行旅伴。");
}
