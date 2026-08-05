import { createHash } from "node:crypto";
import type { MarketContractKind, MarketOrderSide } from "./types";

export const NPC_TRADE_STRATEGY_VERSION = 1 as const;

const DEFAULT_UNDERLYINGS = [
  "rice", "tea", "silk", "salt", "wood", "iron", "paper", "medicine", "oil", "copper",
] as const;

export type NpcTradeStrategy = {
  version: typeof NPC_TRADE_STRATEGY_VERSION;
  underlyings: string[];
  maxOrderQuantity: number;
  maxOpenOrders: number;
  cashReserveWen: number;
  edgeBps: number;
  buyBiasBps: number;
};

export type NpcTradeQuote = {
  contractId: string;
  underlyingId: string;
  kind: MarketContractKind;
  markPriceWen: number;
  bestBidWen: number | null;
  bestAskWen: number | null;
};

export type NpcTradePosition = { contractId: string; quantity: number };
export type NpcTradeOpenOrder = {
  id: string;
  contractId: string;
  side: MarketOrderSide;
  limitPriceWen: number;
  remainingQuantity: number;
  createdAt: string;
};

export type NpcTradeInput = {
  actorId: string;
  asOf: string;
  availableCashWen: number;
  clearingDebtWen: number;
  quotes: NpcTradeQuote[];
  positions: NpcTradePosition[];
  openOrders: NpcTradeOpenOrder[];
};

export type NpcTradeDecision =
  | { type: "market.order.place"; contractId: string; side: MarketOrderSide; limitPriceWen: number; quantity: number }
  | { type: "market.order.cancel"; orderId: string }
  | { type: "hold"; reason: "clearing-debt" | "no-market" | "insufficient-assets" };

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function assertJsonValue(value: unknown, path = "$", seen = new Set<object>()): asserts value is JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must contain only finite JSON numbers.`);
    return;
  }
  if (typeof value !== "object") throw new TypeError(`${path} is not a JSON value.`);
  if (seen.has(value)) throw new TypeError(`${path} contains a circular reference.`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJsonValue(entry, `${path}[${index}]`, seen));
  } else {
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) throw new TypeError(`${path}.${key} is undefined.`);
      assertJsonValue(entry, `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}

/** Stable JSON used for persisted strategy/input hashes and exact replay. */
export function canonicalJson(value: unknown): string {
  assertJsonValue(value);
  const encode = (entry: JsonValue): string => {
    if (entry === null || typeof entry !== "object") return JSON.stringify(entry);
    if (Array.isArray(entry)) return `[${entry.map(encode).join(",")}]`;
    return `{${Object.keys(entry).sort().map((key) => `${JSON.stringify(key)}:${encode(entry[key])}`).join(",")}}`;
  };
  return encode(value);
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("NPC trade strategy must be an object.");
  }
  return value as Record<string, unknown>;
}

function boundedInteger(record: Record<string, unknown>, key: string, minimum: number, maximum: number) {
  const value = record[key];
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new RangeError(`${key} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value as number;
}

/** Validates a stored/external strategy and removes representation-dependent ordering. */
export function normalizeNpcTradeStrategy(value: unknown): NpcTradeStrategy {
  const record = objectRecord(value);
  if (record.version !== NPC_TRADE_STRATEGY_VERSION) throw new RangeError("Unsupported NPC trade strategy version.");
  if (!Array.isArray(record.underlyings) || record.underlyings.length === 0
      || record.underlyings.some((entry) => typeof entry !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(entry))) {
    throw new TypeError("underlyings must contain at least one stable commodity ID.");
  }
  return {
    version: NPC_TRADE_STRATEGY_VERSION,
    underlyings: [...new Set(record.underlyings as string[])].sort(),
    maxOrderQuantity: boundedInteger(record, "maxOrderQuantity", 1, 20),
    maxOpenOrders: boundedInteger(record, "maxOpenOrders", 1, 20),
    cashReserveWen: boundedInteger(record, "cashReserveWen", 0, 10_000_000),
    edgeBps: boundedInteger(record, "edgeBps", 0, 2_500),
    buyBiasBps: boundedInteger(record, "buyBiasBps", -4_000, 4_000),
  };
}

export function canonicalizeNpcTradeStrategy(value: unknown) {
  return canonicalJson(normalizeNpcTradeStrategy(value));
}

export function npcTradeStrategyHash(value: unknown) {
  return createHash("sha256").update(canonicalizeNpcTradeStrategy(value)).digest("hex");
}

function digestBytes(value: string) {
  return createHash("sha256").update(value).digest();
}

/** Creates stable private defaults without depending on process-local randomness. */
export function fallbackNpcTradeStrategy(actorId: string): NpcTradeStrategy {
  if (!actorId) throw new TypeError("actorId is required.");
  const digest = digestBytes(`npc-trade-strategy-v${NPC_TRADE_STRATEGY_VERSION}:${actorId}`);
  const start = digest[0] % DEFAULT_UNDERLYINGS.length;
  const underlyings = Array.from({ length: 4 }, (_, offset) => DEFAULT_UNDERLYINGS[(start + offset * 3) % DEFAULT_UNDERLYINGS.length]);
  return normalizeNpcTradeStrategy({
    version: NPC_TRADE_STRATEGY_VERSION,
    underlyings,
    maxOrderQuantity: 1 + digest[1] % 4,
    maxOpenOrders: 2 + digest[2] % 4,
    cashReserveWen: 1_000 + (digest[3] % 10) * 500,
    edgeBps: 20 + digest[4] % 181,
    buyBiasBps: (digest[5] % 17 - 8) * 100,
  });
}

export function npcTradeReplaySeed(actorId: string, strategyHash: string, input: unknown) {
  if (!actorId || !/^[a-f0-9]{64}$/.test(strategyHash)) throw new TypeError("A valid actor and strategy hash are required.");
  return createHash("sha256")
    .update(`npc-trade-decision-v1:${actorId}:${strategyHash}:${canonicalJson(input)}`)
    .digest("hex");
}

function deterministicDraw(seed: string, sequence: number) {
  return digestBytes(`${seed}:${sequence}`).readUInt32BE(0);
}

function positiveInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer.`);
  return value;
}

function quotePrice(quote: NpcTradeQuote, side: MarketOrderSide, edgeBps: number) {
  if (side === "buy") {
    return Math.max(1, quote.bestBidWen ?? Math.floor(quote.markPriceWen * (10_000 - edgeBps) / 10_000));
  }
  return Math.max(1, quote.bestAskWen ?? Math.ceil(quote.markPriceWen * (10_000 + edgeBps) / 10_000));
}

/**
 * Returns exactly one deterministic, replayable command (or an audited hold).
 * The built-in policy deliberately trades spot only, so it cannot create an
 * uncovered short or derivative liability while acting as a safe fallback.
 */
export function decideNpcTrade(
  strategyValue: unknown,
  input: NpcTradeInput,
  rngSeed: string,
): NpcTradeDecision {
  const strategy = normalizeNpcTradeStrategy(strategyValue);
  const cash = positiveInteger(input.availableCashWen, "availableCashWen");
  const debt = positiveInteger(input.clearingDebtWen, "clearingDebtWen");
  if (debt > 0) return { type: "hold", reason: "clearing-debt" };

  const openOrders = [...input.openOrders].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  if (openOrders.length >= strategy.maxOpenOrders) {
    return { type: "market.order.cancel", orderId: openOrders[0].id };
  }

  const universe = new Set(strategy.underlyings);
  const quotes = input.quotes.filter((quote) =>
    quote.kind === "spot" && universe.has(quote.underlyingId)
      && Number.isSafeInteger(quote.markPriceWen) && quote.markPriceWen > 0)
    .sort((left, right) => left.contractId.localeCompare(right.contractId));
  if (quotes.length === 0) return { type: "hold", reason: "no-market" };

  const quote = quotes[deterministicDraw(rngSeed, 0) % quotes.length];
  const held = input.positions
    .filter((position) => position.contractId === quote.contractId)
    .reduce((total, position) => total + position.quantity, 0);
  const spendable = Math.max(0, cash - strategy.cashReserveWen);
  const buyThreshold = 5_000 + strategy.buyBiasBps;
  let side: MarketOrderSide = deterministicDraw(rngSeed, 1) % 10_000 < buyThreshold ? "buy" : "sell";
  let limitPriceWen = quotePrice(quote, side, strategy.edgeBps);
  if (side === "buy" && spendable < limitPriceWen) side = "sell";
  if (side === "sell" && held <= 0) side = "buy";
  limitPriceWen = quotePrice(quote, side, strategy.edgeBps);

  const randomQuantity = 1 + deterministicDraw(rngSeed, 2) % strategy.maxOrderQuantity;
  const affordable = side === "buy" ? Math.floor(spendable / limitPriceWen) : held;
  const quantity = Math.min(randomQuantity, affordable);
  if (quantity <= 0) return { type: "hold", reason: "insufficient-assets" };
  return { type: "market.order.place", contractId: quote.contractId, side, limitPriceWen, quantity };
}
