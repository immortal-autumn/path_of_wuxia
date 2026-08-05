import { rmSync } from "node:fs";

export default function globalTeardown() {
  const databasePath = process.env.PLAYWRIGHT_DATABASE_PATH;
  if (!databasePath) return;
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${databasePath}${suffix}`, { force: true });
}
