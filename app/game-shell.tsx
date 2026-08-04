"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
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

function visionDepthText(depth: number) {
  return ["零", "一", "二", "三", "四", "五", "六", "七", "八"][depth] ?? String(depth);
}

function remainingText(job: ActionJob, now: number) {
  if (!job.completesAt) return "等待开始";
  const seconds = Math.max(0, Math.ceil((new Date(job.completesAt).getTime() - now) / 1000));
  return seconds === 0 ? "正在结算" : `剩余 ${durationText(seconds)}`;
}

function cooldownRemainingText(until: string | null, now: number) {
  if (!until) return "可以发动";
  const seconds = Math.max(0, Math.ceil((new Date(until).getTime() - now) / 1000));
  return seconds === 0 ? "可以发动" : `冷却剩余 ${durationText(seconds)}`;
}

function effectRemainingText(until: string | null, now: number) {
  if (!until) return "没有持续中的效果";
  const seconds = Math.max(0, Math.ceil((new Date(until).getTime() - now) / 1000));
  return seconds === 0 ? "效果正在结束" : `效果剩余 ${durationText(seconds)}`;
}

function isCoolingDown(until: string | null, now: number) {
  return until !== null && new Date(until).getTime() > now;
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
        <nav className="world-tools"><Link className="map-editor-link" href="/map-editor">地图设计</Link><Link className="map-editor-link" href="/action-editor">行动设计</Link></nav>
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
  qinggongTargets,
  pending,
  onMove,
  onQinggong,
  onOpenVisitedMap,
  visitedMapLoading,
  currentLayer,
}: Pick<GameSnapshot, "locations" | "routes" | "self" | "onlinePlayers" | "qinggongTargets" | "currentLayer"> & {
  pending: boolean;
  onMove: (locationId: string) => void;
  onQinggong: (locationId: string) => void;
  onOpenVisitedMap: () => void;
  visitedMapLoading: boolean;
}) {
  const [inspectedLocationId, setInspectedLocationId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const locationMap = useMemo(() => new Map(locations.map((location) => [location.id, location])), [locations]);
  const qinggongTargetMap = useMemo(
    () => new Map(qinggongTargets.map((target) => [target.locationId, target])),
    [qinggongTargets],
  );
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
      if (distance >= self.visionDepth) continue;

      for (const edge of routeGraph.get(locationId) ?? []) {
        if (!result.has(edge.neighborId)) {
          result.set(edge.neighborId, distance + 1);
          queue.push(edge.neighborId);
        }
      }
    }

    return result;
  }, [routeGraph, self.currentLocation, self.visionDepth]);
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
    () => locations.filter((location) => distances.has(location.id) || qinggongTargetMap.has(location.id)),
    [distances, locations, qinggongTargetMap],
  );
  const visibleLocationIds = useMemo(
    () => new Set(visibleLocations.map((location) => location.id)),
    [visibleLocations],
  );
  const ordinaryVisibleCount = useMemo(
    () => visibleLocations.filter((location) => distances.has(location.id)).length,
    [distances, visibleLocations],
  );
  const visibleRoutes = useMemo(
    () => routes.filter(
      (route) => visibleLocationIds.has(route.fromLocation) && visibleLocationIds.has(route.toLocation),
    ),
    [routes, visibleLocationIds],
  );
  const currentLocation = locationMap.get(self.currentLocation);
  const inspectedLocation = inspectedLocationId ? locationMap.get(inspectedLocationId) : null;
  const inspectedQinggongTarget = inspectedLocationId ? qinggongTargetMap.get(inspectedLocationId) : null;
  const nearbyPlayers = onlinePlayers.filter((player) => visibleLocationIds.has(player.currentLocation));

  const mapBounds = useMemo(() => {
    if (visibleLocations.length === 0) return { minX: -260, minY: -160, maxX: 260, maxY: 160 };
    return {
      minX: Math.min(...visibleLocations.map((location) => location.x)) - 110,
      minY: Math.min(...visibleLocations.map((location) => location.y)) - 110,
      maxX: Math.max(...visibleLocations.map((location) => location.x)) + 110,
      maxY: Math.max(...visibleLocations.map((location) => location.y)) + 110,
    };
  }, [visibleLocations]);
  const viewBox = useMemo(() => {
    const { minX, minY, maxX, maxY } = mapBounds;
    const contentWidth = maxX - minX;
    const contentHeight = maxY - minY;
    const width = Math.max(520, contentWidth);
    const height = Math.max(320, contentHeight);
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    return `${centerX - width / 2} ${centerY - height / 2} ${width} ${height}`;
  }, [mapBounds]);
  const regionPlanes = useMemo(() => {
    const groups = new Map<string, Location[]>();
    for (const location of visibleLocations) {
      const key = location.region || "无名区域";
      groups.set(key, [...(groups.get(key) ?? []), location]);
    }
    return [...groups.entries()].map(([name, regionLocations]) => {
      const minX = Math.min(...regionLocations.map((location) => location.x)) - 78;
      const minY = Math.min(...regionLocations.map((location) => location.y)) - 78;
      const maxX = Math.max(...regionLocations.map((location) => location.x)) + 78;
      const maxY = Math.max(...regionLocations.map((location) => location.y)) + 78;
      return { name, label: conciseLocationName(name), minX, minY, width: maxX - minX, height: maxY - minY };
    });
  }, [visibleLocations]);
  const gridColumns = useMemo(
    () => [...new Set(visibleLocations.map((location) => location.x))].sort((a, b) => a - b),
    [visibleLocations],
  );
  const gridRows = useMemo(
    () => [...new Set(visibleLocations.map((location) => location.y))].sort((a, b) => a - b),
    [visibleLocations],
  );
  const visibleLocationsByDepth = useMemo(
    () => [...visibleLocations].sort((left, right) => {
      const leftDistance = distances.get(left.id) ?? qinggongTargetMap.get(left.id)?.distance ?? 0;
      const rightDistance = distances.get(right.id) ?? qinggongTargetMap.get(right.id)?.distance ?? 0;
      return rightDistance - leftDistance;
    }),
    [distances, qinggongTargetMap, visibleLocations],
  );

  const activateLocation = (location: Location) => {
    if (pending) return;
    if (adjacent.has(location.id)) {
      onMove(location.id);
      return;
    }
    const qinggongTarget = qinggongTargetMap.get(location.id);
    if (qinggongTarget && !isCoolingDown(qinggongTarget.cooldownUntil, now)) onQinggong(location.id);
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
          <p>粗线是一步道路，细线是远处路网；地点按距离形成前、中、后景。</p>
          <button type="button" onClick={onOpenVisitedMap} disabled={visitedMapLoading}>
            {visitedMapLoading ? "读取足迹…" : "足迹地图"}
          </button>
        </div>
      </header>
      <dl className="map-status" aria-label="地图信息">
        <div><dt>地图中心</dt><dd>{currentLocation ? `${currentLocation.name} · (${currentLocation.gridX}, ${currentLocation.gridY})` : "未知之地"}</dd></div>
        <div><dt>聚焦地点</dt><dd>{inspectedLocation
          ? `${inspectedLocation.name} · (${inspectedLocation.gridX}, ${inspectedLocation.gridY})${inspectedQinggongTarget
            ? ` · 轻功${DIRECTION_LABEL[inspectedQinggongTarget.direction]} ${inspectedQinggongTarget.distance}格 · ${cooldownRemainingText(inspectedQinggongTarget.cooldownUntil, now)}`
            : ""}`
          : "悬停或聚焦查看全名"}</dd></div>
        <div><dt>区域结构</dt><dd>{currentLocation?.region ?? "无名区域"} · {regionPlanes.length} 区</dd></div>
        <div><dt>{visionDepthText(self.visionDepth)}步结构</dt><dd>{ordinaryVisibleCount} 地点 · {visibleRoutes.length} 道路 · {nearbyPlayers.length} 人</dd></div>
      </dl>
      <div className="map-stage">
        <div className="map-orientation" aria-label="地图方位">
          <span className="orientation-up">上</span><span className="orientation-left">左</span>
          <i>方位</i><span className="orientation-right">右</span><span className="orientation-down">下</span>
        </div>
        <div className="map-structure-chip" aria-hidden="true">中心 0 · 前景 1 · 中景 2 · 后景 {visionDepthText(self.visionDepth)}</div>
        <svg className="wuxia-map" viewBox={viewBox} role="img" aria-label={`当前位置${visionDepthText(self.visionDepth)}步视野与轻功落点地图`}>
          <defs>
            <filter id="region-plane-shadow" x="-10%" y="-10%" width="130%" height="140%">
              <feDropShadow dx="9" dy="11" stdDeviation="0" floodColor="#dedede" />
            </filter>
          </defs>
          {regionPlanes.map((region) => (
            <g className="map-region-group" key={region.name} aria-hidden="true">
              <title>{region.name}</title>
              <rect
                className="map-region-plane"
                x={region.minX}
                y={region.minY}
                width={region.width}
                height={region.height}
                filter="url(#region-plane-shadow)"
              />
              <text className="map-region-label" x={region.minX + 14} y={region.minY + 24}>{region.label}</text>
            </g>
          ))}
          <g className="map-coordinate-grid" aria-hidden="true">
            {gridColumns.map((x) => (
              <line
                key={`grid-x-${x}`}
                className={`map-grid-line ${currentLocation?.x === x ? "current-axis" : ""}`}
                x1={x}
                y1={mapBounds.minY}
                x2={x}
                y2={mapBounds.maxY}
              />
            ))}
            {gridRows.map((y) => (
              <line
                key={`grid-y-${y}`}
                className={`map-grid-line ${currentLocation?.y === y ? "current-axis" : ""}`}
                x1={mapBounds.minX}
                y1={y}
                x2={mapBounds.maxX}
                y2={y}
              />
            ))}
          </g>
          {visibleRoutes.map((route) => {
            const from = locationMap.get(route.fromLocation);
            const to = locationMap.get(route.toLocation);
            if (!from || !to) return null;
            const fromCurrent = from.id === self.currentLocation;
            const toCurrent = to.id === self.currentLocation;
            const activeRoute = fromCurrent || toCurrent;
            const x1 = toCurrent ? to.x : from.x;
            const y1 = toCurrent ? to.y : from.y;
            const x2 = toCurrent ? from.x : to.x;
            const y2 = toCurrent ? from.y : to.y;
            return (
              <g className="map-route-group" key={`${route.fromLocation}-${route.toLocation}`}>
                <line className={`map-route-shadow ${activeRoute ? "active-route" : "distant-route"}`} x1={x1} y1={y1} x2={x2} y2={y2} />
                <line
                  className={`map-route ${route.routeType} ${activeRoute ? "active-route" : "distant-route"}`}
                  x1={x1}
                  y1={y1}
                  x2={x2}
                  y2={y2}
                >
                  <title>{route.routeType === "portal" ? "传送门" : route.fromDirection ? DIRECTION_LABEL[route.fromDirection] : "路线"}</title>
                </line>
                {activeRoute && (
                  <g className="route-step" aria-hidden="true">
                    <circle className="route-step-marker" cx={(x1 + x2) / 2} cy={(y1 + y2) / 2} r="8" />
                    <text className="route-step-number" x={(x1 + x2) / 2} y={(y1 + y2) / 2}>1</text>
                  </g>
                )}
              </g>
            );
          })}
          {visibleLocationsByDepth.map((location) => {
            const current = location.id === self.currentLocation;
            const reachable = adjacent.has(location.id);
            const qinggongTarget = qinggongTargetMap.get(location.id);
            const qinggongCooling = qinggongTarget ? isCoolingDown(qinggongTarget.cooldownUntil, now) : false;
            const canActivate = !pending && (reachable || (qinggongTarget !== undefined && !qinggongCooling));
            const distance = distances.get(location.id) ?? qinggongTarget?.distance ?? 0;
            return (
              <g
                key={location.id}
                className={`map-node distance-${distance} ${current ? "current" : ""} ${reachable ? "reachable" : ""} ${qinggongTarget ? "qinggong-target" : ""} ${qinggongCooling ? "qinggong-cooling" : ""}`}
                data-distance={distance}
                data-location-id={location.id}
                data-ordinary-visible={distances.has(location.id) ? "true" : undefined}
                data-qinggong-target={qinggongTarget ? "true" : undefined}
                data-region={location.region}
                transform={`translate(${location.x} ${location.y})`}
                role="button"
                tabIndex={canActivate ? 0 : -1}
                aria-label={`${location.name}，网格 (${location.gridX}, ${location.gridY})${current
                  ? "，当前位置"
                  : reachable
                    ? "，普通移动可前往"
                    : qinggongTarget
                      ? `，轻功${DIRECTION_LABEL[qinggongTarget.direction]}方${qinggongTarget.distance}格${qinggongCooling ? `，${cooldownRemainingText(qinggongTarget.cooldownUntil, now)}` : "，轻功可达，立即发动"}`
                      : ""}`}
                aria-disabled={!canActivate}
                onClick={() => activateLocation(location)}
                onKeyDown={(event) => handleKey(event, location)}
                onMouseEnter={() => setInspectedLocationId(location.id)}
                onMouseLeave={() => setInspectedLocationId(null)}
                onFocus={() => setInspectedLocationId(location.id)}
                onBlur={() => setInspectedLocationId(null)}
              >
                <title>{`${location.name} · ${location.region} · 距离 ${distance}`}</title>
                <rect className="node-shadow" x="-53" y="-29" width="120" height="72" />
                <path className="node-depth-edge" d="M60 -36 L67 -29 L67 43 L60 36 Z M-60 36 L-53 43 L67 43 L60 36 Z" />
                {qinggongTarget && <rect className="qinggong-ring" x="-67" y="-43" width="134" height="86" />}
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
          <span><i className="legend-qinggong" />轻功落点</span>
          <span><i className="legend-later" />二至{visionDepthText(self.visionDepth)}步</span>
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
  inventory,
  transitions,
  self,
  locations,
  privateEvents,
  combat,
  lootPiles,
  pending,
  open,
  onStart,
  onCancel,
  onReorder,
  onCraft,
  onFarm,
  onCombatChoice,
  onRespawn,
  onTakeLoot,
  onTransition,
}: Pick<GameSnapshot, "actionState" | "inventory" | "transitions" | "self" | "locations" | "privateEvents" | "combat" | "lootPiles"> & {
  pending: boolean;
  open: boolean;
  onStart: (actionId: string) => void;
  onCancel: (jobId: string) => void;
  onReorder: (jobIds: string[]) => void;
  onCraft: (recipeId: string) => void;
  onFarm: (plotId: string, operation: "plant" | "water" | "harvest", cropId?: string) => void;
  onCombatChoice: (combatId: string, choice: "attack" | "power" | "defend" | "flee") => void;
  onRespawn: () => void;
  onTakeLoot: (lootPileId: string) => void;
  onTransition: (locationId: string) => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const currentLocation = locations.find((location) => location.id === self.currentLocation);
  const activeSkillActionIds = new Set(self.skills.flatMap((skill) => (
    skill.kind === "active" && skill.activeActionId ? [skill.activeActionId] : []
  )));
  const regularActionLocked = combat !== null || self.defeated;
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
          {self.defeated && (
            <div className="combat-card defeated-card" role="alert">
              <strong>你已在战斗中落败</strong>
              <p>全部银两与所有未绑定物品已掉落。返回玄关可恢复一半气血。</p>
              <button disabled={pending} onClick={onRespawn}>返回玄关复起</button>
            </div>
          )}
          {combat && (
            <div className="combat-card" aria-label="当前战斗">
              <header><strong>对阵 {combat.opponentName}</strong><span>第 {combat.round} 回合</span></header>
              <p>对方气血 {combat.opponentHp} / {combat.opponentMaxHp}</p>
              <p>{combat.selfTurn ? `你的回合 · ${combat.turnDeadline ? remainingText({ completesAt: combat.turnDeadline } as ActionJob, now) : ""}` : "等待对方行动"}</p>
              <p>超时次数：你 {combat.ownMissedTurns} · 对方 {combat.opponentMissedTurns}（三次自动脱离）</p>
              <div>
                <button disabled={pending || !combat.selfTurn} onClick={() => onCombatChoice(combat.id, "attack")}>攻击</button>
                <button disabled={pending || !combat.selfTurn} onClick={() => onCombatChoice(combat.id, "power")}>蓄力猛击</button>
                <button disabled={pending || !combat.selfTurn} onClick={() => onCombatChoice(combat.id, "defend")}>格挡</button>
                <button disabled={pending || !combat.selfTurn} onClick={() => onCombatChoice(combat.id, "flee")}>逃跑</button>
              </div>
              <ol>{combat.recentTurns.map((turn) => <li key={turn.id}>{turn.resultText}</li>)}</ol>
            </div>
          )}
          {lootPiles.map((pile) => (
            <div className="combat-card loot-card" key={pile.id}>
              <strong>{pile.sourcePlayerName ?? "无名者"}的掉落</strong>
              <p>{pile.silver} 银 · {pile.items.map((item) => `${item.name}×${item.quantity}`).join("、") || "无物品"}</p>
              <button disabled={pending || regularActionLocked} onClick={() => onTakeLoot(pile.id)}>拾取全部</button>
            </div>
          ))}
          {actionState.available.filter((action) => !activeSkillActionIds.has(action.id)).map((action) => (
            <button
              className="action-card"
              key={action.id}
              disabled={pending || regularActionLocked || !action.available || actionState.queued.length >= actionState.maxQueued}
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
              disabled={pending || regularActionLocked || actionState.current !== null}
              onClick={() => onTransition(transition.destinationId)}
            >
              <span className="action-mark">门</span>
              <span><strong>{transition.label}</strong><small>跨地图层通道</small></span>
            </button>
          ))}
          {inventory.recipes.map((recipe) => (
            <button
              className="action-card production-action"
              key={recipe.id}
              disabled={pending || regularActionLocked || !recipe.available || actionState.queued.length >= actionState.maxQueued}
              onClick={() => onCraft(recipe.id)}
              title={recipe.unavailableReason ?? undefined}
            >
              <span className="action-mark">制</span>
              <span><strong>{recipe.name}</strong><small>{recipe.description}</small></span>
              <em>{durationText(recipe.durationSeconds)} · 难度 {recipe.difficulty}</em>
              <em>需 {recipe.inputs.map((item) => `${item.name}×${item.quantity}`).join("、")} → {recipe.outputs.map((item) => `${item.name}×${item.quantity}`).join("、")}</em>
            </button>
          ))}
          {inventory.farmPlots.map((plot) => (
            <div className="production-card" key={plot.id}>
              <span className="action-mark">田</span>
              <span>
                <strong>{plot.cropName ?? "空农田"}</strong>
                <small>{plot.state === "empty" ? "可以播种新作物" : plot.mature ? "作物已经成熟" : `成熟时间 ${plot.maturesAt ? new Date(plot.maturesAt).toLocaleString("zh-CN") : "未知"}`}</small>
              </span>
              <span className="production-controls">
                {plot.state === "empty" ? (
                  <><button disabled={pending || regularActionLocked} onClick={() => onFarm(plot.id, "plant", "crop-rice")}>播种水稻</button><button disabled={pending || regularActionLocked} onClick={() => onFarm(plot.id, "plant", "crop-herb")}>播种药草</button></>
                ) : (
                  <><button disabled={pending || regularActionLocked} onClick={() => onFarm(plot.id, "water")}>浇水</button><button disabled={pending || regularActionLocked || !plot.mature} onClick={() => onFarm(plot.id, "harvest")}>收获</button></>
                )}
              </span>
            </div>
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
          <div className="private-results" aria-label="个人行动记录">
            <strong>个人行动记录</strong>
            {privateEvents.length === 0 && <p>尚无私人结果</p>}
            {privateEvents.slice(0, 6).map((event) => (
              <article key={event.id}>
                <time dateTime={event.createdAt}>{formatClock(event.createdAt)}</time>
                <p>{event.content}</p>
              </article>
            ))}
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

const INTERACTION_LABELS: Record<string, string> = {
  "relationship.friend": "结交请求",
  "relationship.sworn": "结义请求",
  "relationship.mentor": "师徒请求",
  "relationship.lover": "恋人请求",
  "relationship.spouse": "婚配请求",
  intimate: "本次私密亲昵请求",
};

const RELATIONSHIP_LABELS: Record<string, string> = {
  friend: "朋友", sworn: "结义", mentor: "师徒", lover: "恋人", spouse: "婚配",
};

const ROLE_LABELS: Record<string, string> = { mentor: "师父", disciple: "弟子" };

const SKILL_CATEGORY_LABELS: Record<string, string> = {
  perception: "感知", movement: "身法", production: "生产", combat: "战斗",
};

function CharacterPanel({
  self,
  inventory,
  social,
  nearbyPlayers,
  location,
  open,
  pending,
  onAllocate,
  onBreakthrough,
  onEquip,
  onUnequip,
  onUseItem,
  onUseSkill,
  onStopSkill,
  onAdultUpdate,
  onGreet,
  onInteractionRequest,
  onInteractionRespond,
  onRelationshipEnd,
  onBlock,
  onTradeRequest,
  onTradeRespond,
  onTradeOffer,
  onTradeConfirm,
  onTradeCancel,
  onCombatStart,
}: {
  self: GameSnapshot["self"];
  inventory: GameSnapshot["inventory"];
  social: GameSnapshot["social"];
  nearbyPlayers: GameSnapshot["onlinePlayers"];
  location?: Location;
  open: boolean;
  pending: boolean;
  onAllocate: (allocations: BaseAttributes) => void;
  onBreakthrough: () => void;
  onEquip: (itemId: string) => void;
  onUnequip: (itemId: string) => void;
  onUseItem: (itemId: string) => void;
  onUseSkill: (skillId: string) => void;
  onStopSkill: (skillId: string) => void;
  onAdultUpdate: (status: "unknown" | "adult" | "minor", enabled: boolean) => void;
  onGreet: (targetPlayerId: string) => void;
  onInteractionRequest: (targetPlayerId: string, requestType: "relationship.friend" | "relationship.sworn" | "relationship.mentor" | "relationship.lover" | "relationship.spouse" | "intimate") => void;
  onInteractionRespond: (requestId: string, accept: boolean) => void;
  onRelationshipEnd: (relationshipId: string) => void;
  onBlock: (targetPlayerId: string, blocked: boolean) => void;
  onTradeRequest: (targetPlayerId: string) => void;
  onTradeRespond: (tradeId: string, accept: boolean) => void;
  onTradeOffer: (tradeId: string, silver: number, items: Array<{ itemId: string; quantity: number }>) => void;
  onTradeConfirm: (tradeId: string) => void;
  onTradeCancel: (tradeId: string) => void;
  onCombatStart: (targetPlayerId: string) => void;
}) {
  const [tab, setTab] = useState<"base" | "combat" | "cultivation" | "skills" | "inventory" | "social">("base");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const [draft, setDraft] = useState<BaseAttributes>({ strength: 0, agility: 0, constitution: 0, root: 0, comprehension: 0, spirit: 0 });
  const [adultStatus, setAdultStatus] = useState(social.adultProfile.status);
  const [adultEnabled, setAdultEnabled] = useState(social.adultProfile.contentEnabled);
  const [tradeDrafts, setTradeDrafts] = useState<Record<string, { silver: string; itemId: string; quantity: string }>>({});
  const [detail, setDetail] = useState<{ kind: "skill" | "item"; id: string } | null>(null);
  const allocated = Object.values(draft).reduce((sum, value) => sum + value, 0);
  const progress = Math.min(100, (self.cultivation.progress / Math.max(1, self.cultivation.nextLevelCost)) * 100);
  const tradableItems = inventory.items.filter((item) => !item.bound && !item.equippedSlot && item.quantity > item.reservedQuantity);
  const activeSkills = self.skills.filter((skill) => skill.kind === "active");
  const passiveSkills = self.skills.filter((skill) => skill.kind === "passive");
  const detailSkill = detail?.kind === "skill" ? self.skills.find((skill) => skill.id === detail.id) ?? null : null;
  const detailItem = detail?.kind === "item" ? inventory.items.find((item) => item.id === detail.id) ?? null : null;

  useEffect(() => {
    if (!detail) return;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setDetail(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [detail]);

  const openDetailOnKey = (event: KeyboardEvent<HTMLElement>, kind: "skill" | "item", id: string) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setDetail({ kind, id });
    }
  };

  return (
    <>
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
        <button className={tab === "skills" ? "active" : ""} onClick={() => setTab("skills")}>技能</button>
        <button className={tab === "inventory" ? "active" : ""} onClick={() => setTab("inventory")}>物品装备</button>
        <button className={tab === "social" ? "active" : ""} onClick={() => setTab("social")}>交往交易</button>
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
      {tab === "skills" && (
        <div className="skills-panel" aria-label="角色技能">
          <section aria-label="主动技能">
            <h3>主动技能</h3>
            {activeSkills.map((skill) => {
              const cooling = isCoolingDown(skill.cooldownUntil, now);
              const active = isCoolingDown(skill.activeUntil, now);
              return (
                <article
                  className={`skill-card active-skill ${active ? "skill-running" : ""}`}
                  key={skill.id}
                  role="button"
                  tabIndex={0}
                  aria-label={`查看技能详情：${skill.name}`}
                  onClick={() => setDetail({ kind: "skill", id: skill.id })}
                  onKeyDown={(event) => openDetailOnKey(event, "skill", skill.id)}
                >
                  <header><strong>{skill.name}</strong><span>{ATTRIBUTE_LABELS.find(([key]) => key === skill.attributeKey)?.[1] ?? skill.attributeKey} · {SKILL_CATEGORY_LABELS[skill.category] ?? skill.category}</span></header>
                  <p>{skill.description}</p>
                  <small>等级 {skill.level} · 经验 {skill.experience} · {skill.effectDurationSeconds > 0 ? `持续 ${durationText(skill.effectDurationSeconds)}` : "瞬时效果"}</small>
                  {active && <p className="skill-active-status">持续中 · {effectRemainingText(skill.activeUntil, now)}</p>}
                  {skill.id === "qinggong" ? (
                    <p className="skill-instruction">{cooling ? cooldownRemainingText(skill.cooldownUntil, now) : "在地图点击双线轻功边框立即发动"}</p>
                  ) : (
                    <span className="skill-card-cta">{active
                      ? `查看并停止${skill.name}`
                      : cooling
                        ? `${cooldownRemainingText(skill.cooldownUntil, now)} · 查看详情`
                        : skill.activeActionId
                          ? `查看并发动${skill.activeActionName ?? skill.name}`
                          : "查看详情 · 尚未配置可发动规则"}</span>
                  )}
                </article>
              );
            })}
          </section>
          <section aria-label="被动技能">
            <h3>被动技能</h3>
            {passiveSkills.map((skill) => (
              <article
                className="skill-card passive-skill"
                key={skill.id}
                role="button"
                tabIndex={0}
                aria-label={`查看技能详情：${skill.name}`}
                onClick={() => setDetail({ kind: "skill", id: skill.id })}
                onKeyDown={(event) => openDetailOnKey(event, "skill", skill.id)}
              >
                <header><strong>{skill.name}</strong><span>{ATTRIBUTE_LABELS.find(([key]) => key === skill.attributeKey)?.[1] ?? skill.attributeKey} · {SKILL_CATEGORY_LABELS[skill.category] ?? skill.category}</span></header>
                <p>{skill.description}</p>
                <small>等级 {skill.level} · 经验 {skill.experience}</small>
                <span className="skill-card-cta">查看完整详情</span>
              </article>
            ))}
          </section>
        </div>
      )}
      {tab === "inventory" && (
        <div className="inventory-panel" aria-label="物品装备">
          {inventory.items.map((item) => (
            <div
              className="inventory-item"
              key={item.id}
              role="button"
              tabIndex={0}
              aria-label={`查看物品详情：${item.name}`}
              onClick={() => setDetail({ kind: "item", id: item.id })}
              onKeyDown={(event) => openDetailOnKey(event, "item", item.id)}
            >
              <span>
                <strong>{item.name}{item.quantity > 1 ? ` ×${item.quantity}` : ""}</strong>
                <small>品质 {item.quality}{item.bound ? " · 绑定" : ""}{item.equippedSlot ? ` · 已装备：${item.equippedSlot}` : ""}{item.reservedQuantity ? ` · 预留 ${item.reservedQuantity}` : ""}</small>
              </span>
              <span className="item-detail-hint">查看详情</span>
            </div>
          ))}
        </div>
      )}
      {tab === "social" && (
        <div className="social-panel" aria-label="交往交易">
          <section className="adult-settings" aria-label="成人内容设置">
            <h3>年龄与成人内容</h3>
            <label>角色年龄状态
              <select value={adultStatus} onChange={(event) => {
                const value = event.target.value as typeof adultStatus;
                setAdultStatus(value);
                if (value !== "adult") setAdultEnabled(false);
              }}>
                <option value="unknown">未知</option>
                <option value="adult">确认成年</option>
                <option value="minor">未成年</option>
              </select>
            </label>
            <label className="adult-checkbox">
              <input type="checkbox" checked={adultEnabled} disabled={adultStatus !== "adult"} onChange={(event) => setAdultEnabled(event.target.checked)} />
              开启成人内容（仍需每次单独同意）
            </label>
            <button disabled={pending} onClick={() => onAdultUpdate(adultStatus, adultEnabled)}>保存设置</button>
          </section>

          <section aria-label="同地点角色">
            <h3>同地点在线角色</h3>
            {nearbyPlayers.length === 0 && <p>此处没有其他在线角色。</p>}
            {nearbyPlayers.map((player) => (
              <article className="social-player" key={player.id}>
                <strong>{player.name}</strong><small>{player.title}</small>
                <div>
                  <button disabled={pending} onClick={() => onGreet(player.id)}>问候</button>
                  <button disabled={pending} onClick={() => onInteractionRequest(player.id, "relationship.friend")}>结交</button>
                  <button disabled={pending} onClick={() => onInteractionRequest(player.id, "relationship.sworn")}>结义</button>
                  <button disabled={pending} onClick={() => onInteractionRequest(player.id, "relationship.mentor")}>收徒</button>
                  <button disabled={pending} onClick={() => onInteractionRequest(player.id, "relationship.lover")}>恋人</button>
                  <button disabled={pending} onClick={() => onInteractionRequest(player.id, "relationship.spouse")}>婚配</button>
                  <button disabled={pending || !social.adultProfile.contentEnabled} onClick={() => onInteractionRequest(player.id, "intimate")}>私密亲昵</button>
                  <button disabled={pending} onClick={() => onTradeRequest(player.id)}>交易</button>
                  <button disabled={pending} onClick={() => onCombatStart(player.id)}>攻击</button>
                  <button disabled={pending} onClick={() => onBlock(player.id, true)}>屏蔽</button>
                </div>
              </article>
            ))}
          </section>

          <section aria-label="互动请求">
            <h3>互动请求</h3>
            {social.incomingRequests.map((request) => (
              <article className="social-request" key={request.id}>
                <span><strong>{request.fromPlayerName}</strong><small>{INTERACTION_LABELS[request.requestType] ?? request.requestType}</small></span>
                <div><button disabled={pending} onClick={() => onInteractionRespond(request.id, true)}>接受</button><button disabled={pending} onClick={() => onInteractionRespond(request.id, false)}>拒绝</button></div>
              </article>
            ))}
            {social.outgoingRequests.map((request) => <p key={request.id}>等待 {request.toPlayerName} 回应：{INTERACTION_LABELS[request.requestType] ?? request.requestType}</p>)}
            {social.incomingRequests.length + social.outgoingRequests.length === 0 && <p>没有待处理请求。</p>}
          </section>

          <section aria-label="角色关系">
            <h3>已建立关系</h3>
            {social.relationships.map((relationship) => (
              <article className="social-request" key={relationship.id}>
                <span><strong>{relationship.otherPlayerName}</strong><small>{RELATIONSHIP_LABELS[relationship.relationType] ?? relationship.relationType}{relationship.role ? ` · ${ROLE_LABELS[relationship.role] ?? relationship.role}` : ""}</small></span>
                <button disabled={pending} onClick={() => onRelationshipEnd(relationship.id)}>结束</button>
              </article>
            ))}
            {social.relationships.length === 0 && <p>尚未建立正式关系。</p>}
          </section>

          <section aria-label="交易会话">
            <h3>交易</h3>
            {social.trades.map((trade) => {
              const tradeDraft = tradeDrafts[trade.id] ?? { silver: String(trade.ownOffer.silver), itemId: "", quantity: "1" };
              if (trade.status === "pending") return (
                <article className="trade-card" key={trade.id}>
                  <strong>与 {trade.otherPlayerName} 的交易请求</strong>
                  {trade.requestedBySelf
                    ? <p>等待对方接受。</p>
                    : <div><button disabled={pending} onClick={() => onTradeRespond(trade.id, true)}>接受交易</button><button disabled={pending} onClick={() => onTradeRespond(trade.id, false)}>拒绝</button></div>}
                  <button disabled={pending} onClick={() => onTradeCancel(trade.id)}>取消</button>
                </article>
              );
              return (
                <article className="trade-card" key={trade.id}>
                  <strong>与 {trade.otherPlayerName} 交易</strong>
                  <p>我的报价：{trade.ownOffer.silver} 银 · {trade.ownOffer.items.map((item) => `${item.name}×${item.quantity}`).join("、") || "无物品"}</p>
                  <p>对方报价：{trade.otherOffer.silver} 银 · {trade.otherOffer.items.map((item) => `${item.name}×${item.quantity}`).join("、") || "无物品"}</p>
                  <label>银两<input type="number" min="0" value={tradeDraft.silver} onChange={(event) => setTradeDrafts((current) => ({ ...current, [trade.id]: { ...tradeDraft, silver: event.target.value } }))} /></label>
                  <label>物品<select value={tradeDraft.itemId} onChange={(event) => setTradeDrafts((current) => ({ ...current, [trade.id]: { ...tradeDraft, itemId: event.target.value } }))}>
                    <option value="">不提供物品</option>
                    {tradableItems.map((item) => <option value={item.id} key={item.id}>{item.name} · 可用 {item.quantity - item.reservedQuantity}</option>)}
                  </select></label>
                  <label>数量<input type="number" min="1" value={tradeDraft.quantity} onChange={(event) => setTradeDrafts((current) => ({ ...current, [trade.id]: { ...tradeDraft, quantity: event.target.value } }))} /></label>
                  <div>
                    <button disabled={pending} onClick={() => onTradeOffer(
                      trade.id,
                      Math.max(0, Number.parseInt(tradeDraft.silver || "0", 10) || 0),
                      tradeDraft.itemId ? [{ itemId: tradeDraft.itemId, quantity: Math.max(1, Number.parseInt(tradeDraft.quantity || "1", 10) || 1) }] : [],
                    )}>更新报价</button>
                    <button disabled={pending || trade.ownConfirmed} onClick={() => onTradeConfirm(trade.id)}>{trade.ownConfirmed ? "已确认" : "确认报价"}</button>
                    <button disabled={pending} onClick={() => onTradeCancel(trade.id)}>取消</button>
                  </div>
                  <small>{trade.otherConfirmed ? "对方已确认" : "等待对方确认"}</small>
                </article>
              );
            })}
            {social.trades.length === 0 && <p>没有交易会话。</p>}
          </section>
        </div>
      )}
      <div className="character-numbers"><div><span>银两</span><strong>{self.silver}</strong><small>枚</small></div></div>
    </section>
    {detail && typeof document !== "undefined" && createPortal(
      <div className="detail-modal-backdrop" onMouseDown={(event) => {
        if (event.target === event.currentTarget) setDetail(null);
      }}>
        <section className="detail-modal" role="dialog" aria-modal="true" aria-label={detailSkill ? `技能详情：${detailSkill.name}` : `物品详情：${detailItem?.name ?? "未知"}`}>
          <header><div><p className="eyebrow">完整资料</p><h2>{detailSkill?.name ?? detailItem?.name ?? "详情"}</h2></div><button type="button" onClick={() => setDetail(null)}>关闭</button></header>
          {detailSkill && (
            <div className="detail-modal-body">
              <p>{detailSkill.description}</p>
              <dl>
                <div><dt>类型</dt><dd>{detailSkill.kind === "active" ? "主动技能" : "被动技能"}</dd></div>
                <div><dt>关联属性</dt><dd>{ATTRIBUTE_LABELS.find(([key]) => key === detailSkill.attributeKey)?.[1] ?? detailSkill.attributeKey}</dd></div>
                <div><dt>等级 / 经验</dt><dd>{detailSkill.level} / {detailSkill.experience}</dd></div>
                <div><dt>效果持续</dt><dd>{detailSkill.effectDurationSeconds > 0 ? durationText(detailSkill.effectDurationSeconds) : "瞬时"}</dd></div>
                <div><dt>当前效果</dt><dd>{isCoolingDown(detailSkill.activeUntil, now) ? effectRemainingText(detailSkill.activeUntil, now) : "未持续"}</dd></div>
                <div><dt>冷却</dt><dd>{cooldownRemainingText(detailSkill.cooldownUntil, now)}</dd></div>
              </dl>
              {detailSkill.kind === "active" && detailSkill.id === "qinggong" && <p className="detail-note">请关闭弹窗后，在地图点击双线轻功落点发动。</p>}
              {detailSkill.kind === "active" && detailSkill.id !== "qinggong" && (
                <div className="detail-modal-actions">
                  {isCoolingDown(detailSkill.activeUntil, now) ? (
                    <button disabled={pending} onClick={() => { onStopSkill(detailSkill.id); setDetail(null); }}>停止{detailSkill.name}</button>
                  ) : (
                    <button
                      disabled={pending || isCoolingDown(detailSkill.cooldownUntil, now) || detailSkill.activeActionId === null}
                      onClick={() => { onUseSkill(detailSkill.id); setDetail(null); }}
                    >
                      {isCoolingDown(detailSkill.cooldownUntil, now)
                        ? cooldownRemainingText(detailSkill.cooldownUntil, now)
                        : detailSkill.activeActionId
                          ? `确认发动${detailSkill.activeActionName ?? detailSkill.name}`
                          : "尚未配置可发动规则"}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
          {detailItem && (
            <div className="detail-modal-body">
              <p>{detailItem.description}</p>
              <dl>
                <div><dt>类别</dt><dd>{detailItem.category}</dd></div>
                <div><dt>数量 / 预留</dt><dd>{detailItem.quantity} / {detailItem.reservedQuantity}</dd></div>
                <div><dt>品质</dt><dd>{detailItem.quality}</dd></div>
                <div><dt>耐久</dt><dd>{detailItem.maxDurability > 0 ? `${detailItem.durability} / ${detailItem.maxDurability}` : "不适用"}</dd></div>
                <div><dt>绑定</dt><dd>{detailItem.bound ? "是" : "否"}</dd></div>
                <div><dt>装备位置</dt><dd>{detailItem.equippedSlot ?? detailItem.equipmentSlot ?? "不可装备"}</dd></div>
              </dl>
              <pre>{JSON.stringify(detailItem.effects, null, 2)}</pre>
              <div className="detail-modal-actions">
                {detailItem.equipmentSlot && (detailItem.equippedSlot
                  ? <button disabled={pending} onClick={() => { onUnequip(detailItem.id); setDetail(null); }}>确认卸下</button>
                  : <button disabled={pending || detailItem.quantity <= detailItem.reservedQuantity} onClick={() => { onEquip(detailItem.id); setDetail(null); }}>确认装备</button>)}
                {Object.keys(detailItem.effects).some((key) => key === "needDeltas" || key === "hpDelta") && (
                  <button disabled={pending || detailItem.quantity <= detailItem.reservedQuantity} onClick={() => { onUseItem(detailItem.id); setDetail(null); }}>确认使用</button>
                )}
              </div>
            </div>
          )}
        </section>
      </div>,
      document.body,
    )}
    </>
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
        if (message.type === "inventory.updated") {
          setSnapshot((current) => ({ ...current, inventory: message.inventory }));
        }
        if (message.type === "social.updated") {
          setSnapshot((current) => ({ ...current, social: message.social }));
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
        if (message.type === "rules.invalidated") {
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
  const nearbyPlayers = snapshot.onlinePlayers.filter((player) => (
    player.id !== snapshot.self.id && player.currentLocation === snapshot.self.currentLocation
  ));
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
          qinggongTargets={snapshot.qinggongTargets}
          currentLayer={snapshot.currentLayer}
          pending={pending !== null || connection !== "online" || snapshot.combat !== null || snapshot.self.defeated}
          visitedMapLoading={visitedMapLoading}
          onOpenVisitedMap={openVisitedMap}
          onMove={(locationId) => {
            setDrawer(null);
            sendCommand({ type: "move", locationId }, "move");
          }}
          onQinggong={(destinationId) => sendCommand({ type: "qinggong.start", destinationId }, "qinggong")}
        />
        <ActionsPanel
          actionState={snapshot.actionState}
          inventory={snapshot.inventory}
          transitions={snapshot.transitions}
          self={snapshot.self}
          locations={snapshot.locations}
          privateEvents={snapshot.privateEvents}
          combat={snapshot.combat}
          lootPiles={snapshot.lootPiles}
          pending={pending !== null || connection !== "online"}
          open={drawer === "actions"}
          onStart={(actionId) => sendCommand({ type: "action.start", actionId }, "action")}
          onCancel={(jobId) => sendCommand({ type: "action.cancel", jobId }, "action")}
          onReorder={(jobIds) => sendCommand({ type: "action.queue.reorder", jobIds }, "action")}
          onCraft={(recipeId) => sendCommand({ type: "craft.start", recipeId }, "craft")}
          onFarm={(plotId, operation, cropId) => sendCommand({ type: "farm.start", plotId, operation, cropId }, "farm")}
          onCombatChoice={(combatId, choice) => sendCommand({ type: "combat.choose", combatId, choice }, "combat")}
          onRespawn={() => sendCommand({ type: "combat.respawn" }, "combat")}
          onTakeLoot={(lootPileId) => sendCommand({ type: "loot.take", lootPileId }, "loot")}
          onTransition={(locationId) => sendCommand({ type: "move", locationId }, "move")}
        />
      </div>

      <aside className="side-column">
        <div className={`connection-badge ${connection}`}>
          <i /> {CONNECTION_LABEL[connection]}
        </div>
        <CharacterPanel
          self={snapshot.self}
          inventory={snapshot.inventory}
          social={snapshot.social}
          nearbyPlayers={nearbyPlayers}
          location={currentLocation}
          open={drawer === "character"}
          pending={pending !== null || connection !== "online" || snapshot.combat !== null || snapshot.self.defeated}
          onAllocate={(allocations) => sendCommand({ type: "attributes.allocate", allocations }, "attributes")}
          onBreakthrough={() => sendCommand({ type: "cultivation.breakthrough" }, "breakthrough")}
          onEquip={(itemId) => sendCommand({ type: "inventory.equip", itemId }, "inventory")}
          onUnequip={(itemId) => sendCommand({ type: "inventory.unequip", itemId }, "inventory")}
          onUseItem={(itemId) => sendCommand({ type: "inventory.use", itemId }, "inventory")}
          onUseSkill={(skillId) => sendCommand({ type: "skill.use", skillId }, "skill")}
          onStopSkill={(skillId) => sendCommand({ type: "skill.stop", skillId }, "skill")}
          onAdultUpdate={(adultStatus, adultContentEnabled) => sendCommand({ type: "profile.adult.update", adultStatus, adultContentEnabled }, "social")}
          onGreet={(targetPlayerId) => sendCommand({ type: "interaction.greet", targetPlayerId }, "social")}
          onInteractionRequest={(targetPlayerId, requestType) => sendCommand({ type: "interaction.request", targetPlayerId, requestType }, "social")}
          onInteractionRespond={(interactionRequestId, accept) => sendCommand({ type: "interaction.respond", interactionRequestId, accept }, "social")}
          onRelationshipEnd={(relationshipId) => sendCommand({ type: "relationship.end", relationshipId }, "social")}
          onBlock={(targetPlayerId, blocked) => sendCommand({ type: "player.block", targetPlayerId, blocked }, "social")}
          onTradeRequest={(targetPlayerId) => sendCommand({ type: "trade.request", targetPlayerId }, "trade")}
          onTradeRespond={(tradeId, accept) => sendCommand({ type: "trade.respond", tradeId, accept }, "trade")}
          onTradeOffer={(tradeId, silver, items) => sendCommand({ type: "trade.offer", tradeId, silver, items }, "trade")}
          onTradeConfirm={(tradeId) => sendCommand({ type: "trade.confirm", tradeId }, "trade")}
          onTradeCancel={(tradeId) => sendCommand({ type: "trade.cancel", tradeId }, "trade")}
          onCombatStart={(targetPlayerId) => sendCommand({ type: "combat.start", targetPlayerId }, "combat")}
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
