import { z } from "zod";
import type {
  ActionCheck,
  ActionOutcome,
  ActionRequirement,
  BaseAttributes,
  NeedKey,
  PlayerNeeds,
} from "./types";

const needKeys = ["satiety", "hydration", "hygiene", "fatigue", "bladder"] as const;
const attributeKeys = ["strength", "agility", "constitution", "root", "comprehension", "spirit"] as const;

const itemAmountSchema = z.object({
  definitionId: z.string().min(1).max(120),
  quantity: z.number().int().min(1).max(100_000),
});

export const actionRequirementSchema = z.object({
  facilityType: z.string().min(1).max(80).optional(),
  minimumFacilityQuality: z.number().int().min(1).max(5).optional(),
  attribute: z.enum(attributeKeys).optional(),
  minimumAttribute: z.number().int().min(0).max(100_000).optional(),
  skillId: z.string().min(1).max(120).optional(),
  minimumSkillLevel: z.number().int().min(0).max(100).optional(),
  itemCosts: z.array(itemAmountSchema).max(24).optional(),
  relationshipTypes: z.array(z.string().min(1).max(40)).max(16).optional(),
  sameLocation: z.boolean().optional(),
  targetOnline: z.boolean().optional(),
}).strict();

export const actionCheckSchema = z.object({
  attribute: z.enum(attributeKeys).optional(),
  skillId: z.string().min(1).max(120).optional(),
  difficulty: z.number().int().min(-1000).max(1000).optional(),
}).strict();

export const actionOutcomeSchema = z.object({
  cashWenDelta: z.number().int().min(-10_000_000).max(10_000_000).optional(),
  hpDelta: z.number().int().min(-100_000).max(100_000).optional(),
  cultivationDelta: z.number().int().min(-1_000_000).max(1_000_000).optional(),
  skillExperience: z.number().int().min(0).max(1_000_000).optional(),
  needDeltas: z.partialRecord(z.enum(needKeys), z.number().min(-100).max(100)).optional(),
  items: z.array(itemAmountSchema.extend({ quality: z.number().int().min(1).max(5).optional(), bound: z.boolean().optional() })).max(24).optional(),
  statusId: z.string().min(1).max(120).optional(),
  statusDurationSeconds: z.number().int().min(1).max(100 * 365 * 24 * 60 * 60).optional(),
}).strict();

export const actionOutcomesSchema = z.object({
  success: actionOutcomeSchema.default({}),
  failure: actionOutcomeSchema.default({}),
}).strict();

export function parseRequirements(value: string): ActionRequirement {
  return actionRequirementSchema.parse(JSON.parse(value));
}

export function parseCheck(value: string): ActionCheck {
  return actionCheckSchema.parse(JSON.parse(value));
}

export function parseOutcomes(value: string): { success: ActionOutcome; failure: ActionOutcome } {
  return actionOutcomesSchema.parse(JSON.parse(value));
}

export function clampNeed(value: number) {
  return Math.max(0, Math.min(100, value));
}

export function settleNeedValues(needs: PlayerNeeds, at: Date): PlayerNeeds {
  const elapsedHours = Math.max(0, (at.getTime() - new Date(needs.updatedAt).getTime()) / 3_600_000);
  return {
    satiety: clampNeed(needs.satiety - elapsedHours * 4),
    hydration: clampNeed(needs.hydration - elapsedHours * 6),
    hygiene: clampNeed(needs.hygiene - elapsedHours),
    fatigue: clampNeed(needs.fatigue + elapsedHours * 4),
    bladder: clampNeed(needs.bladder + elapsedHours * 5),
    updatedAt: at.toISOString(),
  };
}

export function needPenalty(needs: PlayerNeeds) {
  const poor = [needs.satiety < 25, needs.hydration < 25, needs.hygiene < 25, needs.fatigue > 75, needs.bladder > 75]
    .filter(Boolean).length;
  return poor * 5;
}

export function applyNeedDeltas(needs: PlayerNeeds, deltas: Partial<Record<NeedKey, number>> = {}): PlayerNeeds {
  return {
    ...needs,
    ...Object.fromEntries(needKeys.map((key) => [key, clampNeed(needs[key] + (deltas[key] ?? 0))])),
  };
}

export function actionSuccessChance({
  attributes,
  skillLevel,
  needs,
  check,
}: {
  attributes: BaseAttributes;
  skillLevel: number;
  needs: PlayerNeeds;
  check: ActionCheck;
}) {
  if (!check.attribute && !check.skillId && check.difficulty === undefined) return 100;
  const attributeBonus = check.attribute ? Math.floor((attributes[check.attribute] - 10) * 2) : 0;
  const skillBonus = check.skillId ? Math.floor(skillLevel / 2) : 0;
  return Math.max(5, Math.min(95, 50 + attributeBonus + skillBonus - (check.difficulty ?? 50) - needPenalty(needs)));
}

export function actionDurationLabel(seconds: number) {
  if (seconds < 60) return `${seconds}秒`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}分钟`;
  if (seconds < 86400) return `${Number((seconds / 3600).toFixed(seconds % 3600 === 0 ? 0 : 1))}小时`;
  return `${Number((seconds / 86400).toFixed(seconds % 86400 === 0 ? 0 : 1))}天`;
}
