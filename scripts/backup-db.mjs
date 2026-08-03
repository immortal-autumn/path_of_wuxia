import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const sourcePath = resolve(process.env.DATABASE_PATH ?? "data/wuxia.db");
const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const destinationPath = resolve(process.argv[2] ?? `data/backups/wuxia-${stamp}.db`);
mkdirSync(dirname(destinationPath), { recursive: true });

if (existsSync(destinationPath)) {
  throw new Error(`Backup destination already exists: ${destinationPath}`);
}

const database = new DatabaseSync(sourcePath, { readOnly: true });
try {
  const escapedPath = destinationPath.replaceAll("'", "''");
  database.exec(`VACUUM INTO '${escapedPath}'`);
  console.log(`Database backed up to ${destinationPath}`);
} finally {
  database.close();
}
