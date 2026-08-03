import { z } from "zod";
import type {
  ChatMessage,
  GameSnapshot,
  MapEditSessionState,
  MapHistoryState,
  MapLock,
  MapViewport,
  OnlinePlayer,
  PlayerSelf,
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

export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("sync"), requestId }),
  z.object({ type: z.literal("move"), requestId, locationId: id }),
  z.object({ type: z.literal("act"), requestId, actionId: id }),
  z.object({ type: z.literal("attributes.allocate"), requestId, allocations }),
  z.object({ type: z.literal("cultivation.breakthrough"), requestId }),
  z.object({ type: z.literal("chat.send"), requestId, content: z.string().min(1).max(240) }),
  z.object({ type: z.literal("ping"), requestId }),
  z.object({ type: z.literal("map.visited"), requestId }),
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
