import { createHash } from "node:crypto";
import { openReadOnlyGameDatabase } from "../lib/game/database";
import {
  canonicalJson,
  decideNpcTrade,
  normalizeNpcTradeStrategy,
  npcTradeStrategyHash,
  type NpcTradeInput,
} from "../lib/game/npc-trade";

const argument = process.argv.find((value) => value.startsWith("--decision="));
const decisionId = argument?.slice("--decision=".length);
if (!decisionId) throw new Error("Usage: npm run npc:trade:replay -- --decision=<id>");

const db = openReadOnlyGameDatabase();
try {
  const row = db.prepare(`
    SELECT decision.strategy_hash,decision.input_snapshot_json,decision.input_snapshot_hash,
      decision.rng_seed,decision.output_json,decision.output_hash,strategy.strategy_json
    FROM npc_trade_decisions decision JOIN npc_trade_strategies strategy ON strategy.id=decision.strategy_id
    WHERE decision.id=?
  `).get(decisionId) as {
    strategy_hash: string; input_snapshot_json: string; input_snapshot_hash: string;
    rng_seed: string; output_json: string | null; output_hash: string | null; strategy_json: string;
  } | undefined;
  if (!row) throw new Error("Decision not found.");
  if (!row.output_json || !row.output_hash) throw new Error("Decision has no persisted output.");
  const strategy = normalizeNpcTradeStrategy(JSON.parse(row.strategy_json));
  const input = JSON.parse(row.input_snapshot_json) as NpcTradeInput;
  const inputHash = createHash("sha256").update(canonicalJson(input)).digest("hex");
  const replayed = decideNpcTrade(strategy, input, row.rng_seed);
  const replayedJson = canonicalJson(replayed);
  const replayedHash = createHash("sha256").update(replayedJson).digest("hex");
  const valid = npcTradeStrategyHash(strategy) === row.strategy_hash
    && inputHash === row.input_snapshot_hash
    && replayedJson === row.output_json
    && replayedHash === row.output_hash;
  console.log(JSON.stringify({ decisionId, storedOutputHash: row.output_hash, replayedOutputHash: replayedHash, valid }, null, 2));
  if (!valid) process.exitCode = 1;
} finally {
  db.close();
}
