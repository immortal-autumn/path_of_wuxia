"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import Link from "next/link";
import type { ClientMessage, ServerMessage } from "@/lib/game/protocol";
import type {
  ActionJob,
  BaseAttributes,
  GameSnapshot,
  Location,
  MapTransition,
  VisitedMap,
} from "@/lib/game/types";
import { DIRECTION_LABEL } from "@/lib/game/map";
import { createClientId } from "@/lib/game/client-id";
import { conciseLocationName } from "@/lib/game/location-label";

type ConnectionState = "connecting" | "online" | "reconnecting" | "offline";
type Drawer = "world" | "actions" | "character" | "chat" | null;
type CommandWithoutId = ClientMessage extends infer Message
  ? Message extends { requestId: string }
    ? Omit<Message, "requestId">
    : never
  : never;

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  connecting: "入世中",
  online: "江湖在线",
  reconnecting: "重连中",
  offline: "暂离江湖",
};

function formatClock(iso: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

function ChinaClock({ serverTime }: { serverTime: string }) {
  const [now, setNow] = useState(() => new Date(serverTime));

  useEffect(() => {
    const timer = setInterval(() => setNow((value) => new Date(value.getTime() + 1000)), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <strong className="china-clock">
      {new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      }).format(now).replaceAll("/", "-")}
    </strong>
  );
}

function durationText(seconds: number) {
  if (seconds < 60) return `${seconds}秒`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}分钟`;
  if (seconds < 86400) return `${Number((seconds / 3600).toFixed(seconds % 3600 === 0 ? 0 : 1))}小时`;
  return `${Number((seconds / 86400).toFixed(seconds % 86400 === 0 ? 0 : 1))}天`;
}

function remainingText(job: ActionJob, now: number) {
  if (!job.completesAt) return "等待开始";
  const seconds = Math.max(0, Math.ceil((new Date(job.completesAt).getTime() - now) / 1000));
  return seconds === 0 ? "正在结算" : `剩余 ${durationText(seconds)}`;
}

function StatBar({ label, value, max, tone }: { label: string; value: number; max: number; tone: string }) {
  const percentage = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className="stat-row">
      <div className="stat-label">
        <span>{label}</span>
        <span>{value} / {max}</span>
      </div>
      <div className="stat-track" aria-label={`${label} ${value}/${max}`}>
        <span className={`stat-fill ${tone}`} style={{ width: `${percentage}%` }} />
      </div>
    </div>
  );
}

function WorldPanel({ world, recentEvents: events, open }: Pick<GameSnapshot, "world" | "recentEvents"> & { open: boolean }) {
  return (
    <section className={`world-panel paper-panel mobile-drawer ${open ? "drawer-open" : ""}`} aria-label="世界状态">
      <div className="world-main">
        <div className="seal" aria-hidden="true">世界</div>
        <div>
          <p className="eyebrow">共享世界</p>
          <h1>八方世界地图</h1>
        </div>
        <div className="world-facts">
          <span>中国标准时间</span>
          <ChinaClock key={world.serverTime} serverTime={world.serverTime} />
          <span className="online-count"><i /> {world.onlineCount} 位侠客在线</span>
        </div>
        <Link className="map-editor-link" href="/map-editor">地图设计</Link>
      </div>
      <div className="world-news">
        <p className="announcement">{world.announcement}</p>
        <div className="event-ticker" aria-live="polite">
          {events.slice(0, 3).map((event) => (
            <span key={event.id}>{event.content}</span>
          ))}
        </div>
      </div>
    </section>
  );
}

function MapPanel({
  locations,
  routes,
  self,
  onlinePlayers,
  pending,
  onMove,
  onOpenVisitedMap,
  visitedMapLoading,
  currentLayer,
}: Pick<GameSnapshot, "locations" | "routes" | "self" | "onlinePlayers" | "currentLayer"> & {
  pending: boolean;
  onMove: (locationId: string) => void;
  onOpenVisitedMap: () => void;
  visitedMapLoading: boolean;
}) {
  const [inspectedLocationId, setInspectedLocationId] = useState<string | null>(null);
  const locationMap = useMemo(() => new Map(locations.map((location) => [location.id, location])), [locations]);
  const routeGraph = useMemo(() => {
    const graph = new Map<string, Array<{
      route: (typeof routes)[number];
      neighborId: string;
      direction: (typeof routes)[number]["fromDirection"];
    }>>();
    for (const route of routes) {
      const fromEdges = graph.get(route.fromLocation) ?? [];
      fromEdges.push({ route, neighborId: route.toLocation, direction: route.fromDirection });
      graph.set(route.fromLocation, fromEdges);
      const toEdges = graph.get(route.toLocation) ?? [];
      toEdges.push({ route, neighborId: route.fromLocation, direction: route.toDirection });
      graph.set(route.toLocation, toEdges);
    }
    return graph;
  }, [routes]);
  const distances = useMemo(() => {
    const result = new Map<string, number>([[self.currentLocation, 0]]);
    const queue = [self.currentLocation];

    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const locationId = queue[cursor];
      const distance = result.get(locationId) ?? 0;
      if (distance >= 3) continue;

      for (const edge of routeGraph.get(locationId) ?? []) {
        if (!result.has(edge.neighborId)) {
          result.set(edge.neighborId, distance + 1);
          queue.push(edge.neighborId);
        }
      }
    }

    return result;
  }, [routeGraph, self.currentLocation]);
  const currentEdges = useMemo(() => routeGraph.get(self.currentLocation) ?? [], [routeGraph, self.currentLocation]);
  const adjacent = useMemo(() => new Set(currentEdges.map((edge) => edge.neighborId)), [currentEdges]);
  const moveOptions = useMemo(() => currentEdges.flatMap((edge) => {
    const location = locationMap.get(edge.neighborId);
    if (!location) return [];
    return [{
      routeId: edge.route.id,
      location,
      directionLabel: edge.route.routeType === "portal"
        ? "传送门"
        : edge.direction
          ? DIRECTION_LABEL[edge.direction]
          : "路线",
    }];
  }), [currentEdges, locationMap]);
  const visibleLocations = useMemo(
    () => locations.filter((location) => distances.has(location.id)),
    [distances, locations],
  );
  const visibleLocationIds = useMemo(
    () => new Set(visibleLocations.map((location) => location.id)),
    [visibleLocations],
  );
  const visibleRoutes = useMemo(
    () => routes.filter(
      (route) => visibleLocationIds.has(route.fromLocation) && visibleLocationIds.has(route.toLocation),
    ),
    [routes, visibleLocationIds],
  );
  const currentLocation = locationMap.get(self.currentLocation);
  const inspectedLocation = inspectedLocationId ? locationMap.get(inspectedLocationId) : null;
  const nearbyPlayers = onlinePlayers.filter((player) => visibleLocationIds.has(player.currentLocation));

  const viewBox = useMemo(() => {
    if (visibleLocations.length === 0) return "-260 -160 520 320";
    const minX = Math.min(...visibleLocations.map((location) => location.x)) - 90;
    const minY = Math.min(...visibleLocations.map((location) => location.y)) - 90;
    const maxX = Math.max(...visibleLocations.map((location) => location.x)) + 90;
    const maxY = Math.max(...visibleLocations.map((location) => location.y)) + 90;
    const contentWidth = maxX - minX;
    const contentHeight = maxY - minY;
    const width = Math.max(520, contentWidth);
    const height = Math.max(320, contentHeight);
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    return `${centerX - width / 2} ${centerY - height / 2} ${width} ${height}`;
  }, [visibleLocations]);

  const activateLocation = (location: Location) => {
    if (adjacent.has(location.id) && !pending) onMove(location.id);
  };

  const handleKey = (event: KeyboardEvent<SVGGElement>, location: Location) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activateLocation(location);
    }
  };

  return (
    <section className="map-panel" aria-label="世界地图">
      <header className="map-title">
        <div>
          <p className="eyebrow">八方向移动</p>
          <h2>{currentLayer.name} · 局部地图</h2>
        </div>
        <div className="map-title-actions">
          <p>地图仅显示地点名称；可直接点击实线长方框移动。</p>
          <button type="button" onClick={onOpenVisitedMap} disabled={visitedMapLoading}>
            {visitedMapLoading ? "读取足迹…" : "足迹地图"}
          </button>
        </div>
      </header>
      <dl className="map-status" aria-label="地图信息">
        <div><dt>当前位置</dt><dd>{currentLocation ? `${currentLocation.name} · (${currentLocation.gridX}, ${currentLocation.gridY})` : "未知之地"}</dd></div>
        <div><dt>指向地点</dt><dd>{inspectedLocation ? `${inspectedLocation.name} · (${inspectedLocation.gridX}, ${inspectedLocation.gridY})` : "悬停或聚焦查看全名"}</dd></div>
        <div><dt>所属区域</dt><dd>{currentLocation?.region ?? "无名区域"}</dd></div>
        <div><dt>三步视野</dt><dd>{visibleLocations.length} 处 · {nearbyPlayers.length} 人</dd></div>
      </dl>
      <div className="map-stage">
        <svg className="wuxia-map" viewBox={viewBox} role="img" aria-label="当前位置三步内的八方向地图">
          {visibleRoutes.map((route) => {
            const from = locationMap.get(route.fromLocation);
            const to = locationMap.get(route.toLocation);
            if (!from || !to) return null;
            return (
              <line
                key={`${route.fromLocation}-${route.toLocation}`}
                className={`map-route ${route.routeType}`}
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
              >
                <title>{route.routeType === "portal" ? "传送门" : route.fromDirection ? DIRECTION_LABEL[route.fromDirection] : "路线"}</title>
              </line>
            );
          })}
          {visibleLocations.map((location) => {
            const current = location.id === self.currentLocation;
            const reachable = adjacent.has(location.id);
            const canMove = reachable && !pending;
            const distance = distances.get(location.id) ?? 0;
            return (
              <g
                key={location.id}
                className={`map-node distance-${distance} ${current ? "current" : ""} ${reachable ? "reachable" : ""}`}
                data-distance={distance}
                data-location-id={location.id}
                transform={`translate(${location.x} ${location.y})`}
                role="button"
                tabIndex={canMove ? 0 : -1}
                aria-label={`${location.name}，网格 (${location.gridX}, ${location.gridY})${current ? "，当前位置" : reachable ? "，可前往" : ""}`}
                aria-disabled={!canMove}
                onClick={() => activateLocation(location)}
                onKeyDown={(event) => handleKey(event, location)}
                onMouseEnter={() => setInspectedLocationId(location.id)}
                onMouseLeave={() => setInspectedLocationId(null)}
                onFocus={() => setInspectedLocationId(location.id)}
                onBlur={() => setInspectedLocationId(null)}
              >
                <rect className="node-box" x="-60" y="-36" width="120" height="72" />
                <foreignObject x="-56" y="-32" width="112" height="64" pointerEvents="none">
                  <div className="node-name">{conciseLocationName(location.name)}</div>
                </foreignObject>
              </g>
            );
          })}
        </svg>
      </div>
      <footer className="map-footer">
        <div className="map-move-controls" aria-label="下一步可前往地点">
          <strong>下一步</strong>
          {moveOptions.map((option) => (
            <button
              key={option.routeId}
              disabled={pending}
              aria-label={`${option.directionLabel}，前往${option.location.name}`}
              onClick={() => onMove(option.location.id)}
            >
              <span>{option.directionLabel}</span> · {option.location.name}
            </button>
          ))}
        </div>
        <div className="map-legend" aria-label="地图图例">
          <span><i className="legend-current" />当前位置</span>
          <span><i className="legend-next" />下一步</span>
          <span><i className="legend-later" />二至三步</span>
        </div>
      </footer>
    </section>
  );
}

function VisitedMapDialog({
  map,
  loading,
  layerId,
  currentLocationId,
  onLayerChange,
  onClose,
}: {
  map: VisitedMap | null;
  loading: boolean;
  layerId: string;
  currentLocationId: string;
  onLayerChange: (layerId: string) => void;
  onClose: () => void;
}) {
  const [inspectedLocationId, setInspectedLocationId] = useState<string | null>(null);
  const locations = useMemo(
    () => map?.locations.filter((location) => location.layerId === layerId) ?? [],
    [layerId, map],
  );
  const locationMap = useMemo(() => new Map(locations.map((location) => [location.id, location])), [locations]);
  const routes = useMemo(
    () => map?.routes.filter((route) => locationMap.has(route.fromLocation) && locationMap.has(route.toLocation)) ?? [],
    [locationMap, map],
  );
  const layer = map?.layers.find((item) => item.id === layerId) ?? null;
  const inspectedLocation = inspectedLocationId ? locationMap.get(inspectedLocationId) ?? null : null;
  const viewBox = useMemo(() => {
    if (locations.length === 0) return "-260 -160 520 320";
    const minX = Math.min(...locations.map((location) => location.x)) - 90;
    const minY = Math.min(...locations.map((location) => location.y)) - 90;
    const maxX = Math.max(...locations.map((location) => location.x)) + 90;
    const maxY = Math.max(...locations.map((location) => location.y)) + 90;
    const width = Math.max(520, maxX - minX);
    const height = Math.max(320, maxY - minY);
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    return `${centerX - width / 2} ${centerY - height / 2} ${width} ${height}`;
  }, [locations]);

  useEffect(() => {
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return (
    <div className="visited-map-backdrop">
      <section
        className="visited-map-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="足迹地图"
        data-visited-locations={map?.locations.length ?? 0}
      >
        <header>
          <div>
            <p className="eyebrow">只显示亲自到达过的地点</p>
            <h2>足迹地图</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭足迹地图">关闭</button>
        </header>
        {loading && <div className="visited-map-empty" role="status">正在整理足迹……</div>}
        {!loading && (!map || map.locations.length === 0) && <div className="visited-map-empty">尚未留下任何足迹。</div>}
        {!loading && map && map.locations.length > 0 && (
          <>
            <div className="visited-map-toolbar" aria-label="足迹地图信息">
              <label>地图
                <select aria-label="选择足迹地图" value={layerId} onChange={(event) => onLayerChange(event.target.value)}>
                  {map.layers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
              </label>
              <span>全部足迹 <strong>{map.locations.length}</strong> 处</span>
              <span>本图 <strong>{locations.length}</strong> 处</span>
              <span className="visited-map-inspection">
                {inspectedLocation
                  ? `${inspectedLocation.name} · ${inspectedLocation.region} · (${inspectedLocation.gridX}, ${inspectedLocation.gridY})`
                  : "点击地点查看完整名称与坐标"}
              </span>
            </div>
            <div className="visited-map-stage">
              <svg viewBox={viewBox} role="img" aria-label={`${layer?.name ?? "当前地图"}的已探索全图`}>
                {routes.map((route) => {
                  const from = locationMap.get(route.fromLocation);
                  const to = locationMap.get(route.toLocation);
                  if (!from || !to) return null;
                  return <line key={route.id} className="visited-map-route" x1={from.x} y1={from.y} x2={to.x} y2={to.y} />;
                })}
                {locations.map((location) => {
                  const current = location.id === currentLocationId;
                  return (
                    <g
                      key={location.id}
                      className={`visited-map-location ${current ? "current" : ""}`}
                      data-location-id={location.id}
                      transform={`translate(${location.x} ${location.y})`}
                      role="button"
                      tabIndex={0}
                      aria-label={`${location.name}，网格 (${location.gridX}, ${location.gridY})${current ? "，当前位置" : ""}`}
                      onClick={() => setInspectedLocationId(location.id)}
                      onFocus={() => setInspectedLocationId(location.id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setInspectedLocationId(location.id);
                        }
                      }}
                    >
                      <rect x="-60" y="-36" width="120" height="72" />
                      <foreignObject x="-56" y="-32" width="112" height="64" pointerEvents="none">
                        <div>{conciseLocationName(location.name)}</div>
                      </foreignObject>
                    </g>
                  );
                })}
              </svg>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function ActionsPanel({
  actionState,
  transitions,
  self,
  locations,
  pending,
  open,
  onStart,
  onCancel,
  onReorder,
  onTransition,
}: Pick<GameSnapshot, "actionState" | "transitions" | "self" | "locations"> & {
  pending: boolean;
  open: boolean;
  onStart: (actionId: string) => void;
  onCancel: (jobId: string) => void;
  onReorder: (jobIds: string[]) => void;
  onTransition: (locationId: string) => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const currentLocation = locations.find((location) => location.id === self.currentLocation);
  const categoryLabel: Record<string, string> = {
    life: "生活", perception: "感知", movement: "身法", cultivation: "修炼", production: "生产",
    farming: "农耕", social: "交往", intimate: "亲密", hostile: "敌对", combat: "战斗", legacy: "原有",
  };
  const moveQueued = (index: number, offset: number) => {
    const next = [...actionState.queued];
    const target = index + offset;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    onReorder(next.map((job) => job.id));
  };
  return (
    <section className={`actions-panel paper-panel mobile-drawer ${open ? "drawer-open" : ""}`} aria-label="行动">
      <div className="section-heading">
        <div>
          <p className="eyebrow">此地可为</p>
          <h2>{currentLocation?.name ?? "未知之地"}</h2>
        </div>
        <p>{currentLocation?.description}</p>
      </div>
      <div className="action-workspace">
        <div className="action-list" aria-label="此地可做">
          {actionState.available.map((action) => (
            <button
              className="action-card"
              key={action.id}
              disabled={pending || !action.available || actionState.queued.length >= actionState.maxQueued}
              onClick={() => onStart(action.id)}
              title={action.unavailableReason ?? undefined}
            >
              <span className="action-mark">{categoryLabel[action.category]?.slice(0, 1) ?? "行"}</span>
              <span>
                <strong>{action.name}</strong>
                <small>{action.description}</small>
              </span>
              <em>{categoryLabel[action.category] ?? action.category} · {durationText(action.durationSeconds)} · 成功率 {action.successChance}%</em>
              <em>{action.unavailableReason ?? action.outcomeSummary}</em>
            </button>
          ))}
          {transitions.map((transition: MapTransition) => (
            <button
              className="action-card transition-action"
              key={transition.routeId}
              disabled={pending || actionState.current !== null}
              onClick={() => onTransition(transition.destinationId)}
            >
              <span className="action-mark">门</span>
              <span><strong>{transition.label}</strong><small>跨地图层通道</small></span>
            </button>
          ))}
        </div>
        <aside className="action-queue" aria-label="行动队列">
          <div className="queue-heading"><strong>行动队列</strong><span>{actionState.queued.length} / {actionState.maxQueued}</span></div>
          {actionState.current ? (
            <div className="queue-job current-job">
              <span><strong>{actionState.current.name}</strong><small>{remainingText(actionState.current, now)}</small></span>
              <button aria-label={`取消${actionState.current.name}`} disabled={pending} onClick={() => onCancel(actionState.current!.id)}>取消</button>
            </div>
          ) : <p className="empty-queue">当前没有进行中的行动</p>}
          {actionState.queued.map((job, index) => (
            <div className="queue-job" key={job.id}>
              <span><strong>{index + 1}. {job.name}</strong><small>等待前项完成</small></span>
              <span className="queue-controls">
                <button aria-label={`提前${job.name}`} disabled={pending || index === 0} onClick={() => moveQueued(index, -1)}>↑</button>
                <button aria-label={`延后${job.name}`} disabled={pending || index === actionState.queued.length - 1} onClick={() => moveQueued(index, 1)}>↓</button>
                <button aria-label={`取消${job.name}`} disabled={pending} onClick={() => onCancel(job.id)}>×</button>
              </span>
            </div>
          ))}
          <div className="needs-summary" aria-label="生活需求">
            <span>饱食 {Math.round(actionState.needs.satiety)}</span>
            <span>饮水 {Math.round(actionState.needs.hydration)}</span>
            <span>卫生 {Math.round(actionState.needs.hygiene)}</span>
            <span>疲劳 {Math.round(actionState.needs.fatigue)}</span>
            <span>如厕 {Math.round(actionState.needs.bladder)}</span>
            <strong>检定修正 -{actionState.needPenalty}%</strong>
          </div>
        </aside>
      </div>
    </section>
  );
}

const ATTRIBUTE_LABELS: Array<[keyof BaseAttributes, string]> = [
  ["strength", "力量"], ["agility", "敏捷"], ["constitution", "体质"],
  ["root", "根骨"], ["comprehension", "悟性"], ["spirit", "精神"],
];

function CharacterPanel({
  self,
  location,
  open,
  pending,
  onAllocate,
  onBreakthrough,
}: {
  self: GameSnapshot["self"];
  location?: Location;
  open: boolean;
  pending: boolean;
  onAllocate: (allocations: BaseAttributes) => void;
  onBreakthrough: () => void;
}) {
  const [tab, setTab] = useState<"base" | "combat" | "cultivation">("base");
  const [draft, setDraft] = useState<BaseAttributes>({ strength: 0, agility: 0, constitution: 0, root: 0, comprehension: 0, spirit: 0 });
  const allocated = Object.values(draft).reduce((sum, value) => sum + value, 0);
  const progress = Math.min(100, (self.cultivation.progress / Math.max(1, self.cultivation.nextLevelCost)) * 100);

  return (
    <section className={`character-panel side-section mobile-drawer ${open ? "drawer-open" : ""}`} aria-label="角色状态">
      <div className="character-heading">
        <div className="avatar" aria-hidden="true">侠</div>
        <div>
          <p className="eyebrow">{self.title}</p>
          <h2>{self.name}</h2>
          <span>{location?.name} · {location?.region}</span>
        </div>
      </div>
      <div className="stats">
        <StatBar label="气血" value={self.hp} max={self.maxHp} tone="hp" />
        <StatBar label="耐力" value={self.endurance} max={self.maxEndurance} tone="stamina" />
      </div>
      <div className="character-tabs" role="tablist" aria-label="人物属性">
        <button className={tab === "base" ? "active" : ""} onClick={() => setTab("base")}>基础属性</button>
        <button className={tab === "combat" ? "active" : ""} onClick={() => setTab("combat")}>战斗属性</button>
        <button className={tab === "cultivation" ? "active" : ""} onClick={() => setTab("cultivation")}>修炼突破</button>
      </div>
      {tab === "base" && (
        <div className="attribute-panel">
          <p>可分配：{self.cultivation.unspentAttributePoints} 点</p>
          {ATTRIBUTE_LABELS.map(([key, label]) => (
            <div className="attribute-row" key={key}>
              <span>{label}</span><strong>{self.attributes[key]}{draft[key] ? ` + ${draft[key]}` : ""}</strong>
              <button disabled={pending || allocated >= self.cultivation.unspentAttributePoints} onClick={() => setDraft((current) => ({ ...current, [key]: current[key] + 1 }))}>+</button>
              <button disabled={pending || draft[key] <= 0} onClick={() => setDraft((current) => ({ ...current, [key]: current[key] - 1 }))}>−</button>
            </div>
          ))}
          <button disabled={pending || allocated <= 0} onClick={() => {
            onAllocate(draft);
            setDraft({ strength: 0, agility: 0, constitution: 0, root: 0, comprehension: 0, spirit: 0 });
          }}>确认分配 {allocated || ""}</button>
        </div>
      )}
      {tab === "combat" && (
        <div className="derived-grid">
          <span>最小攻击<strong>{self.derived.minAttack}</strong></span><span>最大攻击<strong>{self.derived.maxAttack}</strong></span>
          <span>防御<strong>{self.derived.defense}</strong></span><span>速度<strong>{self.derived.speed}</strong></span>
          <span>命中<strong>{self.derived.hitRate}%</strong></span><span>闪避<strong>{self.derived.dodgeRate}%</strong></span>
          <span>暴击<strong>{self.derived.criticalRate}%</strong></span><span>暴伤<strong>{self.derived.criticalDamage}%</strong></span>
          <small>境界倍率 ×{self.derived.realmMultiplier.toFixed(2)} · 所有结果由服务器公式计算</small>
        </div>
      )}
      {tab === "cultivation" && (
        <div className="cultivation-panel">
          <h3>{self.cultivation.realmName} · 第 {self.cultivation.level} 级</h3>
          <div className="cultivation-track"><span style={{ width: `${progress}%` }} /></div>
          <p>{self.cultivation.progress} / {self.cultivation.nextLevelCost} 修为</p>
          <p>{self.cultivation.training ? `修炼中 · 每分钟 ${self.cultivation.cultivationPerMinute}` : "未在修炼房"}</p>
          <p>下一级 +{self.cultivation.nextMinorAttributePoints} 属性点</p>
          {self.cultivation.realmIndex < 12 && <p>突破成功率 {self.cultivation.breakthroughChance}% · 失败扣 {self.cultivation.breakthroughCost} · 新境界 +{self.cultivation.nextRealmAttributePoints} 点</p>}
          <button disabled={pending || !self.cultivation.canBreakthrough} onClick={onBreakthrough}>尝试突破</button>
        </div>
      )}
      <div className="character-numbers"><div><span>银两</span><strong>{self.silver}</strong><small>枚</small></div></div>
    </section>
  );
}

function ChatPanel({
  messages,
  selfId,
  connected,
  open,
  onSend,
}: {
  messages: GameSnapshot["chatMessages"];
  selfId: string;
  connected: boolean;
  open: boolean;
  onSend: (content: string) => boolean;
}) {
  const [content, setContent] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);

  useEffect(() => {
    if (followRef.current && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, open]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (onSend(content)) setContent("");
  };

  return (
    <section className={`chat-panel side-section mobile-drawer ${open ? "drawer-open" : ""}`} aria-label="世界聊天">
      <div className="chat-heading">
        <div>
          <p className="eyebrow">同道传音</p>
          <h2>世界聊天</h2>
        </div>
        <span>{connected ? "传音畅通" : "传音中断"}</span>
      </div>
      <div
        className="chat-list"
        ref={listRef}
        onScroll={(event) => {
          const element = event.currentTarget;
          followRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 72;
        }}
        aria-live="polite"
      >
        {messages.length === 0 && <p className="empty-chat">四下寂静，不妨先向诸位问好。</p>}
        {messages.map((message) => (
          <article className={message.playerId === selfId ? "own-message" : ""} key={message.id}>
            <header>
              <strong>{message.playerName}</strong>
              <time dateTime={message.createdAt}>{formatClock(message.createdAt)}</time>
            </header>
            <p>{message.content}</p>
          </article>
        ))}
      </div>
      <form className="chat-form" onSubmit={submit}>
        <label className="sr-only" htmlFor="chat-message">输入聊天消息</label>
        <input
          id="chat-message"
          value={content}
          onChange={(event) => setContent(event.target.value)}
          maxLength={120}
          placeholder={connected ? "与诸位侠客说些什么……" : "正在重连江湖……"}
          disabled={!connected}
        />
        <button disabled={!connected || content.trim().length === 0}>传音</button>
      </form>
    </section>
  );
}

export default function GameShell({ initialSnapshot }: { initialSnapshot: GameSnapshot }) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [drawer, setDrawer] = useState<Drawer>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [visitedMapOpen, setVisitedMapOpen] = useState(false);
  const [visitedMapLoading, setVisitedMapLoading] = useState(false);
  const [visitedMap, setVisitedMap] = useState<VisitedMap | null>(null);
  const [visitedLayerId, setVisitedLayerId] = useState("");
  const socketRef = useRef<WebSocket | null>(null);
  const pendingRequestRef = useRef<string | null>(null);
  const visitedMapRequestRef = useRef<string | null>(null);
  const visitedLayerPreferenceRef = useRef<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;

    const connect = () => {
      if (disposed) return;
      setConnection(attempts === 0 ? "connecting" : "reconnecting");
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
      socketRef.current = socket;

      socket.addEventListener("open", () => {
        attempts = 0;
        setConnection("online");
      });

      socket.addEventListener("message", (event) => {
        let message: ServerMessage;
        try {
          message = JSON.parse(event.data) as ServerMessage;
        } catch {
          return;
        }

        if (message.type === "snapshot") setSnapshot(message.snapshot);
        if (message.type === "self.updated") {
          setSnapshot((current) => ({ ...current, self: message.player }));
        }
        if (message.type === "action.updated") {
          setSnapshot((current) => ({ ...current, actionState: message.actionState }));
        }
        if (message.type === "map.visited.snapshot" && message.requestId === visitedMapRequestRef.current) {
          const preferredLayerId = visitedLayerPreferenceRef.current;
          setVisitedMap(message.map);
          setVisitedLayerId(message.map.layers.some((layer) => layer.id === preferredLayerId)
            ? preferredLayerId!
            : message.map.layers[0]?.id ?? "");
          visitedMapRequestRef.current = null;
          setVisitedMapLoading(false);
        }
        if (message.type === "cultivation.updated") {
          setSnapshot((current) => ({ ...current, self: message.player }));
          setNotice(message.message);
        }
        if (message.type === "players.updated") {
          setSnapshot((current) => ({ ...current, onlinePlayers: message.players }));
        }
        if (message.type === "world.updated") {
          setSnapshot((current) => ({ ...current, world: message.world }));
        }
        if (message.type === "world.event") {
          setSnapshot((current) => ({
            ...current,
            recentEvents: [message.event, ...current.recentEvents.filter((item) => item.id !== message.event.id)].slice(0, 12),
          }));
        }
        if (message.type === "chat.message") {
          setSnapshot((current) => ({
            ...current,
            chatMessages: [...current.chatMessages.filter((item) => item.id !== message.message.id), message.message].slice(-50),
          }));
        }
        if (message.type === "map.chunks.invalidated") {
          socket.send(JSON.stringify({ type: "sync", requestId: createClientId() }));
        }
        if (message.type === "ack") {
          if (message.requestId === pendingRequestRef.current) {
            pendingRequestRef.current = null;
            setPending(null);
          }
          if (message.message) setNotice(message.message);
        }
        if (message.type === "error") {
          if (message.requestId === visitedMapRequestRef.current) {
            visitedMapRequestRef.current = null;
            setVisitedMapLoading(false);
          }
          if (!message.requestId || message.requestId === pendingRequestRef.current) {
            pendingRequestRef.current = null;
            setPending(null);
          }
          setNotice(message.message);
        }
      });

      socket.addEventListener("close", (event) => {
        if (disposed) return;
        socketRef.current = null;
        pendingRequestRef.current = null;
        visitedMapRequestRef.current = null;
        setPending(null);
        setVisitedMapLoading(false);
        if (event.code === 4001) {
          window.location.assign("/api/session?returnTo=/");
          return;
        }
        attempts += 1;
        setConnection(attempts >= 8 ? "offline" : "reconnecting");
        const delay = Math.min(1000 * 2 ** Math.min(attempts - 1, 4), 15_000);
        reconnectTimer = setTimeout(connect, delay);
      });
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socketRef.current?.close();
    };
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 3600);
    return () => clearTimeout(timer);
  }, [notice]);

  const sendCommand = (command: CommandWithoutId, pendingLabel?: string) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setNotice("尚未连入江湖，请稍候再试。");
      return false;
    }
    const requestId = createClientId();
    socket.send(JSON.stringify({ ...command, requestId }));
    if (pendingLabel) {
      pendingRequestRef.current = requestId;
      setPending(pendingLabel);
    }
    return true;
  };

  const currentLocation = snapshot.locations.find((location) => location.id === snapshot.self.currentLocation);
  const drawerOpen = drawer !== null;
  const openVisitedMap = () => {
    setDrawer(null);
    setVisitedMapOpen(true);
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setVisitedMapLoading(false);
      setNotice("尚未连入江湖，暂时无法读取足迹。");
      return;
    }
    const requestId = createClientId();
    visitedMapRequestRef.current = requestId;
    visitedLayerPreferenceRef.current = currentLocation?.layerId ?? snapshot.currentLayer.id;
    setVisitedMapLoading(true);
    socket.send(JSON.stringify({ type: "map.visited", requestId }));
  };

  return (
    <main className="game-shell">
      <div className="main-column">
        <WorldPanel world={snapshot.world} recentEvents={snapshot.recentEvents} open={drawer === "world"} />
        <MapPanel
          locations={snapshot.locations}
          routes={snapshot.routes}
          self={snapshot.self}
          onlinePlayers={snapshot.onlinePlayers}
          currentLayer={snapshot.currentLayer}
          pending={pending !== null || connection !== "online"}
          visitedMapLoading={visitedMapLoading}
          onOpenVisitedMap={openVisitedMap}
          onMove={(locationId) => {
            setDrawer(null);
            sendCommand({ type: "move", locationId }, "move");
          }}
        />
        <ActionsPanel
          actionState={snapshot.actionState}
          transitions={snapshot.transitions}
          self={snapshot.self}
          locations={snapshot.locations}
          pending={pending !== null || connection !== "online"}
          open={drawer === "actions"}
          onStart={(actionId) => sendCommand({ type: "action.start", actionId }, "action")}
          onCancel={(jobId) => sendCommand({ type: "action.cancel", jobId }, "action")}
          onReorder={(jobIds) => sendCommand({ type: "action.queue.reorder", jobIds }, "action")}
          onTransition={(locationId) => sendCommand({ type: "move", locationId }, "move")}
        />
      </div>

      <aside className="side-column">
        <div className={`connection-badge ${connection}`}>
          <i /> {CONNECTION_LABEL[connection]}
        </div>
        <CharacterPanel
          self={snapshot.self}
          location={currentLocation}
          open={drawer === "character"}
          pending={pending !== null || connection !== "online"}
          onAllocate={(allocations) => sendCommand({ type: "attributes.allocate", allocations }, "attributes")}
          onBreakthrough={() => sendCommand({ type: "cultivation.breakthrough" }, "breakthrough")}
        />
        <ChatPanel
          messages={snapshot.chatMessages}
          selfId={snapshot.self.id}
          connected={connection === "online"}
          open={drawer === "chat"}
          onSend={(content) => sendCommand({ type: "chat.send", content })}
        />
      </aside>

      {drawerOpen && <button className="drawer-backdrop" aria-label="关闭面板" onClick={() => setDrawer(null)} />}
      <nav className="mobile-dock" aria-label="游戏界面">
        <button className={drawer === null && !visitedMapOpen ? "active" : ""} onClick={() => { setDrawer(null); setVisitedMapOpen(false); }}><i>图</i><span>地图</span></button>
        <button className={visitedMapOpen ? "active" : ""} onClick={openVisitedMap}><i>迹</i><span>足迹</span></button>
        <button className={drawer === "world" ? "active" : ""} onClick={() => setDrawer("world")}><i>天</i><span>世界</span></button>
        <button className={drawer === "actions" ? "active" : ""} onClick={() => setDrawer("actions")}><i>行</i><span>行动</span></button>
        <button className={drawer === "character" ? "active" : ""} onClick={() => setDrawer("character")}><i>侠</i><span>角色</span></button>
        <button className={drawer === "chat" ? "active" : ""} onClick={() => setDrawer("chat")}><i>言</i><span>聊天</span></button>
      </nav>

      {visitedMapOpen && (
        <VisitedMapDialog
          map={visitedMap}
          loading={visitedMapLoading}
          layerId={visitedLayerId}
          currentLocationId={snapshot.self.currentLocation}
          onLayerChange={setVisitedLayerId}
          onClose={() => setVisitedMapOpen(false)}
        />
      )}

      {notice && <div className="notice" role="status">{notice}</div>}
      {pending && <div className="pending-ink" aria-label="行动处理中"><span /></div>}
    </main>
  );
}
