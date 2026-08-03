import { closeGameDatabase, getGameDatabase } from "../lib/game/database";
import { validateWorldMap } from "../lib/game/world-validation";

const report = validateWorldMap(getGameDatabase());
console.log(JSON.stringify(report, null, 2));
closeGameDatabase();
if (!report.ok) process.exitCode = 1;
