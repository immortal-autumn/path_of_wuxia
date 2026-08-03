import { expect, test, type BrowserContext, type Page } from "@playwright/test";

async function enterWorld(page: Page) {
  await page.goto("/");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator(".connection-badge")).toContainText("江湖在线");
  await expect(page.getByRole("heading", { name: "八方世界地图" })).toBeVisible();
}

async function enterEditor(page: Page) {
  await page.goto("/map-editor");
  await expect(page.getByRole("heading", { name: "地图设计工具" })).toBeVisible();
  await expect(page.locator(".editor-header-actions")).toContainText("已连接");
  await expect.poll(() => page.locator(".editor-location").count()).toBeGreaterThanOrEqual(4);
}

async function disableRandomUuid(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      configurable: true,
      value: undefined,
    });
  });
}

async function moveTo(page: Page, locationName: string) {
  const destination = page.getByRole("button", { name: new RegExp(`${locationName}，可前往`) });
  await destination.click();
  await expect(page.getByRole("status")).toContainText(`已抵达${locationName}`);
  await expect(page.getByRole("button", { name: new RegExp(`${locationName}，当前位置`) })).toBeVisible();
}

async function performAction(page: Page, actionName: string) {
  await page.getByRole("button", { name: new RegExp(actionName) }).click();
  await expect(page.getByRole("status")).toContainText(`${actionName}完成`);
}

async function newPlayer(context: BrowserContext) {
  const page = await context.newPage();
  await enterWorld(page);
  return page;
}

test.describe("entries and session identity", () => {
  test("bootstraps an HttpOnly session and exposes both application entries", async ({ page, context }) => {
    await enterWorld(page);
    const cookie = (await context.cookies()).find((item) => item.name === "wuxia_session");
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Lax" });
    const name = await page.locator(".character-heading h2").innerText();
    await page.reload();
    await expect(page.locator(".character-heading h2")).toHaveText(name);
    await page.getByRole("link", { name: "地图设计" }).click();
    await expect(page).toHaveURL(/\/map-editor$/);
    await expect(page.getByRole("heading", { name: "地图设计工具" })).toBeVisible();
    await page.getByRole("link", { name: "返回游戏" }).click();
    await expect(page.locator(".character-heading h2")).toHaveText(name);
  });
});

test.describe("game map", () => {
  test("shows the new three-region, four-location, China-time seed", async ({ page }) => {
    await enterWorld(page);
    await expect(page.getByLabel("世界地图")).toBeVisible();
    await expect(page.locator(".map-region")).toHaveCount(3);
    await expect(page.locator(".map-node")).toHaveCount(4);
    await expect(page.locator(".map-node.reachable")).toHaveCount(1);
    await expect(page.locator(".map-node.current")).toContainText("玄关");
    await expect(page.locator(".map-node.current .node-box")).toHaveAttribute("width", "100");
    await expect(page.locator(".map-node.current .node-box")).toHaveAttribute("height", "100");
    await expect(page.getByLabel("下一步可前往地点")).toContainText("下 · 楼门路");
    await expect(page.getByLabel("世界状态")).toContainText("中国标准时间");
    await expect(page.getByLabel("角色状态")).toContainText("嬴长嫚与楼夜秋之家");
    await page.getByRole("button", { name: "下，前往楼门路" }).click();
    await expect(page.getByRole("status")).toContainText("已抵达楼门路");
    await expect(page.getByLabel("下一步可前往地点")).toContainText("上 · 玄关");
    await expect(page.getByLabel("下一步可前往地点")).toContainText("左 · 大宋入口");
    await expect(page.getByLabel("下一步可前往地点")).toContainText("右 · 帕洛斯入口");
  });

  test("visits every seed location and executes every seed action", async ({ page }) => {
    await enterWorld(page);
    await performAction(page, "整理衣装");
    await moveTo(page, "楼门路");
    await performAction(page, "观察街道");
    await moveTo(page, "大宋入口");
    await performAction(page, "眺望大宋");
    await moveTo(page, "楼门路");
    await moveTo(page, "帕洛斯入口");
    await performAction(page, "眺望帕洛斯");
    await page.reload();
    await expect(page.getByRole("button", { name: /帕洛斯入口，当前位置/ })).toBeVisible();
  });

  test("moves when crypto.randomUUID is unavailable over plain HTTP", async ({ page }) => {
    await disableRandomUuid(page);
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await enterWorld(page);
    await page.getByRole("button", { name: "下，前往楼门路" }).click();
    await expect(page.getByRole("status")).toContainText("已抵达楼门路");
    expect(pageErrors).toEqual([]);
  });
});

test.describe("map editor", () => {
  test("drags a snapped location, auto-saves, undoes, redoes, and creates an eight-direction route", async ({ page }) => {
    await disableRandomUuid(page);
    await enterEditor(page);
    const initialLocationCount = await page.locator(".editor-location").count();
    const palette = page.locator(".palette-item").filter({ hasText: "小地点" });
    const svg = page.locator(".editor-canvas svg");
    const box = await svg.boundingBox();
    if (!box) throw new Error("Editor canvas has no bounds");
    await palette.dragTo(svg, { targetPosition: { x: box.width * 0.69, y: box.height * 0.30 } });
    await expect(page.getByRole("status")).toContainText("自动保存");
    await expect(page.locator(".editor-location")).toHaveCount(initialLocationCount + 1);
    await expect(page.locator(".editor-location.selected")).toContainText("新地点");

    await page.getByRole("button", { name: "撤销" }).click();
    await expect(page.locator(".editor-location")).toHaveCount(initialLocationCount);
    await page.getByRole("button", { name: "重做" }).click();
    await expect(page.locator(".editor-location")).toHaveCount(initialLocationCount + 1);

    await page.getByLabel("连接目标").selectOption({ label: "帕洛斯入口" });
    await page.getByRole("button", { name: "建立连接" }).click();
    await expect(page.getByRole("status")).toContainText("自动保存");
    await expect(page.locator(".editor-route")).toHaveCount(4);

    const game = await page.context().newPage();
    await enterWorld(game);
    await expect(game.locator(".map-node").filter({ hasText: "新地点" })).toBeVisible();
    await game.close();
    await page.getByRole("button", { name: "完成编辑" }).click();
    await expect(page.getByRole("button", { name: "完成编辑" })).toBeDisabled();
  });

  test("drags a large region and blocks another player from editing its lock", async ({ browser }) => {
    const firstContext = await browser.newContext();
    const secondContext = await browser.newContext();
    const first = await firstContext.newPage();
    const second = await secondContext.newPage();
    await enterEditor(first);
    await enterEditor(second);

    const homeRegion = first.locator(".editor-region").filter({ hasText: "嬴长嫚与楼夜秋之家" });
    const homeBox = await homeRegion.boundingBox();
    if (!homeBox) throw new Error("Home region has no bounds");
    await first.mouse.move(homeBox.x + 25, homeBox.y + 25);
    await first.mouse.down();
    await first.mouse.move(homeBox.x + 65, homeBox.y + 45, { steps: 4 });
    await first.mouse.up();
    await expect(first.getByRole("status")).toContainText("自动保存");

    await second.locator(".editor-region").filter({ hasText: "嬴长嫚与楼夜秋之家" }).click();
    await second.getByRole("button", { name: "保存区域资料" }).click();
    await expect(second.getByRole("status")).toContainText("正由其他玩家编辑");

    await first.getByRole("button", { name: "完成编辑" }).click();
    await second.getByRole("button", { name: "保存区域资料" }).click();
    await expect(second.getByRole("status")).toContainText("自动保存");
    await firstContext.close();
    await secondContext.close();
  });
});

test.describe("real-time multiplayer", () => {
  test("distinguishes users and synchronizes chat, presence, and movement", async ({ browser }) => {
    const firstContext = await browser.newContext();
    const secondContext = await browser.newContext();
    const first = await newPlayer(firstContext);
    const second = await newPlayer(secondContext);
    const firstName = await first.locator(".character-heading h2").innerText();
    expect(firstName).not.toBe(await second.locator(".character-heading h2").innerText());
    await expect(second.getByLabel("世界状态")).toContainText("2 位侠客在线");
    const message = `Playwright 联机消息 ${Date.now()}`;
    await first.getByLabel("输入聊天消息").fill(message);
    await first.getByRole("button", { name: "传音" }).click();
    await expect(second.getByLabel("世界聊天")).toContainText(message);
    await moveTo(first, "楼门路");
    await expect(second.locator(".map-node").filter({ hasText: "楼门路" })).toContainText("在线 1");
    await firstContext.close();
    await expect(second.getByLabel("世界状态")).toContainText("1 位侠客在线");
    await secondContext.close();
  });
});

test.describe("mobile layout", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("keeps the map primary and opens all drawers", async ({ page }) => {
    await enterWorld(page);
    await expect(page.getByLabel("世界地图")).toBeInViewport();
    await expect(page.locator(".mobile-dock button")).toHaveCount(5);
    for (const [buttonLabel, panelLabel] of [
      ["世界", "世界状态"], ["行动", "行动"], ["角色", "角色状态"], ["聊天", "世界聊天"],
    ] as const) {
      await page.locator(".mobile-dock button").filter({ hasText: buttonLabel }).click();
      await expect(page.getByLabel(panelLabel)).toHaveClass(/drawer-open/);
      await expect(page.getByLabel(panelLabel)).toBeInViewport();
    }
  });
});
