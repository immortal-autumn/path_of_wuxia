import { describe, expect, it } from "vitest";
import { serverUpgradeOwner } from "../lib/game/server-upgrade";

describe("custom server WebSocket upgrade routing", () => {
  it("always reserves the game WebSocket path", () => {
    expect(serverUpgradeOwner("/ws", true)).toBe("game");
    expect(serverUpgradeOwner("/ws", false)).toBe("game");
  });

  it("passes Next development channels through for Fast Refresh", () => {
    expect(serverUpgradeOwner("/_next/hmr", true)).toBe("next");
    expect(serverUpgradeOwner("/_next/hmr?id=browser", true)).toBe("next");
    expect(serverUpgradeOwner("/_next/other-development-channel", true)).toBe("next");
  });

  it("rejects unrecognized production upgrade paths", () => {
    expect(serverUpgradeOwner("/_next/hmr", false)).toBe("reject");
    expect(serverUpgradeOwner("/arbitrary-socket", false)).toBe("reject");
  });
});
