import { createHash, createHmac } from "node:crypto";

const DEFAULT_NPC_RUNNER_SECRET = "path-of-wuxia-local-npc-runner";
const DEFAULT_NPC_TRADE_RUNNER_SECRET = "path-of-wuxia-local-npc-trade-runner";

export function npcAgentToken(stableKey: string) {
  const secret = process.env.NPC_RUNNER_SECRET ?? DEFAULT_NPC_RUNNER_SECRET;
  const signature = createHmac("sha256", secret).update(stableKey).digest("base64url");
  return `npc_${stableKey}_${signature}`;
}

export function npcTradeAgentToken(stableKey: string) {
  const secret = process.env.NPC_TRADE_RUNNER_SECRET ?? DEFAULT_NPC_TRADE_RUNNER_SECRET;
  const signature = createHmac("sha256", secret).update(stableKey).digest("base64url");
  return `npc_trade_${stableKey}_${signature}`;
}

export function agentTokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}
