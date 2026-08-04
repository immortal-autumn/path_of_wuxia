import { z } from "zod";

const requestId = z.string().min(1).max(100);
const id = z.string().min(1).max(160);

export const npcTradeDecisionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("market.order.place"), contractId: id, side: z.enum(["buy", "sell"]),
    limitPriceWen: z.number().int().min(1).max(1_000_000_000), quantity: z.number().int().min(1).max(100_000),
  }),
  z.object({ type: z.literal("market.order.cancel"), orderId: id }),
  z.object({ type: z.literal("hold"), reason: z.enum(["clearing-debt", "no-market", "insufficient-assets"]) }),
]);

export const npcTradeClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ping"), requestId }),
  z.object({ type: z.literal("agent.trade.strategy.get"), requestId }),
  z.object({ type: z.literal("agent.trade.strategy.install"), requestId, strategy: z.unknown() }),
  z.object({ type: z.literal("agent.trade.context.create"), requestId, cycleKey: id }),
  z.object({ type: z.literal("agent.trade.decision.submit"), requestId, decisionId: id, output: npcTradeDecisionSchema }),
]);

export type NpcTradeClientMessage = z.infer<typeof npcTradeClientMessageSchema>;

export type NpcTradeServerMessage =
  | { type: "pong"; requestId: string }
  | { type: "agent.trade.strategy"; requestId: string; strategy: unknown; strategyHash: string; version: number }
  | {
      type: "agent.trade.context"; requestId: string; decisionId: string;
      strategy: unknown; strategyHash: string; input: unknown; rngSeed: string;
    }
  | { type: "agent.trade.decision.result"; requestId: string; decisionId: string; status: string; message: string }
  | { type: "error"; requestId?: string; message: string };
