import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

export const DEFAULT_RETENTION_DAYS = Object.freeze({
  npcTradeDecisions: 30,
  marketTicks: 30,
  closedMarketOrders: 90,
});

const RETENTION_ENV = Object.freeze({
  npcTradeDecisions: "NPC_TRADE_DECISION_RETENTION_DAYS",
  marketTicks: "MARKET_TICK_RETENTION_DAYS",
  closedMarketOrders: "MARKET_CLOSED_ORDER_RETENTION_DAYS",
});

function parseNonNegativeDays(value, label) {
  const days = Number(value);
  if (!Number.isInteger(days) || days < 0 || days > 36_500) {
    throw new Error(`${label} must be an integer between 0 and 36500`);
  }
  return days;
}

export function parseMaintenanceOptions(argv = [], env = {}) {
  const options = {
    apply: false,
    databasePath: env.DATABASE_PATH ?? "data/wuxia.db",
    now: new Date(),
    retentionDays: { ...DEFAULT_RETENTION_DAYS },
  };

  for (const key of Object.keys(DEFAULT_RETENTION_DAYS)) {
    const envName = RETENTION_ENV[key];
    if (env[envName] !== undefined) {
      options.retentionDays[key] = parseNonNegativeDays(env[envName], envName);
    }
  }

  for (const argument of argv) {
    if (argument === "--apply") {
      options.apply = true;
    } else if (argument.startsWith("--database=")) {
      options.databasePath = argument.slice("--database=".length);
    } else if (argument.startsWith("--now=")) {
      options.now = new Date(argument.slice("--now=".length));
    } else if (argument.startsWith("--npc-trade-days=")) {
      options.retentionDays.npcTradeDecisions = parseNonNegativeDays(
        argument.slice("--npc-trade-days=".length), "--npc-trade-days",
      );
    } else if (argument.startsWith("--market-tick-days=")) {
      options.retentionDays.marketTicks = parseNonNegativeDays(
        argument.slice("--market-tick-days=".length), "--market-tick-days",
      );
    } else if (argument.startsWith("--closed-order-days=")) {
      options.retentionDays.closedMarketOrders = parseNonNegativeDays(
        argument.slice("--closed-order-days=".length), "--closed-order-days",
      );
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!options.databasePath) throw new Error("Database path cannot be empty");
  if (Number.isNaN(options.now.getTime())) throw new Error("--now must be a valid ISO timestamp");
  return options;
}

function cutoff(now, days) {
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

function fileSize(path) {
  return existsSync(path) ? statSync(path).size : 0;
}

function databaseSizes(databasePath) {
  return {
    databaseBytes: fileSize(databasePath),
    walBytes: fileSize(`${databasePath}-wal`),
    shmBytes: fileSize(`${databasePath}-shm`),
  };
}

function scalarCount(db, sql, ...parameters) {
  return Number(db.prepare(sql).get(...parameters).count);
}

function eligibleClosedOrderSql(projection) {
  return `
    SELECT ${projection} FROM market_orders AS market_order
    WHERE market_order.status IN ('cancelled','rejected')
      AND market_order.updated_at < ?
      AND NOT EXISTS (
        SELECT 1 FROM market_trades AS trade
        WHERE trade.buy_order_id=market_order.id OR trade.sell_order_id=market_order.id
      )
  `;
}

export function runDatabaseMaintenance({ databasePath, apply = false, now = new Date(), retentionDays = {} }) {
  const absolutePath = resolve(databasePath);
  if (!existsSync(absolutePath)) throw new Error(`Database does not exist: ${absolutePath}`);
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error("now must be a valid Date");

  const retention = {
    ...DEFAULT_RETENTION_DAYS,
    ...retentionDays,
  };
  for (const key of Object.keys(DEFAULT_RETENTION_DAYS)) {
    retention[key] = parseNonNegativeDays(retention[key], key);
  }
  const cutoffs = {
    npcTradeDecisions: cutoff(now, retention.npcTradeDecisions),
    marketTicks: cutoff(now, retention.marketTicks),
    closedMarketOrders: cutoff(now, retention.closedMarketOrders),
  };

  const sizesBefore = databaseSizes(absolutePath);
  const db = new DatabaseSync(absolutePath);
  let report;
  try {
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA busy_timeout = 5000");

    const integrityRows = db.prepare("PRAGMA integrity_check").all();
    const integrity = integrityRows.map((row) => String(row.integrity_check));
    const integrityOk = integrity.length === 1 && integrity[0] === "ok";
    const schemaVersion = Number(
      db.prepare("SELECT COALESCE(MAX(version),0) AS version FROM schema_migrations").get().version,
    );
    const eligible = {
      npcTradeDecisions: scalarCount(db, `
        SELECT COUNT(*) AS count FROM npc_trade_decisions
        WHERE status IN ('executed','skipped','rejected') AND created_at < ?
      `, cutoffs.npcTradeDecisions),
      marketTicks: scalarCount(
        db, "SELECT COUNT(*) AS count FROM market_ticks WHERE created_at < ?", cutoffs.marketTicks,
      ),
      closedMarketOrders: scalarCount(
        db, eligibleClosedOrderSql("COUNT(*) AS count"), cutoffs.closedMarketOrders,
      ),
    };
    const deleted = {
      npcTradeDecisions: 0,
      marketTicks: 0,
      closedMarketOrders: 0,
      marketOrderCancellations: 0,
    };

    if (apply) {
      if (!integrityOk) throw new Error(`Integrity check failed: ${integrity.join("; ")}`);
      db.exec("BEGIN IMMEDIATE");
      try {
        deleted.npcTradeDecisions = Number(db.prepare(`
          DELETE FROM npc_trade_decisions
          WHERE status IN ('executed','skipped','rejected') AND created_at < ?
        `).run(cutoffs.npcTradeDecisions).changes);
        deleted.marketTicks = Number(
          db.prepare("DELETE FROM market_ticks WHERE created_at < ?").run(cutoffs.marketTicks).changes,
        );
        deleted.marketOrderCancellations = Number(db.prepare(`
          DELETE FROM market_order_cancellations
          WHERE order_id IN (${eligibleClosedOrderSql("market_order.id")})
        `).run(cutoffs.closedMarketOrders).changes);
        deleted.closedMarketOrders = Number(db.prepare(`
          DELETE FROM market_orders
          WHERE id IN (${eligibleClosedOrderSql("market_order.id")})
        `).run(cutoffs.closedMarketOrders).changes);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }

    const checkpointRow = db.prepare("PRAGMA wal_checkpoint(PASSIVE)").get();
    report = {
      ok: integrityOk,
      mode: apply ? "apply" : "dry-run",
      databasePath: absolutePath,
      checkedAt: now.toISOString(),
      schemaVersion,
      retentionDays: retention,
      cutoffs,
      integrity,
      eligible,
      deleted,
      checkpoint: {
        busy: Number(checkpointRow.busy),
        logFrames: Number(checkpointRow.log),
        checkpointedFrames: Number(checkpointRow.checkpointed),
      },
    };
  } finally {
    db.close();
  }

  return {
    ...report,
    sizes: {
      before: sizesBefore,
      after: databaseSizes(absolutePath),
    },
  };
}

export function main(argv = process.argv.slice(2), env = process.env) {
  try {
    const options = parseMaintenanceOptions(argv, env);
    const report = runDatabaseMaintenance(options);
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }, null, 2));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
