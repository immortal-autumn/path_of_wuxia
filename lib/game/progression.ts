import type { BaseAttributes, DerivedStats } from "./types";

export const REALMS = [
  "凡人", "后天", "先天", "宗师", "大宗师", "炼气", "筑基",
  "金丹", "元婴", "化神", "炼虚", "合体", "大乘",
] as const;

export const ATTRIBUTE_KEYS = ["strength", "agility", "constitution", "root", "comprehension", "spirit"] as const;
export type AttributeKey = (typeof ATTRIBUTE_KEYS)[number];

export const BASE_ATTRIBUTES: BaseAttributes = {
  strength: 10,
  agility: 10,
  constitution: 10,
  root: 10,
  comprehension: 10,
  spirit: 10,
};

export function realmMultiplier(realmIndex: number) {
  return 1.25 ** Math.max(0, Math.min(REALMS.length - 1, realmIndex));
}

export function minorAttributePoints(realmIndex: number) {
  return 2 + Math.floor(Math.max(0, realmIndex) / 2);
}

export function majorAttributePoints(targetRealmIndex: number) {
  return 12 + 3 * Math.max(0, targetRealmIndex);
}

export function cultivationForNextLevel(realmIndex: number, level: number) {
  return Math.ceil(100 * 1.8 ** Math.max(0, realmIndex) * 1.25 ** Math.max(0, level - 1));
}

export function breakthroughChance(level: number) {
  if (level >= 12) return 100;
  if (level === 11) return 75;
  if (level === 10) return 60;
  if (level === 9) return 45;
  return 0;
}

export function deriveStats(attributes: BaseAttributes, realmIndex: number): DerivedStats {
  const multiplier = realmMultiplier(realmIndex);
  const maxHp = Math.floor((100 + attributes.constitution * 15 + attributes.root * 5) * multiplier);
  const maxEndurance = Math.floor((50 + attributes.constitution * 5 + attributes.strength * 2) * multiplier);
  return {
    realmMultiplier: multiplier,
    maxHp,
    maxEndurance,
    minAttack: Math.floor((attributes.strength * 2 + attributes.agility * 0.5) * multiplier),
    maxAttack: Math.floor((attributes.strength * 3 + attributes.agility) * multiplier),
    defense: Math.floor((attributes.constitution * 2 + attributes.strength * 0.5) * multiplier),
    speed: Math.floor((attributes.agility * 2 + attributes.spirit * 0.5) * multiplier),
    hitRate: Math.min(100, Number((70 + attributes.agility * 0.5 + attributes.spirit * 0.2).toFixed(1))),
    dodgeRate: Math.min(60, Number((attributes.agility * 0.35 + attributes.spirit * 0.15).toFixed(1))),
    criticalRate: Math.min(50, Number((5 + attributes.agility * 0.15 + attributes.comprehension * 0.15).toFixed(1))),
    criticalDamage: Math.min(300, 150 + Math.floor(attributes.strength * 0.5 + attributes.comprehension * 0.25)),
    cultivationPerMinute: Math.max(1, Math.floor((attributes.root * 2 + attributes.comprehension * 2 + attributes.spirit) / 5)),
  };
}
