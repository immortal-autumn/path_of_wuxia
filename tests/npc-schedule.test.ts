import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openGameDatabase, type GameDatabase } from "../lib/game/database";
import { nextLegalNpcScheduleHop, resolveNpcScheduleDirective } from "../lib/game/npc-schedule";

describe("NPC city schedules", () => {
  let db: GameDatabase;

  beforeEach(() => {
    db = openGameDatabase(":memory:");
  });

  afterEach(() => db.close());

  it("selects schedule entries by China weekday and time", () => {
    db.prepare("UPDATE npc_schedule_entries SET weekday_mask=1 WHERE player_id='npc-001'").run();
    const monday = resolveNpcScheduleDirective(db, "npc-001", new Date("2026-08-02T23:01:00.000Z"));
    const tuesday = resolveNpcScheduleDirective(db, "npc-001", new Date("2026-08-03T23:01:00.000Z"));

    expect(monday.scheduleEntryId).toBe("schedule-npc-001-2");
    expect(monday.activity).toBe("当值");
    expect(tuesday).toMatchObject({ kind: "hold", reason: "no-schedule", scheduleEntryId: null });
  });

  it("advances looping route targets using each stop's dwell time", () => {
    const directive = resolveNpcScheduleDirective(db, "npc-145", new Date("2026-08-02T21:46:00.000Z"));

    expect(directive).toMatchObject({
      scheduleEntryId: "schedule-npc-145-1",
      activity: "晨起",
      targetLocationId: "song-landmark-gate-xuande",
    });
  });

  it("returns one legal hop toward work, then an action that fits before the schedule boundary", () => {
    const assignment = db.prepare(`
      SELECT home_location_id,workplace_location_id FROM npc_assignments WHERE player_id='npc-001'
    `).get() as { home_location_id: string; workplace_location_id: string };
    db.prepare("UPDATE players SET current_location=? WHERE id='npc-001'").run(assignment.home_location_id);
    const moving = resolveNpcScheduleDirective(db, "npc-001", new Date("2026-08-02T23:01:00.000Z"));
    expect(moving.kind).toBe("move");
    if (moving.kind !== "move") throw new Error("expected a movement directive");
    expect(db.prepare(`
      SELECT 1 FROM routes WHERE is_active=1 AND route_type IN ('normal','transition')
        AND ((from_location=? AND to_location=?) OR (from_location=? AND to_location=?))
    `).get(assignment.home_location_id, moving.locationId, moving.locationId, assignment.home_location_id)).toBeTruthy();

    db.prepare("UPDATE players SET current_location=? WHERE id='npc-001'").run(assignment.workplace_location_id);
    const working = resolveNpcScheduleDirective(db, "npc-001", new Date("2026-08-02T23:01:00.000Z"));
    expect(working).toMatchObject({
      kind: "action",
      actionId: "action-observe",
      targetLocationId: assignment.workplace_location_id,
    });
  });
});

describe("NPC schedule path finding", () => {
  it("uses active ordinary and transition routes but never portals", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE locations(id TEXT PRIMARY KEY,is_active INTEGER NOT NULL);
      CREATE TABLE routes(
        id TEXT PRIMARY KEY,from_location TEXT NOT NULL,to_location TEXT NOT NULL,
        route_type TEXT NOT NULL,is_active INTEGER NOT NULL
      );
      INSERT INTO locations VALUES ('a',1),('b',1),('c',1),('inactive',0);
      INSERT INTO routes VALUES
        ('route-portal','a','c','portal',1),
        ('route-normal','a','b','normal',1),
        ('route-transition','b','c','transition',1),
        ('route-inactive-destination','a','inactive','normal',1);
    `);

    expect(nextLegalNpcScheduleHop(db, "a", "c")).toBe("b");
    db.prepare("UPDATE routes SET is_active=0 WHERE id='route-transition'").run();
    expect(nextLegalNpcScheduleHop(db, "a", "c")).toBeNull();
    db.close();
  });
});
