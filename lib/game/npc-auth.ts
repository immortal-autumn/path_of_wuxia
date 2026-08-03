import { createHash, createHmac } from "node:crypto";

const DEFAULT_NPC_RUNNER_SECRET = "path-of-wuxia-local-npc-runner";

export function npcAgentToken(stableKey: string) {
  const secret = process.env.NPC_RUNNER_SECRET ?? DEFAULT_NPC_RUNNER_SECRET;
  const signature = createHmac("sha256", secret).update(stableKey).digest("base64url");
  return `npc_${stableKey}_${signature}`;
}

export function agentTokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}
