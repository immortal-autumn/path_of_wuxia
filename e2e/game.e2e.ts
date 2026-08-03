import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";

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
  await expect.poll(() => page.locator(".editor-location").count()).toBeGreaterThanOrEqual(3);
}

async function selectEditorLayer(page: Page, name: string, label = "当前地图") {
  const option = page.getByLabel(label).locator("option").filter({ hasText: name }).first();
  const value = await option.getAttribute("value");
  if (!value) throw new Error(`Map layer ${name} has no option value`);
  await page.getByLabel(label).selectOption(value);
  return value;
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

async function transitionTo(page: Page, destinationName: string) {
  await page.getByRole("button", { name: new RegExp(`前往.*${destinationName}|进入.*${destinationName}|传送至.*${destinationName}`) }).click();
  await expect(page.getByRole("status")).toContainText(`已抵达${destinationName}`);
  await expect(page.getByRole("button", { name: new RegExp(`${destinationName}，当前位置`) })).toBeVisible();
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

async function updatePlayer(page: Page, sql: string, ...params: Array<string | number>) {
  const databasePath = process.env.PLAYWRIGHT_DATABASE_PATH;
  if (!databasePath) throw new Error("PLAYWRIGHT_DATABASE_PATH is not configured");
  const playerName = await page.locator(".character-heading h2").innerText();
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA busy_timeout=5000");
  try {
    const player = db.prepare("SELECT id FROM players WHERE name=?").get(playerName) as { id: string } | undefined;
    if (!player) throw new Error("Visible player was not found in the Playwright database");
    db.prepare(sql).run(...params, player.id);
  } finally {
    db.close();
  }
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
  test("shows only the current layer's three-step square-node neighborhood and free direction controls", async ({ page }) => {
    await enterWorld(page);
    await expect(page.getByLabel("世界地图")).toBeVisible();
    await expect(page.locator(".map-node")).toHaveCount(4);
    await expect(page.locator(".map-node .node-name")).toHaveCount(4);
    await expect(page.locator(".map-node .node-distance, .map-node .node-players")).toHaveCount(0);
    await expect(page.locator(".map-node.reachable")).toHaveCount(1);
    await expect(page.locator(".map-node.current")).toContainText("玄关");
    await expect(page.locator(".map-node.current .node-box")).toHaveAttribute("width", "120");
    await expect(page.locator(".map-node.current .node-box")).toHaveAttribute("height", "120");
    await expect(page.getByLabel("地图信息")).toContainText("当前位置玄关");
    await expect(page.getByLabel("地图信息")).toContainText("可见地点4 处");
    expect(await page.locator(".node-name").evaluateAll((nodes) => nodes.every((node) => (
      node.scrollWidth <= node.clientWidth && node.scrollHeight <= node.clientHeight
    )))).toBe(true);
    await expect(page.getByLabel("下一步可前往地点")).toContainText("下 · 嬴长嫚与楼夜秋之家·门厅");
    const endurance = await page.getByLabel(/耐力 \d+\/\d+/).getAttribute("aria-label");
    await expect(page.getByLabel("世界状态")).toContainText("中国标准时间");
    await expect(page.getByLabel("角色状态")).toContainText("嬴长嫚与楼夜秋之家");
    await moveTo(page, "嬴长嫚与楼夜秋之家·门厅");
    await expect(page.getByLabel("地图信息")).toContainText("当前位置嬴长嫚与楼夜秋之家·门厅");
    await expect(page.getByLabel(/耐力 \d+\/\d+/)).toHaveAttribute("aria-label", endurance!);
    await expect(page.getByLabel("下一步可前往地点")).toContainText("上 · 玄关");
    await expect(page.getByLabel("下一步可前往地点")).toContainText("右 · 嬴长嫚与楼夜秋之家·客厅");
    await moveTo(page, "玄关");
    await transitionTo(page, "楼门路");
    await expect(page.getByRole("heading", { name: "八方世界 · 局部地图" })).toBeVisible();
    await expect(page.locator(".map-node")).toHaveCount(3);
    await expect(page.getByLabel("下一步可前往地点")).toContainText("左 · 大宋入口");
    await expect(page.getByLabel("下一步可前往地点")).toContainText("右 · 帕洛斯入口");
  });

  test("executes seed actions and enters the Northern Song and Palos hierarchies through action-only transitions", async ({ page }) => {
    await enterWorld(page);
    await performAction(page, "整理衣装");
    await transitionTo(page, "楼门路");
    await performAction(page, "观察街道");
    await moveTo(page, "大宋入口");
    await performAction(page, "眺望大宋");
    await transitionTo(page, "北宋舆图入口");
    await expect(page.getByRole("heading", { name: "北宋舆图 · 局部地图" })).toBeVisible();
    await moveTo(page, "北宋总览·京畿路");
    await transitionTo(page, "京畿路·路口");
    await expect(page.getByRole("heading", { name: "北宋·京畿路 · 局部地图" })).toBeVisible();

    await transitionTo(page, "北宋总览·京畿路");
    await moveTo(page, "北宋舆图入口");
    await transitionTo(page, "大宋入口");
    await moveTo(page, "楼门路");
    await moveTo(page, "帕洛斯入口");
    await performAction(page, "眺望帕洛斯");
    await transitionTo(page, "帕洛斯群岛入口");
    await expect(page.getByRole("heading", { name: "帕洛斯群岛 · 局部地图" })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("button", { name: /帕洛斯群岛入口，当前位置/ })).toBeVisible();
  });

  test("moves when crypto.randomUUID is unavailable over plain HTTP", async ({ page }) => {
    await disableRandomUuid(page);
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await enterWorld(page);
    await page.getByRole("button", { name: /下，前往嬴长嫚与楼夜秋之家·门厅/ }).click();
    await expect(page.getByRole("status")).toContainText("已抵达嬴长嫚与楼夜秋之家·门厅");
    expect(pageErrors).toEqual([]);
  });

  test("shows derived stats, performs a guaranteed breakthrough, and allocates the larger realm reward", async ({ page }) => {
    await enterWorld(page);
    await updatePlayer(page, `
      UPDATE player_progression SET realm_index=0,realm_level=12,cultivation_progress=350,
        unspent_points=0,training_anchor_at=NULL,updated_at='2026-08-03T00:00:00.000Z' WHERE player_id=?
    `);
    await moveTo(page, "嬴长嫚与楼夜秋之家·门厅");
    await page.getByRole("button", { name: "战斗属性" }).click();
    await expect(page.locator(".derived-grid")).toContainText("最大攻击40");
    await expect(page.locator(".derived-grid")).toContainText("境界倍率 ×1.00");
    await page.getByRole("button", { name: "修炼突破" }).click();
    await expect(page.locator(".cultivation-panel")).toContainText("突破成功率 100%");
    await page.getByRole("button", { name: "尝试突破" }).click();
    await expect(page.getByRole("status")).toContainText("突破至后天境界");
    await page.getByRole("button", { name: "基础属性" }).click();
    await expect(page.locator(".attribute-panel")).toContainText("可分配：15 点");
    const strength = page.locator(".attribute-row").filter({ hasText: "力量" });
    await strength.getByRole("button", { name: "+" }).click();
    await strength.getByRole("button", { name: "+" }).click();
    await page.getByRole("button", { name: /确认分配 2/ }).click();
    await expect(page.getByRole("status")).toContainText("已分配2点属性");
    await expect(page.locator(".attribute-panel")).toContainText("可分配：13 点");
  });

  test("starts automatic cultivation in the training room and settles server-time offline gain", async ({ page }) => {
    await enterWorld(page);
    await moveTo(page, "嬴长嫚与楼夜秋之家·门厅");
    await transitionTo(page, "嬴长嫚与楼夜秋之家·地下层平台");
    await moveTo(page, "嬴长嫚与楼夜秋之家·修炼房");
    await page.getByRole("button", { name: "修炼突破" }).click();
    await expect(page.locator(".cultivation-panel")).toContainText("修炼中 · 每分钟 15");
    await updatePlayer(page, "UPDATE player_progression SET training_anchor_at=? WHERE player_id=?", new Date(Date.now() - 10 * 60_000).toISOString());
    await performAction(page, "静心修炼");
    await expect(page.locator(".cultivation-panel")).not.toContainText("0 / 100 修为");
  });
});

test.describe("map editor", () => {
  test("creates, updates and deletes layers, then builds a typed cross-layer connection", async ({ page }) => {
    await enterEditor(page);
    const suffix = Date.now();
    const emptyLayerName = `空测试层${suffix}`;
    const targetLayerName = `跨层目标${suffix}`;
    const newLayer = page.locator("details.layer-editor").filter({ hasText: "新增地图层" });
    await newLayer.locator("summary").click();
    await newLayer.getByLabel("新层名称").fill(emptyLayerName);
    await newLayer.getByLabel("新层描述").fill("用于验证地图层生命周期。");
    await newLayer.getByRole("button", { name: "新增地图层" }).click();
    await expect(page.getByLabel("当前地图").locator("option:checked")).toContainText(emptyLayerName);

    const currentLayer = page.locator("details.layer-editor").filter({ hasText: "编辑当前层" });
    await currentLayer.getByLabel("地图层名称").fill(`${emptyLayerName}改`);
    await currentLayer.getByRole("button", { name: "保存地图层" }).click();
    await expect(page.getByLabel("当前地图").locator("option:checked")).toContainText(`${emptyLayerName}改`);
    await currentLayer.getByRole("button", { name: "删除空地图层" }).click();
    await expect(page.getByLabel("当前地图").locator("option:checked")).toContainText("八方世界");

    await newLayer.getByLabel("新层名称").fill(targetLayerName);
    await newLayer.getByLabel("新层描述").fill("跨层路线目标层。");
    await newLayer.getByRole("button", { name: "新增地图层" }).click();
    await expect(page.getByLabel("当前地图").locator("option:checked")).toContainText(targetLayerName);

    const palette = page.locator(".palette-item").filter({ hasText: "小地点" });
    const svg = page.locator(".editor-canvas svg");
    const box = await svg.boundingBox();
    if (!box) throw new Error("Editor canvas has no bounds");
    await palette.dragTo(svg, { targetPosition: { x: box.width * 0.55, y: box.height * 0.45 } });
    await expect(page.locator(".editor-location.selected")).toBeVisible();
    const inspector = page.locator(".editor-inspector form");
    await inspector.getByLabel("名称", { exact: true }).fill(`跨层测试点${suffix}`);
    await inspector.getByRole("button", { name: "保存地点资料" }).click();
    await expect(page.getByRole("status")).toContainText("自动保存");

    await selectEditorLayer(page, "八方世界");
    await page.locator(".editor-location").filter({ hasText: "楼门路" }).click();
    await page.getByLabel("路线类型").selectOption("transition");
    await selectEditorLayer(page, targetLayerName, "目标地图层");
    await expect(page.getByLabel("连接目标").locator("option")).toHaveCount(2);
    await page.getByLabel("连接目标").selectOption({ label: `跨层测试点${suffix}` });
    await page.getByLabel("跨层方式").selectOption("road");
    await page.getByRole("button", { name: "建立连接" }).click();
    await expect(page.getByRole("status")).toContainText("自动保存");
    await expect(page.locator(".route-list")).toContainText(`跨层测试点${suffix}`);
    await page.getByRole("button", { name: "完成编辑" }).click();
    await expect(page.getByRole("button", { name: "完成编辑" })).toBeDisabled();
  });

  test("drags a snapped location, auto-saves, undoes, redoes, and creates an eight-direction route", async ({ page }) => {
    await disableRandomUuid(page);
    await enterEditor(page);
    const initialLocationCount = await page.locator(".editor-location").count();
    const palette = page.locator(".palette-item").filter({ hasText: "小地点" });
    const svg = page.locator(".editor-canvas svg");
    const box = await svg.boundingBox();
    if (!box) throw new Error("Editor canvas has no bounds");
    await palette.dragTo(svg, { targetPosition: { x: box.width * 0.59, y: box.height * 0.48 } });
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
    await expect(page.locator(".route-list")).toContainText("帕洛斯入口");

    const game = await page.context().newPage();
    await enterWorld(game);
    await transitionTo(game, "楼门路");
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
    await selectEditorLayer(first, "住宅一层");
    await selectEditorLayer(second, "住宅一层");

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
    await second.getByRole("button", { name: "完成编辑" }).click();
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
    await moveTo(first, "嬴长嫚与楼夜秋之家·门厅");
    await expect(second.locator(".map-node").filter({ hasText: "嬴长嫚与楼夜秋之家·门厅" })).not.toContainText("在线");
    await expect(second.getByLabel("地图信息")).toContainText("三步内侠客2 人");
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
    await expect(page.getByLabel("地图信息")).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
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
