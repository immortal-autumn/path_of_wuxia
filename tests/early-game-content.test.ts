import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACTION_CATALOG } from "../lib/game/action-catalog";
import { actionSuccessChance } from "../lib/game/action-engine";
import { openGameDatabase, type GameDatabase } from "../lib/game/database";
import { npcStableKey, NPC_POPULATION } from "../lib/game/npc-seed";
import { BASE_ATTRIBUTES } from "../lib/game/progression";

const restedNeeds = {
  satiety: 100,
  hydration: 100,
  hygiene: 100,
  fatigue: 0,
  bladder: 0,
  updatedAt: "2026-08-05T00:00:00.000Z",
};

function catalogAction(id: string) {
  const action = ACTION_CATALOG.find((candidate) => candidate.id === id);
  if (!action) throw new Error(`Missing action catalog entry: ${id}`);
  return action;
}

function baseChance(id: string) {
  return actionSuccessChance({
    attributes: BASE_ATTRIBUTES,
    skillLevel: 0,
    needs: restedNeeds,
    check: catalogAction(id).check ?? {},
  });
}

describe("early-game action pacing", () => {
  it("keeps introductory perception actions brief and reliably achievable", () => {
    expect(catalogAction("action-observe").durationSeconds).toBe(10);
    expect(catalogAction("action-listen").durationSeconds).toBe(30);
    expect(baseChance("action-observe")).toBe(80);
    expect(baseChance("action-listen")).toBe(70);
    expect(baseChance("action-eagle-eye")).toBe(60);
    expect(baseChance("action-qinggong")).toBe(50);
  });

  it("awards practice experience after early failures without shortening offline actions", () => {
    for (const id of ["action-observe", "action-listen", "action-eagle-eye", "action-qinggong"]) {
      expect(catalogAction(id).failure?.skillExperience).toBeGreaterThan(0);
    }
    expect(catalogAction("action-cultivate-hour").durationSeconds).toBe(3_600);
    expect(catalogAction("action-sleep").durationSeconds).toBe(28_800);
    expect(catalogAction("action-work-shift").durationSeconds).toBe(28_800);
  });
});

describe("occupation-aware NPC content", () => {
  let db: GameDatabase;

  beforeEach(() => {
    db = openGameDatabase(":memory:");
  });

  afterEach(() => db.close());

  it("seeds distinct three-topic conversations by occupation and workplace area", () => {
    expect(db.prepare("SELECT COUNT(*) AS count FROM npc_dialogue_topics WHERE is_active=1").get())
      .toEqual({ count: 15 });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM (
        SELECT player_id FROM npc_dialogue_assignments GROUP BY player_id HAVING COUNT(*)=3
      )
    `).get()).toEqual({ count: NPC_POPULATION });

    const signature = (index: number) => (db.prepare(`
      SELECT topic_id FROM npc_dialogue_assignments WHERE player_id=? ORDER BY topic_id
    `).all(npcStableKey(index)) as Array<{ topic_id: string }>).map((row) => row.topic_id);

    expect(signature(0)).toEqual(["topic-city", "topic-greeting", "topic-work"]);
    expect(signature(120)).toContain("topic-craft");
    expect(signature(168)).toContain("topic-law");
    expect(signature(184)).toEqual(expect.arrayContaining(["topic-gates", "topic-patrol"]));
    expect(signature(200)).toContain("topic-faith");
    expect(signature(216)).toContain("topic-neighborhood");
    expect(new Set([0, 120, 168, 184, 200, 216].map((index) => signature(index).join("|"))).size)
      .toBeGreaterThanOrEqual(6);
  });

  it("seeds one cohort-selected offer per resident across varied objective kinds", () => {
    expect(db.prepare("SELECT COUNT(*) AS count FROM npc_commission_templates WHERE is_active=1").get())
      .toEqual({ count: 12 });
    expect(db.prepare(`
      SELECT objective_kind,COUNT(*) AS count FROM npc_commission_templates
      WHERE is_active=1 GROUP BY objective_kind ORDER BY objective_kind
    `).all()).toEqual([
      { objective_kind: "action", count: 3 },
      { objective_kind: "deliver", count: 4 },
      { objective_kind: "visit", count: 5 },
    ]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM npc_commission_offers").get())
      .toEqual({ count: NPC_POPULATION });
    expect(db.prepare("SELECT COUNT(DISTINCT template_id) AS count FROM npc_commission_offers").get())
      .toEqual({ count: 12 });
    expect(db.prepare("SELECT template_id FROM npc_commission_offers WHERE npc_id=?").get(npcStableKey(0)))
      .toEqual({ template_id: "commission-visit-zhou" });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM (
        SELECT assignment.cohort,COUNT(DISTINCT offer.template_id) AS templates
        FROM npc_assignments assignment JOIN npc_commission_offers offer ON offer.npc_id=assignment.player_id
        GROUP BY assignment.cohort HAVING templates>1
      )
    `).get()).toEqual({ count: 7 });
  });
});
