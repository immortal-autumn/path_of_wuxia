import { z } from "zod";
import { actionCheckSchema, actionOutcomeSchema, actionRequirementSchema } from "./action-engine";
import { ACTION_CATEGORIES } from "./types";
import type {
  ActionSystemState,
  ChatMessage,
  GameSnapshot,
  ActionRuleLocationState,
  ActionRuleSnapshot,
  InventoryState,
  MapEditSessionState,
  MapHistoryState,
  MapLock,
  MapViewport,
  MarketSnapshot,
  NpcCommission,
  OnlinePlayer,
  PersonDetail,
  PlayerSelf,
  ShopState,
  TransitionKind,
  VisitedMap,
  WorldEvent,
  WorldStatus,
} from "./types";

const requestId = z.string().min(1).max(80);
const id = z.string().min(1).max(100);
const finiteNumber = z.number().finite();
const optionalVersion = z.number().int().positive().optional();
const transitionKind = z.enum(["door", "stairs", "elevator", "gate", "road", "ferry", "dungeon", "fast-travel", "portal"] satisfies readonly TransitionKind[]);

const layerSchema = z.object({
  id,
  name: z.string().min(1).max(80),
  description: z.string().min(1).max(400),
  parentLayerId: id.nullable(),
  version: z.number().int().positive().default(1),
});

const regionSchema = z.object({
  id,
  layerId: id,
  name: z.string().min(1).max(80),
  description: z.string().min(1).max(400),
  x: finiteNumber,
  y: finiteNumber,
  width: z.number().positive().max(100000),
  height: z.number().positive().max(100000),
  version: z.number().int().positive().default(1),
});

export const mapEditOperationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("layer.create"), layer: layerSchema }),
  z.object({
    type: z.literal("layer.update"), layerId: id, expectedVersion: optionalVersion,
    patch: z.object({
      name: z.string().min(1).max(80).optional(),
      description: z.string().min(1).max(400).optional(),
      parentLayerId: id.nullable().optional(),
    }),
  }),
  z.object({ type: z.literal("layer.delete"), layerId: id }),
  z.object({ type: z.literal("region.create"), region: regionSchema }),
  z.object({
    type: z.literal("region.update"), regionId: id, expectedVersion: optionalVersion,
    patch: z.object({
      name: z.string().min(1).max(80).optional(),
      description: z.string().min(1).max(400).optional(),
      x: finiteNumber.optional(), y: finiteNumber.optional(),
      width: z.number().positive().max(100000).optional(),
      height: z.number().positive().max(100000).optional(),
    }),
  }),
  z.object({ type: z.literal("region.delete"), regionId: id }),
  z.object({
    type: z.literal("location.create"),
    location: z.object({
      id: id.optional(), name: z.string().min(1).max(80), description: z.string().min(1).max(400),
      regionId: id.nullable(), layerId: id, gridX: z.number().int(), gridY: z.number().int(),
    }),
  }),
  z.object({
    type: z.literal("location.update"), locationId: id, expectedVersion: optionalVersion,
    patch: z.object({
      name: z.string().min(1).max(80).optional(),
      description: z.string().min(1).max(400).optional(),
      regionId: id.nullable().optional(), gridX: z.number().int().optional(), gridY: z.number().int().optional(),
    }),
  }),
  z.object({ type: z.literal("location.delete"), locationId: id }),
  z.object({
    type: z.literal("route.create"), routeId: id.optional(), fromLocation: id,
    toLocation: id, routeType: z.enum(["normal", "transition", "portal"]), transitionKind: transitionKind.optional(),
  }),
  z.object({ type: z.literal("route.delete"), routeId: id }),
]);

const allocations = z.object({
  strength: z.number().int().min(0).max(10000).default(0),
  agility: z.number().int().min(0).max(10000).default(0),
  constitution: z.number().int().min(0).max(10000).default(0),
  root: z.number().int().min(0).max(10000).default(0),
  comprehension: z.number().int().min(0).max(10000).default(0),
  spirit: z.number().int().min(0).max(10000).default(0),
});

const actionRuleInput = z.object({
  id: id.optional(),
  name: z.string().min(1).max(80),
  description: z.string().min(1).max(400),
  category: z.enum(ACTION_CATEGORIES),
  targetKind: z.enum(["self", "location", "player", "item", "plot"]),
  durationSeconds: z.number().int().min(0).max(100 * 365 * 24 * 60 * 60),
  requirements: actionRequirementSchema,
  check: actionCheckSchema,
  costs: actionOutcomeSchema,
  success: actionOutcomeSchema,
  failure: actionOutcomeSchema,
  resultTemplate: z.string().min(1).max(800),
  adult: z.boolean(),
  visibility: z.enum(["public", "participants", "private"]),
  cooldownSeconds: z.number().int().min(0).max(100 * 365 * 24 * 60 * 60),
});

export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("sync"), requestId }),
  z.object({ type: z.literal("move"), requestId, locationId: id }),
  z.object({ type: z.literal("act"), requestId, actionId: id }),
  z.object({ type: z.literal("action.start"), requestId, actionId: id }),
  z.object({ type: z.literal("qinggong.start"), requestId, destinationId: id }),
  z.object({ type: z.literal("skill.use"), requestId, skillId: id }),
  z.object({ type: z.literal("skill.stop"), requestId, skillId: id }),
  z.object({
    type: z.literal("profile.adult.update"), requestId,
    adultStatus: z.enum(["unknown", "adult", "minor"]), adultContentEnabled: z.boolean(),
  }),
  z.object({ type: z.literal("interaction.greet"), requestId, targetPlayerId: id }),
  z.object({
    type: z.literal("interaction.request"), requestId, targetPlayerId: id,
    requestType: z.enum(["relationship.friend", "relationship.sworn", "relationship.mentor", "relationship.lover", "relationship.spouse", "intimate", "duel"]),
    actionId: id.optional(),
  }),
  z.object({ type: z.literal("interaction.respond"), requestId, interactionRequestId: id, accept: z.boolean() }),
  z.object({ type: z.literal("relationship.end"), requestId, relationshipId: id }),
  z.object({ type: z.literal("player.block"), requestId, targetPlayerId: id, blocked: z.boolean() }),
  z.object({ type: z.literal("trade.request"), requestId, targetPlayerId: id }),
  z.object({ type: z.literal("trade.respond"), requestId, tradeId: id, accept: z.boolean() }),
  z.object({
    type: z.literal("trade.offer"), requestId, tradeId: id,
    cashWen: z.number().int().min(0).max(1_000_000_000_000),
    items: z.array(z.object({ itemId: id, quantity: z.number().int().min(1).max(1_000_000) })).max(16),
  }),
  z.object({ type: z.literal("trade.confirm"), requestId, tradeId: id }),
  z.object({ type: z.literal("trade.cancel"), requestId, tradeId: id }),
  z.object({ type: z.literal("combat.start"), requestId, targetPlayerId: id }),
  z.object({ type: z.literal("combat.choose"), requestId, combatId: id, choice: z.enum(["attack", "power", "defend", "flee"]) }),
  z.object({ type: z.literal("combat.respawn"), requestId }),
  z.object({ type: z.literal("loot.take"), requestId, lootPileId: id }),
  z.object({ type: z.literal("rules.actions.list"), requestId }),
  z.object({ type: z.literal("rules.location.inspect"), requestId, locationId: id }),
  z.object({ type: z.literal("rules.action.create"), requestId, action: actionRuleInput.extend({ id }) }),
  z.object({ type: z.literal("rules.action.update"), requestId, actionId: id, expectedVersion: z.number().int().min(1), action: actionRuleInput.omit({ id: true }) }),
  z.object({ type: z.literal("rules.action.delete"), requestId, actionId: id }),
  z.object({ type: z.literal("rules.binding.upsert"), requestId, locationId: id, actionId: id, facilityId: id.nullable(), priority: z.number().int().min(-1000).max(1000).default(0) }),
  z.object({ type: z.literal("rules.binding.delete"), requestId, bindingId: id }),
  z.object({ type: z.literal("action.cancel"), requestId, jobId: id }),
  z.object({ type: z.literal("action.queue.reorder"), requestId, jobIds: z.array(id).max(8) }),
  z.object({ type: z.literal("inventory.equip"), requestId, itemId: id }),
  z.object({ type: z.literal("inventory.unequip"), requestId, itemId: id }),
  z.object({ type: z.literal("inventory.use"), requestId, itemId: id }),
  z.object({ type: z.literal("shop.inspect"), requestId, shopId: id }),
  z.object({ type: z.literal("shop.buy"), requestId, shopId: id, definitionId: id, quantity: z.number().int().min(1).max(1_000_000) }),
  z.object({ type: z.literal("shop.sell"), requestId, shopId: id, itemId: id, quantity: z.number().int().min(1).max(1_000_000) }),
  z.object({ type: z.literal("market.snapshot"), requestId }),
  z.object({
    type: z.literal("market.order.place"), requestId, contractId: id,
    side: z.enum(["buy", "sell"]), limitPriceWen: z.number().int().min(1).max(1_000_000_000),
    quantity: z.number().int().min(1).max(100_000),
  }),
  z.object({ type: z.literal("market.order.cancel"), requestId, orderId: id }),
  z.object({ type: z.literal("person.inspect"), requestId, personId: id }),
  z.object({ type: z.literal("person.dialogue.choose"), requestId, personId: id, topicId: id }),
  z.object({ type: z.literal("commission.accept"), requestId, personId: id, templateId: id }),
  z.object({ type: z.literal("commission.complete"), requestId, commissionId: id }),
  z.object({ type: z.literal("commission.abandon"), requestId, commissionId: id }),
  z.object({ type: z.literal("law.surrender"), requestId }),
  z.object({ type: z.literal("craft.start"), requestId, recipeId: id }),
  z.object({
    type: z.literal("farm.start"), requestId, plotId: id,
    operation: z.enum(["plant", "water", "harvest"]), cropId: id.optional(),
  }),
  z.object({ type: z.literal("attributes.allocate"), requestId, allocations }),
  z.object({ type: z.literal("cultivation.breakthrough"), requestId }),
  z.object({ type: z.literal("chat.send"), requestId, content: z.string().min(1).max(240) }),
  z.object({ type: z.literal("ping"), requestId }),
  z.object({ type: z.literal("map.visited"), requestId }),
  z.object({ type: z.literal("travel.fast"), requestId, destinationId: id }),
  z.object({
    type: z.literal("map.viewport.subscribe"), requestId, layerId: id,
    centerChunkX: z.number().int(), centerChunkY: z.number().int(), radius: z.number().int().min(1).max(3), zoom: z.number().min(0.1).max(4),
  }),
  z.object({
    type: z.literal("map.locations.search"), requestId, layerId: id,
    query: z.string().max(80).default(""), limit: z.number().int().min(1).max(200).default(100),
  }),
  z.object({ type: z.literal("map.lock.acquire"), requestId, scopes: z.array(z.string().min(1).max(120)).min(1).max(16), sessionId: id.optional() }),
  z.object({ type: z.literal("map.lock.renew"), requestId, sessionId: id }),
  z.object({ type: z.literal("map.lock.release"), requestId, sessionId: id }),
  z.object({ type: z.literal("map.edit"), requestId, sessionId: id, operation: mapEditOperationSchema }),
  z.object({ type: z.literal("map.history.undo"), requestId, sessionId: id }),
  z.object({ type: z.literal("map.history.redo"), requestId, sessionId: id }),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;

export type ServerMessage =
  | { type: "snapshot"; snapshot: GameSnapshot }
  | { type: "ack"; requestId: string; message?: string }
  | { type: "self.updated"; player: PlayerSelf }
  | { type: "action.updated"; actionState: ActionSystemState }
  | { type: "inventory.updated"; inventory: InventoryState }
  | { type: "shop.snapshot"; requestId: string; shop: ShopState }
  | { type: "market.snapshot"; requestId: string; market: MarketSnapshot }
  | { type: "market.updated" }
  | { type: "person.snapshot"; requestId: string; person: PersonDetail }
  | { type: "person.dialogue.result"; requestId: string; person: PersonDetail; reply: string }
  | { type: "commissions.updated"; requestId?: string; commissions: NpcCommission[] }
  | { type: "social.updated"; social: GameSnapshot["social"] }
  | { type: "rules.actions.snapshot"; requestId: string; rules: ActionRuleSnapshot }
  | { type: "rules.location.snapshot"; requestId: string; state: ActionRuleLocationState }
  | { type: "rules.invalidated" }
  | { type: "cultivation.updated"; player: PlayerSelf; delta: number; offline: boolean; message: string }
  | { type: "players.updated"; players: OnlinePlayer[] }
  | { type: "world.event"; event: WorldEvent }
  | { type: "chat.message"; message: ChatMessage }
  | { type: "world.updated"; world: WorldStatus }
  | { type: "map.viewport.snapshot"; requestId: string; viewport: MapViewport; locks: MapLock[] }
  | { type: "map.visited.snapshot"; requestId: string; map: VisitedMap }
  | { type: "map.locations.result"; requestId: string; layerId: string; locations: MapViewport["locations"] }
  | { type: "map.edit.session"; requestId: string; session: MapEditSessionState }
  | { type: "map.history.state"; requestId: string; history: MapHistoryState }
  | { type: "map.chunks.invalidated"; chunkKeys: string[] }
  | { type: "map.locks.updated"; locks: MapLock[] }
  | { type: "error"; requestId?: string; message: string }
  | { type: "pong"; requestId: string };
