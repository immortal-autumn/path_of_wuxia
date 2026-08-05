import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { openGameDatabase } from "../lib/game/database";
import { parseMaintenanceOptions, runDatabaseMaintenance } from "../scripts/db-maintenance.mjs";

describe("database maintenance", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function fixture() {
    const directory = mkdtempSync(join(tmpdir(), "wuxia-db-maintenance-"));
    directories.push(directory);
    const databasePath = join(directory, "maintenance.db");
    const db = new DatabaseSync(databasePath);
    db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations VALUES (16,'2026-01-01T00:00:00.000Z');
      CREATE TABLE npc_trade_decisions(id TEXT PRIMARY KEY,status TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE market_ticks(id INTEGER PRIMARY KEY,created_at TEXT NOT NULL);
      CREATE TABLE market_orders(id TEXT PRIMARY KEY,status TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE market_trades(
        id INTEGER PRIMARY KEY,buy_order_id TEXT NOT NULL,sell_order_id TEXT NOT NULL,
        buyer_player_id TEXT,seller_player_id TEXT,created_at TEXT NOT NULL
      );
      CREATE TABLE market_order_cancellations(id TEXT PRIMARY KEY,order_id TEXT NOT NULL);
      CREATE TABLE currency_ledger(id TEXT PRIMARY KEY,created_at TEXT NOT NULL);

      INSERT INTO npc_trade_decisions VALUES
        ('old-terminal','executed','2026-01-01T00:00:00.000Z'),
        ('old-active','ready','2026-01-01T00:00:00.000Z'),
        ('recent-terminal','rejected','2026-07-20T00:00:00.000Z');
      INSERT INTO market_ticks VALUES
        (1,'2026-01-01T00:00:00.000Z'),(2,'2026-07-20T00:00:00.000Z');
      INSERT INTO market_orders VALUES
        ('old-untraded','cancelled','2026-01-01T00:00:00.000Z'),
        ('old-rejected','rejected','2026-01-01T00:00:00.000Z'),
        ('old-traded','cancelled','2026-01-01T00:00:00.000Z'),
        ('recent-cancelled','cancelled','2026-07-20T00:00:00.000Z'),
        ('sell-order','filled','2026-01-01T00:00:00.000Z');
      INSERT INTO market_trades VALUES
        (1,'old-traded','sell-order','buyer','seller','2026-01-01T00:00:00.000Z');
      INSERT INTO market_order_cancellations VALUES ('cancel-request','old-untraded');
      INSERT INTO currency_ledger VALUES ('permanent-ledger','2026-01-01T00:00:00.000Z');
    `);
    db.close();
    return databasePath;
  }

  it("reports eligible history without deleting anything by default", () => {
    const databasePath = fixture();
    const report = runDatabaseMaintenance({
      databasePath,
      now: new Date("2026-08-05T00:00:00.000Z"),
    });

    expect(report).toMatchObject({
      ok: true,
      mode: "dry-run",
      schemaVersion: 16,
      eligible: { npcTradeDecisions: 1, marketTicks: 1, closedMarketOrders: 2 },
      deleted: {
        npcTradeDecisions: 0,
        marketTicks: 0,
        closedMarketOrders: 0,
        marketOrderCancellations: 0,
      },
    });
    const db = new DatabaseSync(databasePath, { readOnly: true });
    expect(db.prepare("SELECT COUNT(*) AS count FROM npc_trade_decisions").get()).toEqual({ count: 3 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM market_ticks").get()).toEqual({ count: 2 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM market_orders").get()).toEqual({ count: 5 });
    db.close();
  });

  it("deletes only expired terminal history with --apply semantics", () => {
    const databasePath = fixture();
    const report = runDatabaseMaintenance({
      databasePath,
      apply: true,
      now: new Date("2026-08-05T00:00:00.000Z"),
    });

    expect(report.deleted).toEqual({
      npcTradeDecisions: 1,
      marketTicks: 1,
      closedMarketOrders: 2,
      marketOrderCancellations: 1,
    });
    const db = new DatabaseSync(databasePath, { readOnly: true });
    expect(db.prepare("SELECT id FROM npc_trade_decisions ORDER BY id").all()).toEqual([
      { id: "old-active" }, { id: "recent-terminal" },
    ]);
    expect(db.prepare("SELECT id FROM market_orders ORDER BY id").all()).toEqual([
      { id: "old-traded" }, { id: "recent-cancelled" }, { id: "sell-order" },
    ]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM currency_ledger").get()).toEqual({ count: 1 });
    db.close();
  });

  it("installs participant trade-history and due-combat indexes", () => {
    const db = openGameDatabase(":memory:");
    const indexes = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{ name: string }>)
        .map((row) => row.name),
    );
    expect(indexes.has("idx_market_trades_buyer")).toBe(true);
    expect(indexes.has("idx_market_trades_seller")).toBe(true);
    expect(indexes.has("idx_combat_turn_deadline")).toBe(true);
    const buyerPlan = db.prepare(`
      EXPLAIN QUERY PLAN SELECT * FROM market_trades
      WHERE buyer_player_id=? ORDER BY created_at DESC,id DESC
    `).all("npc-001") as Array<{ detail: string }>;
    const sellerPlan = db.prepare(`
      EXPLAIN QUERY PLAN SELECT * FROM market_trades
      WHERE seller_player_id=? ORDER BY created_at DESC,id DESC
    `).all("npc-001") as Array<{ detail: string }>;
    const combatPlan = db.prepare(`
      EXPLAIN QUERY PLAN SELECT * FROM combat_sessions
      WHERE status='active' AND turn_deadline<=? ORDER BY turn_deadline,id
    `).all("2026-08-05T00:00:00.000Z") as Array<{ detail: string }>;
    expect(buyerPlan.some((row) => row.detail.includes("idx_market_trades_buyer"))).toBe(true);
    expect(sellerPlan.some((row) => row.detail.includes("idx_market_trades_seller"))).toBe(true);
    expect(combatPlan.some((row) => row.detail.includes("idx_combat_turn_deadline"))).toBe(true);
    db.close();
  });

  it("accepts environment defaults and lets explicit CLI retention flags override them", () => {
    const options = parseMaintenanceOptions([
      "--apply",
      "--database=/tmp/maintenance.db",
      "--npc-trade-days=7",
      "--market-tick-days=8",
      "--closed-order-days=9",
      "--now=2026-08-05T00:00:00.000Z",
    ], {
      NPC_TRADE_DECISION_RETENTION_DAYS: "40",
      MARKET_TICK_RETENTION_DAYS: "50",
      MARKET_CLOSED_ORDER_RETENTION_DAYS: "60",
    });
    expect(options).toMatchObject({
      apply: true,
      databasePath: "/tmp/maintenance.db",
      retentionDays: { npcTradeDecisions: 7, marketTicks: 8, closedMarketOrders: 9 },
    });
    expect(options.now.toISOString()).toBe("2026-08-05T00:00:00.000Z");
  });
});
