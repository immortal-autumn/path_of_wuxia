const HOUR_MS = 60 * 60 * 1_000;

export const WANTED_ASSAULT_INCREASE = 20;
export const WANTED_DEFEAT_OR_ROBBERY_INCREASE = 50;
export const SHOP_REFUSAL_WANTED_LEVEL = 20;
export const CONSTABLE_PURSUIT_WANTED_LEVEL = 50;
export const WANTED_DECAY_PER_HOUR = 1;
export const WANTED_FINE_PER_LEVEL_WEN = 100;

export type WantedOffense = "assault" | "defeat" | "robbery";
export type WantedStatus = "clear" | "recorded" | "wanted" | "pursued";

export type LawLocationIdentity = {
  id: string;
  layerId?: string | null;
  regionId?: string | null;
};

export type WantedDecay = {
  wantedLevel: number;
  decayedLevels: number;
  elapsedWholeHours: number;
  /** Last complete hourly boundary consumed by this calculation. */
  decayedThrough: string;
};

function nonNegativeInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer.`);
  }
  return value;
}

function validDate(value: Date | string, name: string) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new RangeError(`${name} must be a valid date.`);
  return date;
}

export function wantedIncreaseFor(offense: WantedOffense) {
  return offense === "assault" ? WANTED_ASSAULT_INCREASE : WANTED_DEFEAT_OR_ROBBERY_INCREASE;
}

export function applyWantedOffense(wantedLevel: number, offense: WantedOffense) {
  const current = nonNegativeInteger(wantedLevel, "wantedLevel");
  const increase = wantedIncreaseFor(offense);
  if (current > Number.MAX_SAFE_INTEGER - increase) throw new RangeError("wantedLevel is too large.");
  return current + increase;
}

/**
 * Decays wanted level by one point for each complete elapsed hour.
 *
 * `decayedThrough` advances only by complete hours, preserving a partial hour
 * when callers persist the returned boundary for the next settlement.
 */
export function decayWantedLevel(
  wantedLevel: number,
  lastSettledAt: Date | string,
  now: Date | string,
): WantedDecay {
  const current = nonNegativeInteger(wantedLevel, "wantedLevel");
  const from = validDate(lastSettledAt, "lastSettledAt");
  const until = validDate(now, "now");
  const elapsedWholeHours = Math.max(0, Math.floor((until.getTime() - from.getTime()) / HOUR_MS));
  const decayedLevels = Math.min(current, elapsedWholeHours * WANTED_DECAY_PER_HOUR);
  return {
    wantedLevel: current - decayedLevels,
    decayedLevels,
    elapsedWholeHours,
    decayedThrough: new Date(from.getTime() + elapsedWholeHours * HOUR_MS).toISOString(),
  };
}

export function wantedStatus(wantedLevel: number): WantedStatus {
  const level = nonNegativeInteger(wantedLevel, "wantedLevel");
  if (level === 0) return "clear";
  if (level < SHOP_REFUSAL_WANTED_LEVEL) return "recorded";
  if (level < CONSTABLE_PURSUIT_WANTED_LEVEL) return "wanted";
  return "pursued";
}

export function wantedStatusLabel(wantedLevel: number) {
  const labels: Record<WantedStatus, string> = {
    clear: "清白",
    recorded: "留案",
    wanted: "通缉",
    pursued: "重犯追捕",
  };
  return labels[wantedStatus(wantedLevel)];
}

export function shopRefusesForWantedLevel(wantedLevel: number) {
  return nonNegativeInteger(wantedLevel, "wantedLevel") >= SHOP_REFUSAL_WANTED_LEVEL;
}

export function constablesPursueWantedLevel(wantedLevel: number) {
  return nonNegativeInteger(wantedLevel, "wantedLevel") >= CONSTABLE_PURSUIT_WANTED_LEVEL;
}

export function wantedFineWen(wantedLevel: number) {
  const level = nonNegativeInteger(wantedLevel, "wantedLevel");
  if (level > Math.floor(Number.MAX_SAFE_INTEGER / WANTED_FINE_PER_LEVEL_WEN)) {
    throw new RangeError("wantedLevel is too large to calculate a safe fine.");
  }
  return level * WANTED_FINE_PER_LEVEL_WEN;
}

/** Kaifeng law covers the Song city region and every one-floor Kaifeng interior. */
export function isKaifengJurisdiction(location: LawLocationIdentity) {
  return location.regionId === "song"
    || location.id.startsWith("song-")
    || location.id.startsWith("kaifeng-")
    || Boolean(location.layerId?.startsWith("kaifeng-"));
}

/** Surrender and fine payment are accepted at the prefecture exterior or interior. */
export function isKaifengPrefecture(location: Pick<LawLocationIdentity, "id" | "layerId">) {
  return location.id === "song-landmark-office-kaifeng"
    || location.id.startsWith("kaifeng-prefecture-")
    || location.layerId === "kaifeng-prefecture-ground";
}
