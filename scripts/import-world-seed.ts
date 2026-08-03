import { closeGameDatabase, getGameDatabase } from "../lib/game/database";
import { importWorldSeed } from "../lib/game/world-seed";
import { validateWorldMap } from "../lib/game/world-validation";

const db = getGameDatabase();
const imported = importWorldSeed(db);
const validation = validateWorldMap(db);
console.log(JSON.stringify({ imported, validation }, null, 2));
closeGameDatabase();
if (!validation.ok) process.exitCode = 1;
