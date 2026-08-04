import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openGameDatabase, type GameDatabase } from "../lib/game/database";
import { clientMessageSchema } from "../lib/game/protocol";
import { GameService } from "../lib/game/service";

describe("scheduled Kaifeng NPC residents", () => {
  let db: GameDatabase;
  let service: GameService;
  let clock: Date;

  beforeEach(() => {
    db = openGameDatabase(":memory:");
    clock = new Date("2026-08-04T04:00:00.000Z");
    service = new GameService(db, () => new Date(clock), () => 0);
  });

  afterEach(() => db.close());

  it("seeds the exact resident cohorts, occupations, workplaces, schedules and public links", () => {
    expect(db.prepare(`
      SELECT cohort,COUNT(*) AS count FROM npc_assignments GROUP BY cohort ORDER BY cohort
    `).all()).toEqual([
      { cohort: "assistant_artisan", count: 24 },
      { cohort: "commerce_worker", count: 24 },
      { cohort: "constable", count: 16 },
      { cohort: "patrol_guard", count: 16 },
      { cohort: "shopkeeper", count: 120 },
      { cohort: "specialist", count: 16 },
      { cohort: "townsfolk", count: 24 },
    ]);
    expect(db.prepare(`
      SELECT occupation_key,COUNT(*) AS count FROM npc_assignments
      GROUP BY occupation_key ORDER BY occupation_key
    `).all()).toEqual(expect.arrayContaining([
      { occupation_key: "assistant", count: 8 },
      { occupation_key: "artisan", count: 8 },
      { occupation_key: "apprentice", count: 8 },
      { occupation_key: "broker", count: 8 },
      { occupation_key: "constable", count: 8 },
      { occupation_key: "guard", count: 8 },
      { occupation_key: "healer", count: 4 },
      { occupation_key: "monk", count: 4 },
      { occupation_key: "performer", count: 4 },
      { occupation_key: "porter", count: 8 },
      { occupation_key: "resident", count: 12 },
      { occupation_key: "runner", count: 8 },
      { occupation_key: "scholar", count: 4 },
      { occupation_key: "trader", count: 8 },
      { occupation_key: "traveler", count: 12 },
    ]));
    expect(db.prepare(`
      SELECT COUNT(*) AS count,COUNT(DISTINCT shop_id) AS shops FROM npc_assignments
      WHERE cohort='shopkeeper' AND shop_id IS NOT NULL
    `).get()).toEqual({ count: 120, shops: 120 });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM (
        SELECT player_id,COUNT(*) AS entries,SUM(end_minute-start_minute) AS minutes
        FROM npc_schedule_entries GROUP BY player_id HAVING entries=6 AND minutes=1440
      )
    `).get()).toEqual({ count: 240 });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM npc_assignments assignment
      JOIN locations workplace ON workplace.id=assignment.workplace_location_id AND workplace.is_active=1
      JOIN locations home ON home.id=assignment.home_location_id AND home.is_active=1
    `).get()).toEqual({ count: 240 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM npc_relationships").get()).toEqual({ count: 72 });
  });

  it("exposes only public person detail and caps greeting standing once per China day", () => {
    const player = service.createSession().player;
    const npcId = "npc-001";
    const npcLocation = service.getPlayer(npcId).currentLocation;
    db.prepare("UPDATE players SET current_location=? WHERE id=?").run(npcLocation, player.id);
    const online = [player.id, npcId];

    const detail = service.getPersonDetail(player.id, npcId, online);
    expect(detail).toMatchObject({ id: npcId, occupation: "店主", standing: { value: 0, label: "陌生" } });
    expect(detail.dialogueTopics).toHaveLength(3);
    expect(detail.commissionOffers).toHaveLength(1);
    expect(JSON.stringify(detail)).not.toMatch(/controller|credential|token|stableKey|personality|goals/i);

    const first = service.chooseNpcDialogue(player.id, npcId, "topic-greeting", online);
    const second = service.chooseNpcDialogue(player.id, npcId, "topic-greeting", online);
    expect(first.person.standing).toEqual({ value: 1, label: "陌生" });
    expect(second.person.standing).toEqual({ value: 1, label: "陌生" });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM npc_standing_events
      WHERE player_id=? AND npc_id=? AND reason='daily-dialogue'
    `).get(player.id, npcId)).toEqual({ count: 1 });
  });

  it("accepts, replays, progresses and atomically completes a visit commission", () => {
    const player = service.createSession().player;
    const npcId = "npc-001";
    const npcLocation = service.getPlayer(npcId).currentLocation;
    db.prepare("UPDATE players SET current_location=? WHERE id=?").run(npcLocation, player.id);
    const online = [player.id, npcId];
    const beforeCash = service.getPlayer(player.id).cashWen;

    const accepted = service.acceptNpcCommission(
      player.id, npcId, "commission-visit-zhou", "accept-visit-1", online,
    );
    const commission = accepted.commissions[0];
    expect(commission).toMatchObject({ templateId: "commission-visit-zhou", status: "active", ready: false });
    expect(service.acceptNpcCommission(
      player.id, npcId, "commission-visit-zhou", "accept-visit-1", online,
    ).commissions).toHaveLength(1);

    clock = new Date(clock.getTime() + 1_000);
    db.prepare(`
      INSERT INTO player_visited_locations(player_id,location_id,first_visited_at,last_visited_at)
      VALUES (?,'song-landmark-bridge-zhou',?,?)
      ON CONFLICT(player_id,location_id) DO UPDATE SET last_visited_at=excluded.last_visited_at
    `).run(player.id, clock.toISOString(), clock.toISOString());
    expect(service.getPlayerCommissions(player.id)[0]).toMatchObject({ status: "ready", ready: true });

    const completed = service.completeNpcCommission(player.id, commission.id, "complete-visit-1", online);
    expect(completed.commissions[0]).toMatchObject({ status: "completed", ready: false });
    expect(service.getPlayer(player.id).cashWen).toBe(beforeCash + 300);
    expect(service.completeNpcCommission(player.id, commission.id, "complete-visit-1", online).commissions[0].status)
      .toBe("completed");
    expect(service.getPlayer(player.id).cashWen).toBe(beforeCash + 300);
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM currency_ledger
      WHERE player_id=? AND reference_type='npc-commission' AND reference_id=?
    `).get(player.id, commission.id)).toEqual({ count: 1 });
  });

  it("validates all public NPC and commission commands", () => {
    for (const command of [
      { type: "person.inspect", requestId: "p1", personId: "npc-001" },
      { type: "person.dialogue.choose", requestId: "p2", personId: "npc-001", topicId: "topic-greeting" },
      { type: "commission.accept", requestId: "p3", personId: "npc-001", templateId: "commission-visit-zhou" },
      { type: "commission.complete", requestId: "p4", commissionId: "commission-1" },
      { type: "commission.abandon", requestId: "p5", commissionId: "commission-1" },
    ]) expect(clientMessageSchema.safeParse(command).success).toBe(true);
  });
});
