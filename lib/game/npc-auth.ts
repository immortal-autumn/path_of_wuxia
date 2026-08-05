import { createHash, createHmac, randomBytes } from "node:crypto";

const developmentSecrets = new Map<string, string>();

function secretFor(name: "NPC_RUNNER_SECRET" | "NPC_TRADE_RUNNER_SECRET") {
  const configured = process.env[name]?.trim();
  if (configured) return configured;
  if (process.env.NODE_ENV === "production") {
    throw new Error(`${name} 必须在生产环境启动前配置。`);
  }
  let secret = developmentSecrets.get(name);
  if (!secret) {
    secret = randomBytes(32).toString("base64url");
    developmentSecrets.set(name, secret);
  }
  return secret;
}

export function npcAgentToken(stableKey: string) {
  const secret = secretFor("NPC_RUNNER_SECRET");
  const signature = createHmac("sha256", secret).update(stableKey).digest("base64url");
  return `npc_${stableKey}_${signature}`;
}

export function npcTradeAgentToken(stableKey: string) {
  const secret = secretFor("NPC_TRADE_RUNNER_SECRET");
  const signature = createHmac("sha256", secret).update(stableKey).digest("base64url");
  return `npc_trade_${stableKey}_${signature}`;
}

export function agentTokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}
