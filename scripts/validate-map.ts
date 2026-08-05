import { openReadOnlyGameDatabase } from "../lib/game/database";
import { validateWorldMap } from "../lib/game/world-validation";

const db = openReadOnlyGameDatabase();
try {
  const report = validateWorldMap(db);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
} finally {
  db.close();
}
