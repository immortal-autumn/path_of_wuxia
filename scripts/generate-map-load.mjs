import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

const countArgument = process.argv.find((value) => value.startsWith("--locations="));
const requestedCount = Number(countArgument?.split("=")[1] ?? 50_000);
if (!Number.isInteger(requestedCount) || requestedCount < 1 || requestedCount > 250_000) {
  throw new Error("--locations must be an integer between 1 and 250000");
}

const databasePath = resolve(process.env.DATABASE_PATH ?? "data/wuxia.db");
const database = new DatabaseSync(databasePath);
database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000");

const table = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='locations'").get();
if (!table) {
  database.close();
  throw new Error("The database is not initialized. Start the application once before generating load data.");
}

const startedAt = performance.now();
database.exec("BEGIN IMMEDIATE");
try {
  database.prepare("DELETE FROM action_definitions WHERE location_id LIKE 'load-%'").run();
  database.prepare("DELETE FROM locations WHERE id LIKE 'load-%'").run();
  const insert = database.prepare(`
    INSERT INTO locations(
      id,name,region,description,x,y,region_id,grid_x,grid_y,chunk_x,chunk_y,version,is_active
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,1)
  `);
  const side = Math.ceil(Math.sqrt(requestedCount));
  for (let index = 0; index < requestedCount; index += 1) {
    const gridX = 100 + (index % side);
    const gridY = 100 + Math.floor(index / side);
    const x = gridX * 160;
    const y = gridY * 160;
    insert.run(
      `load-${index}`,
      `压力地点${index}`,
      "性能测试区域",
      "由五万级地图生成器创建。",
      x,
      y,
      null,
      gridX,
      gridY,
      Math.floor(x / 1000),
      Math.floor(y / 1000),
    );
  }
  database.exec("COMMIT");
} catch (error) {
  database.exec("ROLLBACK");
  database.close();
  throw error;
}

const generatedMs = performance.now() - startedAt;
const queryStartedAt = performance.now();
const sample = database.prepare(`
  SELECT id FROM locations
  WHERE is_active=1 AND chunk_x BETWEEN ? AND ? AND chunk_y BETWEEN ? AND ?
  ORDER BY id LIMIT 1201
`).all(16, 22, 16, 22);
const queryMs = performance.now() - queryStartedAt;
const plan = database.prepare(`
  EXPLAIN QUERY PLAN SELECT id FROM locations
  WHERE is_active=1 AND chunk_x BETWEEN 16 AND 22 AND chunk_y BETWEEN 16 AND 22
  LIMIT 1201
`).all();

console.log(JSON.stringify({
  databasePath,
  generatedLocations: requestedCount,
  generationMs: Math.round(generatedMs),
  viewportRows: sample.length,
  viewportQueryMs: Number(queryMs.toFixed(2)),
  queryPlan: plan,
}, null, 2));
database.close();
