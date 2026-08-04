import type { DatabaseSync } from "node:sqlite";
import { NPC_POPULATION, npcStableKey } from "./npc-seed";

export const NPC_CITY_SEED_REVISION = 1;

type Occupation = { cohort: string; key: string; name: string };

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
  for (const topic of [
    ["topic-greeting", "问候", "向对方问好。", "{npc}向你还礼，谈起今日东京城中的人情往来。", 1],
    ["topic-work", "营生", "询问对方的营生。", "{npc}说起自己作为{occupation}的一日营作。", 0],
    ["topic-city", "东京见闻", "询问附近见闻。", "{npc}提到御街、州桥与街市近来的消息。", 0],
  ] as const) topicInsert.run(...topic, NPC_CITY_SEED_REVISION);
  const topicAssignment = db.prepare("INSERT OR IGNORE INTO npc_dialogue_assignments(player_id,topic_id) VALUES (?,?)");
  for (let index = 0; index < NPC_POPULATION; index += 1) {
    for (const topicId of ["topic-greeting", "topic-work", "topic-city"]) topicAssignment.run(npcStableKey(index), topicId);
  }

  const commissionInsert = db.prepare(`
    INSERT INTO npc_commission_templates(
      id,title,description,objective_kind,objective_json,reward_wen,standing_reward,duration_seconds,seed_revision,is_active
    ) VALUES (?,?,?,?,?,?,?,?,?,1)
    ON CONFLICT(id) DO UPDATE SET title=excluded.title,description=excluded.description,objective_kind=excluded.objective_kind,
      objective_json=excluded.objective_json,reward_wen=excluded.reward_wen,standing_reward=excluded.standing_reward,
      duration_seconds=excluded.duration_seconds,seed_revision=excluded.seed_revision,is_active=1
  `);
  commissionInsert.run("commission-visit-zhou", "州桥探路", "亲自抵达州桥后回来复命。", "visit", JSON.stringify({ locationId: "song-landmark-bridge-zhou" }), 300, 3, 86_400, NPC_CITY_SEED_REVISION);
  commissionInsert.run("commission-observe", "留心街市", "完成一次观察四周后回来复命。", "action", JSON.stringify({ actionTemplateId: "action-observe" }), 240, 2, 86_400, NPC_CITY_SEED_REVISION);
  commissionInsert.run("commission-deliver-rice", "送来稻米", "交付一份未绑定且未被预留的稻米。", "deliver", JSON.stringify({ definitionId: "rice", quantity: 1 }), 420, 4, 86_400, NPC_CITY_SEED_REVISION);
  const offerInsert = db.prepare("INSERT OR IGNORE INTO npc_commission_offers(npc_id,template_id) VALUES (?,?)");
  const commissionIds = ["commission-visit-zhou", "commission-observe", "commission-deliver-rice"];
  for (let index = 0; index < NPC_POPULATION; index += 1) offerInsert.run(npcStableKey(index), commissionIds[index % commissionIds.length]);

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
