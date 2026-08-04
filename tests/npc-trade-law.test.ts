import { describe, expect, it } from "vitest";
import {
  applyWantedOffense,
  constablesPursueWantedLevel,
  decayWantedLevel,
  isKaifengJurisdiction,
  isKaifengPrefecture,
  shopRefusesForWantedLevel,
  wantedFineWen,
  wantedStatusLabel,
} from "../lib/game/law";
import {
  canonicalJson,
  canonicalizeNpcTradeStrategy,
  decideNpcTrade,
  fallbackNpcTradeStrategy,
  npcTradeReplaySeed,
  npcTradeStrategyHash,
  type NpcTradeInput,
  type NpcTradeStrategy,
} from "../lib/game/npc-trade";

describe("Kaifeng law helpers", () => {
  it("applies offenses and preserves partial hours across wanted decay", () => {
    expect(applyWantedOffense(0, "assault")).toBe(20);
    expect(applyWantedOffense(20, "defeat")).toBe(70);
    expect(applyWantedOffense(20, "robbery")).toBe(70);
    expect(decayWantedLevel(20, "2026-08-04T00:15:00.000Z", "2026-08-04T03:59:00.000Z")).toEqual({
      wantedLevel: 17,
      decayedLevels: 3,
      elapsedWholeHours: 3,
      decayedThrough: "2026-08-04T03:15:00.000Z",
    });
    expect(decayWantedLevel(2, "2026-08-04T00:00:00.000Z", "2026-08-04T12:00:00.000Z").wantedLevel).toBe(0);
  });

  it("uses the service-refusal and pursuit boundaries in public labels", () => {
    expect([0, 1, 19, 20, 49, 50].map(wantedStatusLabel)).toEqual([
      "清白", "留案", "留案", "通缉", "通缉", "重犯追捕",
    ]);
    expect(shopRefusesForWantedLevel(19)).toBe(false);
    expect(shopRefusesForWantedLevel(20)).toBe(true);
    expect(constablesPursueWantedLevel(49)).toBe(false);
    expect(constablesPursueWantedLevel(50)).toBe(true);
    expect(wantedFineWen(50)).toBe(5_000);
  });

  it("recognizes the Song city and prefecture without claiming the modern home", () => {
    expect(isKaifengJurisdiction({ id: "song-landmark-bridge-zhou", layerId: "world-root", regionId: "song" })).toBe(true);
    expect(isKaifengJurisdiction({ id: "kaifeng-shop-tea-room-1", layerId: "kaifeng-shop-tea-ground" })).toBe(true);
    expect(isKaifengJurisdiction({ id: "home-entrance", layerId: "home-ground", regionId: "home" })).toBe(false);
    expect(isKaifengPrefecture({ id: "song-landmark-office-kaifeng", layerId: "world-root" })).toBe(true);
    expect(isKaifengPrefecture({ id: "kaifeng-prefecture-main-hall", layerId: "kaifeng-prefecture-ground" })).toBe(true);
    expect(isKaifengPrefecture({ id: "song-landmark-bridge-zhou", layerId: "world-root" })).toBe(false);
  });
});

describe("deterministic NPC trade helpers", () => {
  const strategy: NpcTradeStrategy = {
    version: 1,
    underlyings: ["tea", "rice", "tea"],
    maxOrderQuantity: 3,
    maxOpenOrders: 2,
    cashReserveWen: 1_000,
    edgeBps: 50,
    buyBiasBps: 0,
  };
  const input: NpcTradeInput = {
    actorId: "npc-001",
    asOf: "2026-08-04T12:00:00.000Z",
    availableCashWen: 20_000,
    clearingDebtWen: 0,
    quotes: [
      { contractId: "spot-tea", underlyingId: "tea", kind: "spot", markPriceWen: 2_800, bestBidWen: 2_790, bestAskWen: 2_810 },
      { contractId: "future-rice", underlyingId: "rice", kind: "future", markPriceWen: 3_500, bestBidWen: 3_490, bestAskWen: 3_510 },
      { contractId: "spot-rice", underlyingId: "rice", kind: "spot", markPriceWen: 3_500, bestBidWen: 3_490, bestAskWen: 3_510 },
    ],
    positions: [{ contractId: "spot-rice", quantity: 4 }, { contractId: "spot-tea", quantity: 2 }],
    openOrders: [],
  };

  it("canonicalizes object keys and normalized strategy sets before hashing", () => {
    expect(canonicalJson({ z: 1, nested: { b: true, a: null }, a: [2, 1] }))
      .toBe('{"a":[2,1],"nested":{"a":null,"b":true},"z":1}');
    expect(canonicalizeNpcTradeStrategy(strategy)).toBe(
      '{"buyBiasBps":0,"cashReserveWen":1000,"edgeBps":50,"maxOpenOrders":2,"maxOrderQuantity":3,"underlyings":["rice","tea"],"version":1}',
    );
    expect(npcTradeStrategyHash(strategy)).toMatch(/^[a-f0-9]{64}$/);
    expect(npcTradeStrategyHash({ ...strategy, underlyings: ["rice", "tea"] })).toBe(npcTradeStrategyHash(strategy));
  });

  it("derives stable actor-specific fallbacks and replayable decisions", () => {
    expect(fallbackNpcTradeStrategy("npc-001")).toEqual(fallbackNpcTradeStrategy("npc-001"));
    expect(fallbackNpcTradeStrategy("npc-001")).not.toEqual(fallbackNpcTradeStrategy("npc-002"));
    const hash = npcTradeStrategyHash(strategy);
    const seed = npcTradeReplaySeed(input.actorId, hash, input);
    const first = decideNpcTrade(strategy, input, seed);
    expect(first).toEqual(decideNpcTrade(strategy, input, seed));
    expect(first.type).toBe("market.order.place");
  });

  it("blocks indebted actors and deterministically cancels the oldest excess order", () => {
    expect(decideNpcTrade(strategy, { ...input, clearingDebtWen: 1 }, "seed")).toEqual({
      type: "hold", reason: "clearing-debt",
    });
    expect(decideNpcTrade(strategy, {
      ...input,
      openOrders: [
        { id: "new", contractId: "spot-rice", side: "buy", createdAt: "2026-08-04T12:01:00.000Z" },
        { id: "old", contractId: "spot-tea", side: "sell", createdAt: "2026-08-04T12:00:00.000Z" },
      ],
    }, "seed")).toEqual({ type: "market.order.cancel", orderId: "old" });
  });
});
