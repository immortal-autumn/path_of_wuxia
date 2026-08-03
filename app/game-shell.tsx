"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import Link from "next/link";
import type { ClientMessage, ServerMessage } from "@/lib/game/protocol";
import type {
  ActionDefinition,
  BaseAttributes,
  GameSnapshot,
  Location,
  MapTransition,
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

function effectText(action: ActionDefinition) {
  const effects = [
    ["银两", action.silverDelta],
    ["气血", action.hpDelta],
  ] as const;
  return effects
    .filter(([, value]) => value !== 0)
    .map(([label, value]) => `${label} ${value > 0 ? "+" : ""}${value}`)
    .join("　");
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
  currentLayer,
}: Pick<GameSnapshot, "locations" | "routes" | "self" | "onlinePlayers" | "currentLayer"> & {
  pending: boolean;
  onMove: (locationId: string) => void;
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
        <p>地图仅显示地点名称；可直接点击实线方框移动。</p>
      </header>
      <dl className="map-status" aria-label="地图信息">
        <div><dt>当前位置</dt><dd>{currentLocation?.name ?? "未知之地"}</dd></div>
        <div><dt>指向地点</dt><dd>{inspectedLocation?.name ?? "悬停或聚焦查看全名"}</dd></div>
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
                transform={`translate(${location.x} ${location.y})`}
                role="button"
                tabIndex={canMove ? 0 : -1}
                aria-label={`${location.name}${current ? "，当前位置" : reachable ? "，可前往" : ""}`}
                aria-disabled={!canMove}
                onClick={() => activateLocation(location)}
                onKeyDown={(event) => handleKey(event, location)}
                onMouseEnter={() => setInspectedLocationId(location.id)}
                onMouseLeave={() => setInspectedLocationId(null)}
                onFocus={() => setInspectedLocationId(location.id)}
                onBlur={() => setInspectedLocationId(null)}
              >
                <rect className="node-box" x="-48" y="-48" width="96" height="96" />
                <foreignObject x="-44" y="-44" width="88" height="88" pointerEvents="none">
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

function ActionsPanel({
  actions,
  transitions,
  self,
  locations,
  pending,
  open,
  onAct,
  onTransition,
}: Pick<GameSnapshot, "actions" | "transitions" | "self" | "locations"> & {
  pending: boolean;
  open: boolean;
  onAct: (actionId: string) => void;
  onTransition: (locationId: string) => void;
}) {
  const currentLocation = locations.find((location) => location.id === self.currentLocation);
  const availableActions = actions.filter((action) => action.locationId === self.currentLocation);
  return (
    <section className={`actions-panel paper-panel mobile-drawer ${open ? "drawer-open" : ""}`} aria-label="行动">
      <div className="section-heading">
        <div>
          <p className="eyebrow">此地可为</p>
          <h2>{currentLocation?.name ?? "未知之地"}</h2>
        </div>
        <p>{currentLocation?.description}</p>
      </div>
      <div className="action-list">
        {availableActions.map((action) => {
          const unavailable = self.silver + action.silverDelta < 0;
          return (
            <button
              className="action-card"
              key={action.id}
              disabled={pending || unavailable}
              onClick={() => onAct(action.id)}
            >
              <span className="action-mark">行</span>
              <span>
                <strong>{action.name}</strong>
                <small>{action.description}</small>
              </span>
              <em>{effectText(action)}</em>
            </button>
          );
        })}
        {transitions.map((transition: MapTransition) => (
          <button
            className="action-card transition-action"
            key={transition.routeId}
            disabled={pending}
            onClick={() => onTransition(transition.destinationId)}
          >
            <span className="action-mark">门</span>
            <span><strong>{transition.label}</strong><small>跨地图层通道</small></span>
          </button>
        ))}
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
  const socketRef = useRef<WebSocket | null>(null);
  const pendingRequestRef = useRef<string | null>(null);

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
        setPending(null);
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
          onMove={(locationId) => {
            setDrawer(null);
            sendCommand({ type: "move", locationId }, "move");
          }}
        />
        <ActionsPanel
          actions={snapshot.actions}
          transitions={snapshot.transitions}
          self={snapshot.self}
          locations={snapshot.locations}
          pending={pending !== null || connection !== "online"}
          open={drawer === "actions"}
          onAct={(actionId) => sendCommand({ type: "act", actionId }, "act")}
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
        <button className={drawer === null ? "active" : ""} onClick={() => setDrawer(null)}><i>图</i><span>地图</span></button>
        <button className={drawer === "world" ? "active" : ""} onClick={() => setDrawer("world")}><i>天</i><span>世界</span></button>
        <button className={drawer === "actions" ? "active" : ""} onClick={() => setDrawer("actions")}><i>行</i><span>行动</span></button>
        <button className={drawer === "character" ? "active" : ""} onClick={() => setDrawer("character")}><i>侠</i><span>角色</span></button>
        <button className={drawer === "chat" ? "active" : ""} onClick={() => setDrawer("chat")}><i>言</i><span>聊天</span></button>
      </nav>

      {notice && <div className="notice" role="status">{notice}</div>}
      {pending && <div className="pending-ink" aria-label="行动处理中"><span /></div>}
    </main>
  );
}
