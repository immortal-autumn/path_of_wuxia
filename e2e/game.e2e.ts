import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import WebSocket from "ws";
import { npcAgentToken } from "../lib/game/npc-auth";
import type { ServerMessage } from "../lib/game/protocol";

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
  const destination = page.getByRole("button", { name: new RegExp(`${locationName}.*可前往`) });
  await destination.click();
  await expect(page.getByRole("status")).toContainText(`已抵达${locationName}`);
  await expect(page.getByRole("button", { name: new RegExp(`${locationName}.*当前位置`) })).toBeVisible();
}

async function moveToId(page: Page, locationId: string, locationName: string) {
  const destination = page.locator(`[data-location-id="${locationId}"]`);
  await expect(destination).toHaveClass(/reachable/);
  await destination.click();
  await expect(destination).toHaveClass(/current/);
  await expect(page.getByRole("status")).toContainText(`已抵达${locationName}`);
}

async function transitionTo(page: Page, destinationName: string) {
  await page.getByRole("button", { name: new RegExp(`前往.*${destinationName}|进入.*${destinationName}|传送至.*${destinationName}`) }).click();
  await expect(page.getByRole("status")).toContainText(`已抵达${destinationName}`);
  await expect(page.getByRole("button", { name: new RegExp(`${destinationName}.*当前位置`) })).toBeVisible();
}

async function enterOverworld(page: Page) {
  await transitionTo(page, "嬴长嫚与楼夜秋之家·入口");
  await moveTo(page, "楼门路");
}

async function performAction(page: Page, actionName: string) {
  await page.locator(".action-card").filter({ has: page.getByText(actionName, { exact: true }) }).click();
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

  test("authenticates an isolated NPC actor and runs normal action commands over WebSocket", async () => {
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket("ws://127.0.0.1:3200/ws", {
        headers: { authorization: `Bearer ${npcAgentToken("npc-001")}` },
      });
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error("NPC WebSocket flow timed out"));
      }, 8_000);
      let cancelSent = false;
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as ServerMessage;
        if (message.type === "snapshot") {
          expect(message.snapshot.self.id).toBe("npc-001");
          expect(message.snapshot.self).not.toHaveProperty("controllerKind");
          socket.send(JSON.stringify({ type: "action.start", requestId: "npc-action-start", actionId: "action-observe" }));
        }
        if (message.type === "action.updated" && message.actionState.current && !cancelSent) {
          cancelSent = true;
          socket.send(JSON.stringify({ type: "action.cancel", requestId: "npc-action-cancel", jobId: message.actionState.current.id }));
        }
        if (message.type === "ack" && message.requestId === "npc-action-cancel") {
          clearTimeout(timeout);
          socket.close();
          resolve();
        }
        if (message.type === "error") {
          clearTimeout(timeout);
          socket.close();
          reject(new Error(message.message));
        }
      });
      socket.on("error", reject);
    });
  });
});

test.describe("game map", () => {
  test("shows only the current map's three-step rectangular-node neighborhood and free direction controls", async ({ page }) => {
    await enterWorld(page);
    await expect(page.getByLabel("世界地图")).toBeVisible();
    await expect(page.locator(".map-node")).toHaveCount(10);
    await expect(page.locator(".map-node .node-name")).toHaveCount(10);
    await expect(page.locator(".map-node .node-distance, .map-node .node-players")).toHaveCount(0);
    await expect(page.locator(".map-node.reachable")).toHaveCount(2);
    await expect(page.locator(".map-node.current")).toContainText("玄关");
    await expect(page.locator(".map-node.current .node-box")).toHaveAttribute("width", "120");
    await expect(page.locator(".map-node.current .node-box")).toHaveAttribute("height", "72");
    await expect(page.getByLabel("地图信息")).toContainText("当前位置玄关 · (0, 0)");
    await expect(page.getByLabel("地图信息")).toContainText("三步视野10 处");
    expect(await page.locator(".map-node .node-name").allTextContents()).toEqual(expect.arrayContaining(["玄关", "前庭", "门厅", "客厅", "餐厅", "修炼房"]));
    await page.getByRole("button", { name: /嬴长嫚与楼夜秋之家·门厅.*可前往/ }).hover();
    await expect(page.getByLabel("地图信息")).toContainText("指向地点嬴长嫚与楼夜秋之家·门厅 · (0, 1)");
    expect(await page.locator(".node-name").evaluateAll((nodes) => nodes.every((node) => (
      node.scrollWidth <= node.clientWidth && node.scrollHeight <= node.clientHeight
    )))).toBe(true);
    await expect(page.getByLabel("下一步可前往地点")).toContainText("下 · 嬴长嫚与楼夜秋之家·门厅");
    await expect(page.getByLabel("下一步可前往地点")).toContainText("左 · 嬴长嫚与楼夜秋之家·前庭");
    const endurance = await page.getByLabel(/耐力 \d+\/\d+/).getAttribute("aria-label");
    await expect(page.getByLabel("世界状态")).toContainText("中国标准时间");
    await expect(page.getByLabel("角色状态")).toContainText("嬴长嫚与楼夜秋之家");
    await moveTo(page, "嬴长嫚与楼夜秋之家·门厅");
    await expect(page.getByLabel("地图信息")).toContainText("当前位置嬴长嫚与楼夜秋之家·门厅");
    await expect(page.getByLabel(/耐力 \d+\/\d+/)).toHaveAttribute("aria-label", endurance!);
    await expect(page.getByLabel("下一步可前往地点")).toContainText("上 · 玄关");
    await expect(page.getByLabel("下一步可前往地点")).toContainText("左 · 嬴长嫚与楼夜秋之家·客用卫生间");
    await expect(page.getByLabel("下一步可前往地点")).toContainText("右 · 嬴长嫚与楼夜秋之家·客厅");
    await expect(page.getByLabel("下一步可前往地点")).toContainText("下 · 嬴长嫚与楼夜秋之家·主卧");
    await moveTo(page, "玄关");
    await enterOverworld(page);
    await expect(page.getByRole("heading", { name: "八方世界 · 局部地图" })).toBeVisible();
    await expect(page.locator(".map-node")).toHaveCount(8);
    await expect(page.getByLabel("下一步可前往地点")).toContainText("上 · 嬴长嫚与楼夜秋之家·入口");
    await expect(page.getByLabel("下一步可前往地点")).toContainText("左 · 楼门路");
    await expect(page.getByLabel("下一步可前往地点")).toContainText("右 · 楼门路");
  });

  test("opens a personal full map containing only locations the player has visited", async ({ page }) => {
    await enterWorld(page);
    await page.getByRole("button", { name: "足迹地图" }).click();
    let dialog = page.getByRole("dialog", { name: "足迹地图" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute("data-visited-locations", "1");
    await expect(dialog.locator(".visited-map-location")).toHaveCount(1);
    await expect(dialog.locator(".visited-map-route")).toHaveCount(0);
    await expect(dialog).toContainText("全部足迹 1 处");
    await expect(dialog).not.toContainText("门厅");
    await dialog.getByRole("button", { name: "关闭足迹地图" }).click();

    await moveTo(page, "嬴长嫚与楼夜秋之家·门厅");
    await moveTo(page, "玄关");
    await transitionTo(page, "嬴长嫚与楼夜秋之家·入口");
    await page.getByRole("button", { name: "足迹地图" }).click();
    dialog = page.getByRole("dialog", { name: "足迹地图" });
    await expect(dialog).toHaveAttribute("data-visited-locations", "3");
    await expect(dialog.getByLabel("选择足迹地图").locator("option")).toHaveCount(2);
    await expect(dialog.getByLabel("选择足迹地图").locator("option:checked")).toContainText("八方世界");
    await expect(dialog.locator(".visited-map-location")).toHaveCount(1);

    await dialog.getByLabel("选择足迹地图").selectOption("home-ground");
    await expect(dialog.locator(".visited-map-location")).toHaveCount(2);
    await expect(dialog.locator(".visited-map-route")).toHaveCount(1);
    await dialog.locator('[data-location-id="home-hall"]').click();
    await expect(dialog.getByLabel("足迹地图信息")).toContainText("嬴长嫚与楼夜秋之家·门厅");
    await expect(dialog.getByLabel("足迹地图信息")).toContainText("(0, 1)");
    await dialog.getByRole("button", { name: "关闭足迹地图" }).click();
    await expect(dialog).toBeHidden();
  });

  test("runs and reorders the real-time action queue while showing living needs", async ({ page }) => {
    await enterWorld(page);
    await expect(page.getByLabel("生活需求")).toContainText("饱食 100");
    await page.getByRole("button", { name: /观察四周/ }).click();
    await expect(page.getByRole("status")).toContainText("观察四周已经开始");
    await expect(page.getByLabel("行动队列")).toContainText("观察四周");
    await expect(page.getByLabel("行动队列")).toContainText("剩余");

    await page.getByRole("button", { name: /凝神聆听/ }).click();
    await expect(page.getByRole("status")).toContainText("凝神聆听已加入等待队列");
    await expect(page.getByLabel("行动队列")).toContainText("1 / 8");
    await page.getByRole("button", { name: "取消观察四周" }).click();
    await expect(page.getByRole("status")).toContainText("行动已取消");
    await expect(page.getByLabel("行动队列")).toContainText("凝神聆听");
    await page.getByRole("button", { name: "取消凝神聆听" }).click();
    await expect(page.getByLabel("行动队列")).toContainText("当前没有进行中的行动");
  });

  test("uses timed Qinggong and exposes private perception results with temporary Eagle Eye vision", async ({ page }) => {
    await enterWorld(page);
    await updatePlayer(page, "UPDATE action_templates SET check_json='{}' WHERE id IN ('action-qinggong','action-eagle-eye','action-observe') AND ? IS NOT NULL");

    await page.getByRole("button", { name: /轻功前往.*主卧/ }).click();
    await expect(page.getByRole("status")).toContainText("开始施展轻功");
    await expect(page.getByLabel("行动队列")).toContainText("施展轻功");
    await updatePlayer(page, "UPDATE action_jobs SET completes_at='2000-01-01T00:00:00.000Z' WHERE player_id=? AND status='running'");
    await expect(page.getByRole("button", { name: /嬴长嫚与楼夜秋之家·主卧.*当前位置/ })).toBeVisible();

    await page.getByRole("button", { name: /开启鹰眼/ }).click();
    await updatePlayer(page, "UPDATE action_jobs SET completes_at=? WHERE player_id=? AND status='running'", new Date(Date.now() - 1000).toISOString());
    await expect(page.getByLabel("地图信息")).toContainText("四步视野");
    await expect(page.getByLabel("个人行动记录")).toContainText("开启鹰眼成功");

    await page.getByRole("button", { name: /观察四周/ }).click();
    await updatePlayer(page, "UPDATE action_jobs SET completes_at='2000-01-01T00:00:00.000Z' WHERE player_id=? AND status='running'");
    await expect(page.getByLabel("个人行动记录")).toContainText("观察结果：");
  });

  test("equips persistent items and starts a real-time farm action", async ({ page }) => {
    await enterWorld(page);
    await page.getByRole("button", { name: "物品装备" }).click();
    const inventory = page.getByLabel("物品装备");
    await expect(inventory).toContainText("木剑");
    await expect(inventory).toContainText("已装备：weapon");
    await inventory.getByRole("button", { name: "卸下" }).first().click();
    await expect(page.getByRole("status")).toContainText("物品已卸下");
    await inventory.getByRole("button", { name: "装备" }).first().click();
    await expect(page.getByRole("status")).toContainText("装备已更新");

    await moveTo(page, "嬴长嫚与楼夜秋之家·前庭");
    await page.getByRole("button", { name: "播种水稻" }).click();
    await expect(page.getByRole("status")).toContainText("农耕行动已经开始");
    await expect(page.getByLabel("行动队列")).toContainText("播种");
    await page.getByRole("button", { name: "取消播种" }).click();
    await expect(page.getByRole("status")).toContainText("行动已取消");
  });

  test("executes seed actions and crosses the continuous Song and Palos overworld", async ({ page }) => {
    await enterWorld(page);
    await performAction(page, "整理衣装");
    await enterOverworld(page);
    await performAction(page, "观察街道");
    await moveToId(page, "loumen-road-west", "楼门路");
    await moveTo(page, "大宋入口");
    await performAction(page, "眺望大宋");
    await moveTo(page, "大宋东关官道");
    await moveToId(page, "song-atlas-road-m1-p1", "大宋官道");
    await expect(page.getByRole("heading", { name: "八方世界 · 局部地图" })).toBeVisible();

    await moveTo(page, "大宋东关官道");
    await moveTo(page, "大宋入口");
    await moveToId(page, "loumen-road-west", "楼门路");
    await moveToId(page, "loumen-road", "楼门路");
    await moveToId(page, "loumen-road-east", "楼门路");
    await moveTo(page, "帕洛斯入口");
    await performAction(page, "眺望帕洛斯");
    await moveTo(page, "帕洛斯西部航路");
    await moveToId(page, "palos-map-road-p7-p3", "帕洛斯道路");
    await expect(page.getByRole("heading", { name: "八方世界 · 局部地图" })).toBeVisible();
    await page.reload();
    await expect(page.locator('[data-location-id="palos-map-road-p7-p3"]')).toHaveClass(/current/);
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
    await expect(page.locator(".derived-grid")).toContainText("最大攻击45");
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
    await moveTo(page, "嬴长嫚与楼夜秋之家·主卧");
    await moveTo(page, "嬴长嫚与楼夜秋之家·修炼房");
    await page.getByRole("button", { name: "修炼突破" }).click();
    await expect(page.locator(".cultivation-panel")).toContainText("修炼中 · 每分钟 15");
    await updatePlayer(page, "UPDATE player_progression SET training_anchor_at=? WHERE player_id=?", new Date(Date.now() - 10 * 60_000).toISOString());
    await performAction(page, "静心修炼");
    await expect(page.locator(".cultivation-panel")).not.toContainText("0 / 100 修为");
  });
});

test.describe("map editor", () => {
  test("keeps editor node text concise and reflows the workspace without page-level overflow", async ({ page }) => {
    await enterEditor(page);
    const editorCanvas = page.getByLabel("地图编辑画布");
    const loadedLocations = Number(await editorCanvas.getAttribute("data-loaded-locations"));
    const renderedLocations = Number(await editorCanvas.getAttribute("data-rendered-locations"));
    expect(renderedLocations).toBeGreaterThan(0);
    expect(renderedLocations).toBeLessThan(loadedLocations);
    const locationCount = await page.locator(".editor-location").count();
    await expect(page.locator(".editor-location-name")).toHaveCount(locationCount);
    await expect(page.locator(".editor-location text, .editor-location-grid")).toHaveCount(0);
    await expect(page.locator(".editor-location rect").first()).toHaveAttribute("width", "120");
    await expect(page.locator(".editor-location rect").first()).toHaveAttribute("height", "80");
    expect(await page.locator(".editor-location-name").evaluateAll((nodes) => nodes.every((node) => (
      node.scrollWidth <= node.clientWidth && node.scrollHeight <= node.clientHeight
    )))).toBe(true);
    await expect(page.getByLabel("画布信息")).toContainText("当前地图八方世界");
    await expect(page.getByLabel("当前地图").locator("option")).toHaveCount(2);
    await expect(page.locator(".editor-location-name").filter({ hasText: "住宅入口" })).toHaveCount(1);
    await expect(page.locator(".editor-location-name").filter({ hasText: "楼门路" })).toHaveCount(3);
    expect(await page.locator(".editor-location-name").allTextContents()).not.toContain("嬴长嫚与楼夜秋之家·入口");
    await page.getByLabel("定位地点").fill("楼门路");
    await page.getByRole("button", { name: "查找" }).click();
    await expect(page.getByLabel("定位结果").locator("option")).toHaveCount(4);
    await expect(page.getByLabel("定位结果")).toContainText("楼门路 · (2, 2)");
    await expect(page.getByLabel("定位结果")).toContainText("楼门路 · (3, 2)");
    await expect(page.getByLabel("定位结果")).toContainText("楼门路 · (4, 2)");
    await page.getByLabel("定位结果").selectOption("loumen-road");
    await expect(page.getByLabel("画布信息")).toContainText("已选地点：楼门路 · 网格");
    await expect(page.locator(".editor-selection-summary")).toContainText("楼门路");
    await expect(page.getByRole("button", { name: "完成编辑" })).toBeDisabled();

    await page.getByLabel("定位地点").fill("初始台地");
    await page.getByRole("button", { name: "查找" }).click();
    await page.getByLabel("定位结果").selectOption("palos-fasttravel-1001");
    await expect(page.getByRole("status")).toContainText("已定位至帕洛斯传送点·初始台地");
    await expect(page.getByLabel("画布信息")).toContainText("已选地点：帕洛斯传送点·初始台地");
    await expect(page.locator(".editor-location-name").filter({ hasText: "初始台地" })).toBeVisible();
    await expect(page.getByRole("button", { name: "完成编辑" })).toBeDisabled();

    await page.setViewportSize({ width: 768, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page.getByLabel("地图编辑画布")).toBeVisible();
    await page.locator(".editor-inspector").scrollIntoViewIfNeeded();
    await expect(page.locator(".editor-inspector")).toBeVisible();
  });

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
    await page.locator('[data-location-id="loumen-road"]').click();
    await page.getByLabel("路线类型").selectOption("transition");
    await selectEditorLayer(page, targetLayerName, "目标地图层");
    await expect(page.getByLabel("连接目标").locator("option")).toHaveCount(2);
    const crossLayerTarget = await page.getByLabel("连接目标").locator("option").filter({ hasText: `跨层测试点${suffix}` }).getAttribute("value");
    if (!crossLayerTarget) throw new Error("Cross-layer target has no option value");
    await page.getByLabel("连接目标").selectOption(crossLayerTarget);
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

    await page.getByLabel("连接目标").selectOption("palos-gate");
    await page.getByRole("button", { name: "建立连接" }).click();
    await expect(page.getByRole("status")).toContainText("自动保存");
    await expect(page.locator(".route-list")).toContainText("帕洛斯入口");

    const game = await page.context().newPage();
    await enterWorld(game);
    await enterOverworld(game);
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
    await selectEditorLayer(first, "嬴长嫚与楼夜秋之家");
    await selectEditorLayer(second, "嬴长嫚与楼夜秋之家");

    const homeRegion = first.locator(".editor-region").filter({ hasText: "嬴长嫚与楼夜秋之家" });
    const homeBox = await homeRegion.boundingBox();
    if (!homeBox) throw new Error("Home region has no bounds");
    const dragStart = { x: homeBox.x + 25, y: homeBox.y + homeBox.height - 25 };
    await first.mouse.move(dragStart.x, dragStart.y);
    await first.mouse.down();
    await first.mouse.move(dragStart.x + 40, dragStart.y + 20, { steps: 4 });
    await first.mouse.up();
    await expect(first.getByRole("status")).toContainText("自动保存");

    const secondHomeRegion = second.locator(".editor-region").filter({ hasText: "嬴长嫚与楼夜秋之家" });
    const secondHomeBox = await secondHomeRegion.boundingBox();
    if (!secondHomeBox) throw new Error("Second editor home region has no bounds");
    await second.mouse.click(secondHomeBox.x + 25, secondHomeBox.y + secondHomeBox.height - 25);
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
    const hallNode = second.getByRole("button", { name: /嬴长嫚与楼夜秋之家·门厅.*可前往/ });
    await expect(hallNode.locator(".node-name")).toHaveText("门厅");
    await expect(hallNode).not.toContainText("在线");
    await expect(second.getByLabel("地图信息")).toContainText("三步视野10 处 · 2 人");
    await firstContext.close();
    await expect(second.getByLabel("世界状态")).toContainText("1 位侠客在线");
    await secondContext.close();
  });

  test("negotiates relationships, adult consent, and an atomic direct trade", async ({ browser }) => {
    const firstContext = await browser.newContext();
    const secondContext = await browser.newContext();
    const first = await newPlayer(firstContext);
    const second = await newPlayer(secondContext);
    const firstName = await first.locator(".character-heading h2").innerText();
    const secondName = await second.locator(".character-heading h2").innerText();

    for (const page of [first, second]) {
      await page.getByRole("button", { name: "交往交易" }).click();
      await page.getByLabel("角色年龄状态").selectOption("adult");
      await page.getByLabel("开启成人内容（仍需每次单独同意）").check();
      await page.getByRole("button", { name: "保存设置" }).click();
      await expect(page.getByRole("status")).toContainText("成人内容已开启");
    }

    const secondCardOnFirst = first.locator(".social-player").filter({ hasText: secondName });
    await secondCardOnFirst.getByRole("button", { name: "结交" }).click();
    const firstRequestOnSecond = second.getByLabel("互动请求").locator(".social-request").filter({ hasText: firstName });
    await firstRequestOnSecond.getByRole("button", { name: "接受" }).click();
    await expect(first.getByLabel("角色关系")).toContainText(secondName);
    await expect(second.getByLabel("角色关系")).toContainText(firstName);

    await secondCardOnFirst.getByRole("button", { name: "交易" }).click();
    const pendingTrade = second.getByLabel("交易会话").locator(".trade-card");
    await pendingTrade.getByRole("button", { name: "接受交易" }).click();
    const firstTrade = first.getByLabel("交易会话").locator(".trade-card");
    await firstTrade.getByLabel("银两").fill("1");
    await firstTrade.getByRole("button", { name: "更新报价" }).click();
    await firstTrade.getByRole("button", { name: "确认报价" }).click();
    const secondTrade = second.getByLabel("交易会话").locator(".trade-card");
    await expect(secondTrade).toContainText("对方已确认");
    await secondTrade.getByRole("button", { name: "确认报价" }).click();
    await expect(second.getByRole("status")).toContainText("交易完成");
    await expect(first.getByLabel("交易会话")).toContainText("没有交易会话");

    await secondCardOnFirst.getByRole("button", { name: "私密亲昵" }).click();
    const intimateRequest = second.getByLabel("互动请求").locator(".social-request").filter({ hasText: firstName });
    await intimateRequest.getByRole("button", { name: "接受" }).click();
    await expect(first.getByLabel("行动队列")).toContainText("私密亲昵");
    await first.getByRole("button", { name: "取消私密亲昵" }).click();

    await firstContext.close();
    await secondContext.close();
  });

  test("runs authoritative combat turns and auto-flees after repeated 30-second timeouts", async ({ browser }) => {
    const firstContext = await browser.newContext();
    const secondContext = await browser.newContext();
    const first = await newPlayer(firstContext);
    const second = await newPlayer(secondContext);
    const secondName = await second.locator(".character-heading h2").innerText();
    await first.getByRole("button", { name: "交往交易" }).click();
    const target = first.locator(".social-player").filter({ hasText: secondName });
    await target.getByRole("button", { name: "攻击" }).click();

    await expect(first.getByLabel("当前战斗")).toContainText(`对阵 ${secondName}`);
    await expect(first.getByLabel("当前战斗")).toContainText("你的回合");
    await expect(second.getByLabel("当前战斗")).toContainText("等待对方行动");
    await first.getByLabel("当前战斗").getByRole("button", { name: "格挡" }).click();
    await expect(second.getByLabel("当前战斗")).toContainText("你的回合");
    await expect(first.getByLabel("当前战斗")).toContainText("沉身格挡");

    await updatePlayer(first, `
      UPDATE combat_sessions SET turn_deadline='2000-01-01T00:00:00.000Z'
      WHERE id=(SELECT id FROM combat_sessions WHERE status='active' AND attacker_id=? ORDER BY created_at DESC LIMIT 1)
    `);
    await expect(first.getByLabel("当前战斗")).toBeHidden();
    await expect(second.getByLabel("当前战斗")).toBeHidden();
    await expect(first.getByText("的掉落", { exact: false })).toHaveCount(0);

    await firstContext.close();
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
    expect(await page.locator(".map-node").evaluateAll((nodes) => nodes.filter((node) => {
      const box = node.getBoundingClientRect();
      return box.right > 0 && box.left < window.innerWidth && box.bottom > 0 && box.top < window.innerHeight;
    }).length)).toBeGreaterThanOrEqual(3);
    await expect(page.locator(".mobile-dock button")).toHaveCount(6);
    await page.locator(".mobile-dock button").filter({ hasText: "足迹" }).click();
    await expect(page.getByRole("dialog", { name: "足迹地图" })).toBeInViewport();
    await page.getByRole("button", { name: "关闭足迹地图" }).click();
    for (const [buttonLabel, panelLabel] of [
      ["世界", "世界状态"], ["行动", "行动"], ["角色", "角色状态"], ["聊天", "世界聊天"],
    ] as const) {
      await page.locator(".mobile-dock button").filter({ hasText: buttonLabel }).click();
      await expect(page.getByLabel(panelLabel, { exact: true })).toHaveClass(/drawer-open/);
      await expect(page.getByLabel(panelLabel, { exact: true })).toBeInViewport();
    }
  });
});
