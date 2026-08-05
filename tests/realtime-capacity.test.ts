import { describe, expect, it } from "vitest";
import { groupSnapshotRefreshes, syncRetryAfterMs } from "../server";
import {
  gameplayActorReconnectDelayMs,
  gameplayActorStartupDelayMs,
} from "../scripts/npc-runner";
import {
  tradeActorReconnectDelayMs,
  tradeActorStartupDelayMs,
} from "../scripts/npc-trade-runner";

describe("real-time capacity guardrails", () => {
  it("groups duplicate gameplay sockets into one snapshot build and excludes trade agents", () => {
    const recipients = [
      { id: "browser-a", playerId: "player-a", clientKind: "browser" as const },
      { id: "npc-a", playerId: "player-a", clientKind: "npc-agent" as const },
      { id: "trade-a", playerId: "player-a", clientKind: "npc-trade-agent" as const },
      { id: "browser-b", playerId: "player-b", clientKind: "browser" as const },
    ];

    const groups = groupSnapshotRefreshes(["player-a", "player-a"], recipients);

    expect([...groups.keys()]).toEqual(["player-a"]);
    expect(groups.get("player-a")?.map(({ id }) => id)).toEqual(["browser-a", "npc-a"]);
    expect([...groups.values()].flat().some(({ clientKind }) => clientKind === "npc-trade-agent")).toBe(false);
  });

  it("applies a separate five-second budget to heavy sync requests", () => {
    expect(syncRetryAfterMs(0, 10_000)).toBe(0);
    expect(syncRetryAfterMs(10_000, 11_000)).toBe(4_000);
    expect(syncRetryAfterMs(10_000, 15_000)).toBe(0);
  });

  it.each([
    [gameplayActorStartupDelayMs, gameplayActorReconnectDelayMs],
    [tradeActorStartupDelayMs, tradeActorReconnectDelayMs],
  ])("stably spreads 240 actor launches and reconnects", (startupDelay, reconnectDelay) => {
    const startup = Array.from({ length: 240 }, (_, index) => startupDelay(index, 240));
    const firstReconnect = Array.from({ length: 240 }, (_, index) => reconnectDelay(index, 1, 240));

    expect(startup).toEqual(Array.from({ length: 240 }, (_, index) => startupDelay(index, 240)));
    expect(new Set(startup).size).toBe(240);
    expect(Math.max(...startup)).toBeGreaterThanOrEqual(29_000);
    expect(Math.max(...startup)).toBeLessThan(30_000);
    expect(Math.max(...firstReconnect) - Math.min(...firstReconnect)).toBeGreaterThanOrEqual(9_000);
    expect(reconnectDelay(17, 3, 240)).toBe(reconnectDelay(17, 3, 240));
    expect(reconnectDelay(17, 4, 240)).toBeGreaterThan(reconnectDelay(17, 3, 240));
  });
});
