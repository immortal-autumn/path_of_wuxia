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

export const ACTION_CATEGORIES = [
  "life", "perception", "movement", "cultivation", "production", "farming",
  "social", "intimate", "hostile", "combat", "legacy",
] as const;
export type ActionCategory = (typeof ACTION_CATEGORIES)[number];
export type ActionTargetKind = "self" | "location" | "player" | "item" | "plot";
export type ActionVisibility = "public" | "participants" | "private";
export type ActionJobStatus = "queued" | "running" | "paused" | "completed" | "cancelled" | "interrupted";
export type NeedKey = "satiety" | "hydration" | "hygiene" | "fatigue" | "bladder";

export type ActionRequirement = {
  facilityType?: string;
  minimumFacilityQuality?: number;
  attribute?: keyof BaseAttributes;
  minimumAttribute?: number;
  skillId?: string;
  minimumSkillLevel?: number;
  itemCosts?: Array<{ definitionId: string; quantity: number }>;
  relationshipTypes?: string[];
  sameLocation?: boolean;
  targetOnline?: boolean;
};

export type ActionCheck = {
  attribute?: keyof BaseAttributes;
  skillId?: string;
  difficulty?: number;
};

export type ActionOutcome = {
  silverDelta?: number;
  hpDelta?: number;
  cultivationDelta?: number;
  skillExperience?: number;
  needDeltas?: Partial<Record<NeedKey, number>>;
  items?: Array<{ definitionId: string; quantity: number; quality?: number; bound?: boolean }>;
  statusId?: string;
  statusDurationSeconds?: number;
};

export type ActionTemplate = {
  id: string;
  name: string;
  description: string;
  category: ActionCategory;
  targetKind: ActionTargetKind;
  durationSeconds: number;
  requirements: ActionRequirement;
  check: ActionCheck;
  costs: ActionOutcome;
  success: ActionOutcome;
  failure: ActionOutcome;
  resultTemplate: string;
  adult: boolean;
  visibility: ActionVisibility;
  cooldownSeconds: number;
  version: number;
};

export type LocationFacility = {
  id: string;
  locationId: string;
  facilityType: string;
  quality: number;
  capacity: number;
  config: Record<string, unknown>;
  version: number;
};

export type ActionJob = {
  id: string;
  playerId: string;
  actionTemplateId: string;
  targetPlayerId: string | null;
  targetLocationId: string | null;
  status: ActionJobStatus;
  queuePosition: number;
  startedAt: string | null;
  completesAt: string | null;
  resultText: string | null;
};

export type PlayerNeeds = {
  satiety: number;
  hydration: number;
  hygiene: number;
  fatigue: number;
  bladder: number;
  updatedAt: string;
};

export type PlayerSkill = {
  id: string;
  name: string;
  description: string;
  attributeKey: keyof BaseAttributes;
  category: string;
  level: number;
  experience: number;
};

export type ItemDefinition = {
  id: string;
  name: string;
  description: string;
  category: string;
  stackable: boolean;
  maxStack: number;
  baseValue: number;
  maxDurability: number;
  equipmentSlot: string | null;
  tags: string[];
  effects: Record<string, unknown>;
};

export type ItemInstance = {
  id: string;
  definitionId: string;
  name: string;
  quantity: number;
  quality: number;
  durability: number;
  maxDurability: number;
  affixes: Array<Record<string, unknown>>;
  bound: boolean;
  equippedSlot: string | null;
};

export type Relationship = {
  id: string;
  otherPlayerId: string;
  otherPlayerName: string;
  relationType: string;
  status: string;
  role: string | null;
  affinity: number;
  trust: number;
  intimacy: number;
  hostility: number;
};

export type InteractionRequest = {
  id: string;
  requestType: string;
  fromPlayerId: string;
  fromPlayerName: string;
  toPlayerId: string;
  status: string;
  expiresAt: string;
};

export type CombatState = {
  id: string;
  locationId: string;
  attackerId: string;
  defenderId: string;
  status: string;
  round: number;
  actingPlayerId: string | null;
  turnDeadline: string | null;
  winnerId: string | null;
  loserId: string | null;
};

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
