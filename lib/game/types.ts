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
  fastTravelDestinationIds: string[];
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
  cashWenDelta?: number;
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

export type ActionRule = ActionTemplate & {
  isActive: boolean;
  seedRevision: number;
};

export type ActionRuleBinding = {
  id: string;
  locationId: string;
  actionId: string;
  actionName: string;
  facilityId: string | null;
  facilityType: string | null;
  priority: number;
};

export type ActionRuleSnapshot = { actions: ActionRule[]; layers: MapLayer[] };

export type ActionRuleLocationState = {
  location: Location;
  facilities: LocationFacility[];
  bindings: ActionRuleBinding[];
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
  name: string;
  playerId: string;
  actionTemplateId: string;
  targetPlayerId: string | null;
  targetLocationId: string | null;
  status: ActionJobStatus;
  queuePosition: number;
  durationSeconds: number;
  startedAt: string | null;
  completesAt: string | null;
  resultText: string | null;
};

export type AvailableAction = {
  id: string;
  bindingId: string;
  name: string;
  description: string;
  category: ActionCategory;
  targetKind: ActionTargetKind;
  durationSeconds: number;
  successChance: number;
  adult: boolean;
  visibility: ActionVisibility;
  available: boolean;
  unavailableReason: string | null;
  outcomeSummary: string;
};

export type ActionSystemState = {
  available: AvailableAction[];
  current: ActionJob | null;
  queued: ActionJob[];
  maxQueued: number;
  needs: PlayerNeeds;
  needPenalty: number;
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
  kind: "active" | "passive";
  level: number;
  experience: number;
  effectDurationSeconds: number;
  cooldownUntil: string | null;
  activeStartedAt: string | null;
  activeUntil: string | null;
  activeActionId: string | null;
  activeActionName: string | null;
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
  description: string;
  category: string;
  quantity: number;
  quality: number;
  durability: number;
  maxDurability: number;
  affixes: Array<Record<string, unknown>>;
  bound: boolean;
  equippedSlot: string | null;
  equipmentSlot: string | null;
  reservedQuantity: number;
  effects: Record<string, unknown>;
};

export type RecipeDefinition = {
  id: string;
  name: string;
  description: string;
  facilityType: string;
  skillId: string | null;
  durationSeconds: number;
  difficulty: number;
  inputs: Array<{ definitionId: string; name: string; quantity: number }>;
  outputs: Array<{ definitionId: string; name: string; quantity: number }>;
  available: boolean;
  unavailableReason: string | null;
};

export type FarmPlotState = {
  id: string;
  locationId: string;
  state: string;
  cropId: string | null;
  cropName: string | null;
  ownerPlayerId: string | null;
  maturesAt: string | null;
  mature: boolean;
  water: number;
  fertility: number;
  disease: number;
};

export type InventoryState = {
  items: ItemInstance[];
  recipes: RecipeDefinition[];
  farmPlots: FarmPlotState[];
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
  toPlayerName: string;
  status: string;
  payload: Record<string, unknown>;
  expiresAt: string;
};

export type AdultProfile = {
  status: "unknown" | "adult" | "minor";
  contentEnabled: boolean;
};

export type TradeOfferItem = {
  itemId: string;
  definitionId: string;
  name: string;
  quantity: number;
};

export type TradeOffer = { cashWen: number; items: TradeOfferItem[] };

export type TradeSession = {
  id: string;
  status: string;
  otherPlayerId: string;
  otherPlayerName: string;
  requestedBySelf: boolean;
  ownOffer: TradeOffer;
  otherOffer: TradeOffer;
  ownConfirmed: boolean;
  otherConfirmed: boolean;
  expiresAt: string;
};

export type SocialState = {
  adultProfile: AdultProfile;
  relationships: Relationship[];
  incomingRequests: InteractionRequest[];
  outgoingRequests: InteractionRequest[];
  trades: TradeSession[];
};

export type CombatState = {
  id: string;
  locationId: string;
  status: string;
  round: number;
  actingPlayerId: string | null;
  turnDeadline: string | null;
  selfTurn: boolean;
  opponentId: string;
  opponentName: string;
  opponentHp: number;
  opponentMaxHp: number;
  ownMissedTurns: number;
  opponentMissedTurns: number;
  recentTurns: CombatTurn[];
};

export type CombatTurn = {
  id: number;
  round: number;
  playerId: string;
  playerName: string;
  choice: string;
  resultText: string;
  createdAt: string;
};

export type LootPile = {
  id: string;
  locationId: string;
  cashWen: number;
  sourcePlayerId: string | null;
  sourcePlayerName: string | null;
  items: Array<{ name: string; quantity: number; quality: number }>;
};

export type ActionDefinition = {
  id: string;
  locationId: string;
  name: string;
  description: string;
  cashWenDelta: number;
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
  cashWen: number;
  currentLocation: string;
  attributes: BaseAttributes;
  derived: DerivedStats;
  cultivation: CultivationProgress;
  needs: PlayerNeeds;
  skills: PlayerSkill[];
  visionDepth: number;
  defeated: boolean;
  injuryUntil: string | null;
};

export type OnlinePlayer = { id: string; name: string; title: string; currentLocation: string };

export type ShopSummary = {
  id: string;
  name: string;
  category: string;
  isOpen: boolean;
};

export type ShopStockItem = {
  definitionId: string;
  name: string;
  description: string;
  category: string;
  quantity: number;
  buyPriceWen: number;
  sellPriceWen: number;
};

export type ShopState = ShopSummary & {
  locationId: string;
  opensMinute: number;
  closesMinute: number;
  tillWen: number;
  stock: ShopStockItem[];
};
export type WorldStatus = { timeZone: "Asia/Shanghai"; dateTime: string; announcement: string; onlineCount: number; serverTime: string };
export type WorldEvent = { id: number; playerId: string | null; eventType: string; content: string; createdAt: string };
export type PrivateEvent = { id: number; eventType: string; content: string; createdAt: string };
export type ChatMessage = { id: number; playerId: string; playerName: string; content: string; createdAt: string };

export type QinggongTarget = {
  locationId: string;
  locationName: string;
  direction: Direction;
  distance: number;
  available: boolean;
  cooldownUntil: string | null;
};

export type GameSnapshot = {
  self: PlayerSelf;
  world: WorldStatus;
  currentLayer: MapLayer;
  regions: MapRegion[];
  locations: Location[];
  routes: MapRoute[];
  transitions: MapTransition[];
  actions: ActionDefinition[];
  actionState: ActionSystemState;
  inventory: InventoryState;
  shop: ShopSummary | null;
  social: SocialState;
  combat: CombatState | null;
  lootPiles: LootPile[];
  qinggongTargets: QinggongTarget[];
  onlinePlayers: OnlinePlayer[];
  recentEvents: WorldEvent[];
  privateEvents: PrivateEvent[];
  chatMessages: ChatMessage[];
};

export type GameMutation = { self: PlayerSelf; event: WorldEvent; message: string };
export type SessionIdentity = { token: string; player: PlayerSelf };
