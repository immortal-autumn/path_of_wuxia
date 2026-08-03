export const DIRECTIONS = ["up", "up-right", "right", "down-right", "down", "down-left", "left", "up-left"] as const;
export type Direction = (typeof DIRECTIONS)[number];
export type RouteType = "normal" | "transition" | "portal";
export type TransitionKind = "door" | "stairs" | "elevator" | "gate" | "road" | "ferry" | "dungeon" | "fast-travel" | "portal";
export type LockScopeType = "region" | "chunk" | "layer";

export type MapLayer = {
  id: string;
  name: string;
  description: string;
  parentLayerId: string | null;
  version: number;
};

export type MapRegion = {
  id: string;
  layerId: string;
  name: string;
  description: string;
  x: number;
  y: number;
  width: number;
  height: number;
  version: number;
};

export type Location = {
  id: string;
  layerId: string;
  name: string;
  region: string;
  regionId: string | null;
  description: string;
  x: number;
  y: number;
  gridX: number;
  gridY: number;
  chunkX: number;
  chunkY: number;
  version: number;
  trainingMultiplier: number;
};

export type MapRoute = {
  id: string;
  fromLocation: string;
  toLocation: string;
  routeType: RouteType;
  transitionKind: TransitionKind | null;
  fromDirection: Direction | null;
  toDirection: Direction | null;
  version: number;
};

export type MapTransition = {
  routeId: string;
  destinationId: string;
  destinationName: string;
  destinationLayerId: string;
  routeType: "transition" | "portal";
  transitionKind: TransitionKind;
  label: string;
};

export type MapChunkSummary = { chunkX: number; chunkY: number; locationCount: number };

export type MapViewport = {
  layer: MapLayer;
  layers: MapLayer[];
  regions: MapRegion[];
  locations: Location[];
  remoteLocations: Location[];
  routes: MapRoute[];
  chunks: MapChunkSummary[];
  loadedChunkCount: number;
  truncated: boolean;
};

export type VisitedMap = {
  layers: MapLayer[];
  locations: Location[];
  routes: MapRoute[];
};

export type MapLock = { scopeKey: string; sessionId: string; playerId: string; playerName: string; leaseExpiresAt: string };
export type MapHistoryState = { canUndo: boolean; canRedo: boolean; operationCount: number };
export type MapEditSessionState = { id: string; scopes: string[]; leaseExpiresAt: string; history: MapHistoryState };

export type MapEditOperation =
  | { type: "layer.create"; layer: MapLayer }
  | { type: "layer.update"; layerId: string; patch: Partial<Pick<MapLayer, "name" | "description" | "parentLayerId">>; expectedVersion?: number }
  | { type: "layer.delete"; layerId: string }
  | { type: "region.create"; region: MapRegion }
  | { type: "region.update"; regionId: string; patch: Partial<Pick<MapRegion, "name" | "description" | "x" | "y" | "width" | "height">>; expectedVersion?: number }
  | { type: "region.delete"; regionId: string }
  | { type: "location.create"; location: Pick<Location, "name" | "description" | "regionId" | "layerId" | "gridX" | "gridY"> & { id?: string } }
  | { type: "location.update"; locationId: string; patch: Partial<Pick<Location, "name" | "description" | "regionId" | "gridX" | "gridY">>; expectedVersion?: number }
  | { type: "location.delete"; locationId: string }
  | { type: "route.create"; fromLocation: string; toLocation: string; routeType: RouteType; transitionKind?: TransitionKind; routeId?: string }
  | { type: "route.delete"; routeId: string };

export type ActionDefinition = {
  id: string;
  locationId: string;
  name: string;
  description: string;
  silverDelta: number;
  hpDelta: number;
};

export type BaseAttributes = {
  strength: number;
  agility: number;
  constitution: number;
  root: number;
  comprehension: number;
  spirit: number;
};

export type DerivedStats = {
  realmMultiplier: number;
  maxHp: number;
  maxEndurance: number;
  minAttack: number;
  maxAttack: number;
  defense: number;
  speed: number;
  hitRate: number;
  dodgeRate: number;
  criticalRate: number;
  criticalDamage: number;
  cultivationPerMinute: number;
};

export type CultivationProgress = {
  realmIndex: number;
  realmName: string;
  level: number;
  progress: number;
  nextLevelCost: number;
  unspentAttributePoints: number;
  training: boolean;
  trainingMultiplier: number;
  cultivationPerMinute: number;
  canBreakthrough: boolean;
  breakthroughChance: number;
  breakthroughCost: number;
  nextMinorAttributePoints: number;
  nextRealmAttributePoints: number;
};

export type PlayerSelf = {
  id: string;
  name: string;
  title: string;
  hp: number;
  maxHp: number;
  endurance: number;
  maxEndurance: number;
  silver: number;
  currentLocation: string;
  attributes: BaseAttributes;
  derived: DerivedStats;
  cultivation: CultivationProgress;
};

export type OnlinePlayer = { id: string; name: string; title: string; currentLocation: string };
export type WorldStatus = { timeZone: "Asia/Shanghai"; dateTime: string; announcement: string; onlineCount: number; serverTime: string };
export type WorldEvent = { id: number; playerId: string | null; eventType: string; content: string; createdAt: string };
export type ChatMessage = { id: number; playerId: string; playerName: string; content: string; createdAt: string };

export type GameSnapshot = {
  self: PlayerSelf;
  world: WorldStatus;
  currentLayer: MapLayer;
  regions: MapRegion[];
  locations: Location[];
  routes: MapRoute[];
  transitions: MapTransition[];
  actions: ActionDefinition[];
  onlinePlayers: OnlinePlayer[];
  recentEvents: WorldEvent[];
  chatMessages: ChatMessage[];
};

export type GameMutation = { self: PlayerSelf; event: WorldEvent; message: string };
export type SessionIdentity = { token: string; player: PlayerSelf };
