"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import Link from "next/link";
import type { ClientMessage, ServerMessage } from "@/lib/game/protocol";
import { chunkForGrid, chunkKey, DIRECTION_LABEL, worldToGridPosition } from "@/lib/game/map";
import { createClientId } from "@/lib/game/client-id";
import { conciseLocationName } from "@/lib/game/location-label";
import type {
  MapEditOperation,
  MapEditSessionState,
  MapLayer,
  MapLock,
  MapRegion,
  MapViewport,
  Location,
  PlayerSelf,
  RouteType,
  TransitionKind,
} from "@/lib/game/types";

type CommandWithoutId = ClientMessage extends infer Message
  ? Message extends { requestId: string }
    ? Omit<Message, "requestId">
    : never
  : never;

type Waiter = {
  expected: ServerMessage["type"];
  resolve: (message: ServerMessage) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type DragState =
  | { kind: "location"; id: string; originalRegionId: string | null; originalGridX: number; originalGridY: number }
  | { kind: "region"; id: string; offsetX: number; offsetY: number; originalX: number; originalY: number }
  | { kind: "resize"; id: string; startX: number; startY: number };

function scopeForPoint(layerId: string, regionId: string | null, gridX: number, gridY: number) {
  if (regionId) return `region:${regionId}`;
  const chunk = chunkForGrid(gridX, gridY);
  return `layer:${layerId}:chunk:${chunkKey(chunk.chunkX, chunk.chunkY)}`;
}

function layerLabel(layer: MapLayer, layers: MapLayer[]) {
  const byId = new Map(layers.map((item) => [item.id, item]));
  const seen = new Set<string>([layer.id]);
  let depth = 0;
  let parentId = layer.parentLayerId;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    depth += 1;
    parentId = byId.get(parentId)?.parentLayerId ?? null;
  }
  return `${"　".repeat(depth)}${depth > 0 ? "↳ " : ""}${layer.name}`;
}

export default function MapEditorShell({
  player,
  initialViewport,
  initialLocks,
}: {
  player: PlayerSelf;
  initialViewport: MapViewport;
  initialLocks: MapLock[];
}) {
  const [viewport, setViewport] = useState(initialViewport);
  const [locks, setLocks] = useState(initialLocks);
  const [session, setSession] = useState<MapEditSessionState | null>(null);
  const [connected, setConnected] = useState(false);
  const [notice, setNotice] = useState("拖拽素材到画布即可新增地图内容。");
  const [centerChunk, setCenterChunk] = useState({ x: 0, y: 0 });
  const [radius, setRadius] = useState(1);
  const [zoom, setZoom] = useState(1.15);
  const [layerId, setLayerId] = useState(initialViewport.layer.id);
  const [selectedLocationId, setSelectedLocationId] = useState<string | null>(null);
  const [selectedRegionId, setSelectedRegionId] = useState<string | null>(null);
  const [routeTarget, setRouteTarget] = useState("");
  const [routeType, setRouteType] = useState<RouteType>("normal");
  const [routeTargetLayerId, setRouteTargetLayerId] = useState(initialViewport.layer.id);
  const [routeTargets, setRouteTargets] = useState<Location[]>(initialViewport.locations);
  const [routeSearch, setRouteSearch] = useState("");
  const [transitionKind, setTransitionKind] = useState<TransitionKind>("door");
  const socketRef = useRef<WebSocket | null>(null);
  const waitersRef = useRef(new Map<string, Waiter>());
  const dragRef = useRef<DragState | null>(null);
  const viewportParamsRef = useRef({ centerChunk, radius, zoom, layerId });

  useEffect(() => {
    viewportParamsRef.current = { centerChunk, radius, zoom, layerId };
  }, [centerChunk, radius, zoom, layerId]);

  const worldWidth = 1600 / zoom;
  const worldHeight = 900 / zoom;
  const viewX = centerChunk.x * 1000 + 500 - worldWidth / 2;
  const viewY = centerChunk.y * 1000 + 500 - worldHeight / 2;
  const viewBox = `${viewX} ${viewY} ${worldWidth} ${worldHeight}`;
  const locationMap = useMemo(() => new Map(viewport.locations.map((item) => [item.id, item])), [viewport.locations]);
  const routeLocationMap = useMemo(() => new Map(
    [...viewport.locations, ...viewport.remoteLocations, ...routeTargets].map((item) => [item.id, item]),
  ), [routeTargets, viewport.locations, viewport.remoteLocations]);
  const selectedLocation = selectedLocationId ? locationMap.get(selectedLocationId) ?? null : null;
  const selectedRegion = selectedRegionId ? viewport.regions.find((item) => item.id === selectedRegionId) ?? null : null;
  const selectedLayer = viewport.layers.find((item) => item.id === layerId) ?? viewport.layer;

  const send = useCallback((command: CommandWithoutId, expected: ServerMessage["type"] = "ack") => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("地图服务尚未连接。"));
    const requestId = createClientId();
    return new Promise<ServerMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        waitersRef.current.delete(requestId);
        reject(new Error("地图服务响应超时。"));
      }, 8000);
      waitersRef.current.set(requestId, { expected, resolve, reject, timer });
      socket.send(JSON.stringify({ ...command, requestId }));
    });
  }, []);

  const loadRouteTargets = useCallback(async (targetLayerId: string, query = "") => {
    if (!connected) return;
    try {
      const message = await send({
        type: "map.locations.search", layerId: targetLayerId, query, limit: 200,
      }, "map.locations.result");
      if (message.type !== "map.locations.result") throw new Error("地点搜索响应不正确。");
      setRouteTargets(message.locations);
      setRouteTarget((current) => message.locations.some((location) => location.id === current) ? current : "");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "地点搜索失败。");
    }
  }, [connected, send]);

  const requestViewport = useCallback(() => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const params = viewportParamsRef.current;
    socket.send(JSON.stringify({
      type: "map.viewport.subscribe",
      requestId: createClientId(),
      layerId: params.layerId,
      centerChunkX: params.centerChunk.x,
      centerChunkY: params.centerChunk.y,
      radius: params.radius,
      zoom: params.zoom,
    }));
  }, []);

  useEffect(() => {
    let disposed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const waiters = waitersRef.current;
    const connect = () => {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
      socketRef.current = socket;
      socket.addEventListener("open", () => {
        if (disposed) return;
        setConnected(true);
        const params = viewportParamsRef.current;
        socket.send(JSON.stringify({
          type: "map.viewport.subscribe",
          requestId: createClientId(),
          layerId: params.layerId,
          centerChunkX: params.centerChunk.x,
          centerChunkY: params.centerChunk.y,
          radius: params.radius,
          zoom: params.zoom,
        }));
      });
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(event.data) as ServerMessage;
        if (message.type === "map.viewport.snapshot") {
          setViewport(message.viewport);
          setLocks(message.locks);
        }
        if (message.type === "map.locks.updated") setLocks(message.locks);
        if (message.type === "map.edit.session") setSession(message.session);
        if (message.type === "map.history.state") {
          setSession((current) => current ? { ...current, history: message.history } : current);
        }
        if (message.type === "map.chunks.invalidated") {
          const params = viewportParamsRef.current;
          socket.send(JSON.stringify({
            type: "map.viewport.subscribe",
            requestId: createClientId(),
            layerId: params.layerId,
            centerChunkX: params.centerChunk.x,
            centerChunkY: params.centerChunk.y,
            radius: params.radius,
            zoom: params.zoom,
          }));
        }
        const requestId = "requestId" in message ? message.requestId : undefined;
        if (message.type === "error" && requestId) {
          const waiter = waitersRef.current.get(requestId);
          if (waiter) {
            clearTimeout(waiter.timer);
            waitersRef.current.delete(requestId);
            waiter.reject(new Error(message.message));
          }
          setNotice(message.message);
          return;
        }
        if (requestId) {
          const waiter = waitersRef.current.get(requestId);
          if (waiter && waiter.expected === message.type) {
            clearTimeout(waiter.timer);
            waitersRef.current.delete(requestId);
            waiter.resolve(message);
          }
        }
        if (message.type === "ack" && message.message) setNotice(message.message);
      });
      socket.addEventListener("close", () => {
        setConnected(false);
        if (!disposed) retry = setTimeout(connect, 1500);
      });
    };
    connect();
    return () => {
      disposed = true;
      if (retry) clearTimeout(retry);
      socketRef.current?.close();
      for (const waiter of waiters.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("连接已关闭。"));
      }
      waiters.clear();
    };
  }, []); // Initial socket owns subsequent viewport refreshes through refs.

  useEffect(() => {
    requestViewport();
  }, [centerChunk, layerId, radius, requestViewport, zoom]);

  useEffect(() => {
    if (!session) return;
    const timer = setInterval(() => {
      send({ type: "map.lock.renew", sessionId: session.id }, "map.edit.session").catch((error) => setNotice(error.message));
    }, 30_000);
    return () => clearInterval(timer);
  }, [send, session]);

  const acquireScopes = async (scopes: string[]) => {
    const missing = scopes.filter((scope) => !session?.scopes.includes(scope));
    if (missing.length === 0 && session) return session;
    const message = await send({
      type: "map.lock.acquire",
      scopes: missing.length > 0 ? missing : scopes,
      sessionId: session?.id,
    }, "map.edit.session");
    if (message.type !== "map.edit.session") throw new Error("未能获取编辑锁。");
    return message.session;
  };

  const applyOperation = async (operation: MapEditOperation, scopes: string[]) => {
    try {
      const activeSession = await acquireScopes(scopes);
      await send({ type: "map.edit", sessionId: activeSession.id, operation });
      requestViewport();
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "地图操作失败。");
      return false;
    }
  };

  const worldPoint = (clientX: number, clientY: number, svg: SVGSVGElement) => {
    const rect = svg.getBoundingClientRect();
    return {
      x: viewX + ((clientX - rect.left) / rect.width) * worldWidth,
      y: viewY + ((clientY - rect.top) / rect.height) * worldHeight,
    };
  };

  const regionAt = (x: number, y: number) => viewport.regions.find((region) =>
    x >= region.x && x <= region.x + region.width && y >= region.y && y <= region.y + region.height,
  ) ?? null;

  const onDrop = async (event: DragEvent<SVGSVGElement>) => {
    event.preventDefault();
    const tool = event.dataTransfer.getData("application/x-map-tool");
    if (tool !== "location" && tool !== "region") return;
    const point = worldPoint(event.clientX, event.clientY, event.currentTarget);
    if (tool === "region") {
      const region: MapRegion = {
        id: createClientId("region"),
        layerId,
        name: `新区域 ${viewport.regions.length + 1}`,
        description: "新建的大区域。",
        x: Math.round(point.x / 40) * 40,
        y: Math.round(point.y / 40) * 40,
        width: 320,
        height: 240,
        version: 1,
      };
      const scope = `layer:${layerId}:chunk:${chunkKey(Math.floor(region.x / 1000), Math.floor(region.y / 1000))}`;
      await applyOperation({ type: "region.create", region }, [scope]);
      setSelectedRegionId(region.id);
      return;
    }
    const grid = worldToGridPosition(point.x, point.y);
    const region = regionAt(point.x, point.y);
    const scope = scopeForPoint(layerId, region?.id ?? null, grid.gridX, grid.gridY);
    const id = createClientId("location");
    await applyOperation({
      type: "location.create",
      location: {
        id,
        layerId,
        name: `新地点 ${viewport.locations.length + 1}`,
        description: "通过拖拽创建的地点。",
        regionId: region?.id ?? null,
        gridX: grid.gridX,
        gridY: grid.gridY,
      },
    }, [scope]);
    setSelectedLocationId(id);
  };

  const startDrag = (event: ReactPointerEvent<SVGGElement>, state: DragState) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = state;
  };

  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const point = worldPoint(event.clientX, event.clientY, event.currentTarget);
    if (drag.kind === "location") {
      const grid = worldToGridPosition(point.x, point.y);
      setViewport((current) => ({
        ...current,
        locations: current.locations.map((item) => item.id === drag.id
          ? { ...item, gridX: grid.gridX, gridY: grid.gridY, x: grid.gridX * 160, y: grid.gridY * 160 }
          : item),
      }));
    } else if (drag.kind === "region") {
      setViewport((current) => ({
        ...current,
        regions: current.regions.map((item) => item.id === drag.id
          ? { ...item, x: Math.round((point.x - drag.offsetX) / 40) * 40, y: Math.round((point.y - drag.offsetY) / 40) * 40 }
          : item),
      }));
    } else {
      setViewport((current) => ({
        ...current,
        regions: current.regions.map((item) => item.id === drag.id
          ? { ...item, width: Math.max(160, point.x - item.x), height: Math.max(160, point.y - item.y) }
          : item),
      }));
    }
  };

  const onPointerUp = async () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    if (drag.kind === "location") {
      const location = viewport.locations.find((item) => item.id === drag.id);
      if (!location) return;
      if (location.gridX === drag.originalGridX && location.gridY === drag.originalGridY) return;
      const region = regionAt(location.x, location.y);
      const scopes = [
        scopeForPoint(location.layerId, drag.originalRegionId, drag.originalGridX, drag.originalGridY),
        scopeForPoint(location.layerId, region?.id ?? null, location.gridX, location.gridY),
      ];
      await applyOperation({
        type: "location.update",
        locationId: location.id,
        patch: { gridX: location.gridX, gridY: location.gridY, regionId: region?.id ?? null },
      }, scopes);
      return;
    }
    const region = viewport.regions.find((item) => item.id === drag.id);
    if (!region) return;
    if (drag.kind === "region" && region.x === drag.originalX && region.y === drag.originalY) return;
    if (drag.kind === "resize" && region.width === drag.startX && region.height === drag.startY) return;
    await applyOperation({
      type: "region.update",
      regionId: region.id,
      patch: { x: region.x, y: region.y, width: region.width, height: region.height },
    }, [`region:${region.id}`]);
  };

  const saveLocation = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedLocation) return;
    const data = new FormData(event.currentTarget);
    await applyOperation({
      type: "location.update",
      locationId: selectedLocation.id,
      expectedVersion: selectedLocation.version,
      patch: {
        name: String(data.get("name")),
        description: String(data.get("description")),
        regionId: String(data.get("regionId") || "") || null,
      },
    }, [scopeForPoint(selectedLocation.layerId, selectedLocation.regionId, selectedLocation.gridX, selectedLocation.gridY)]);
  };

  const saveRegion = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedRegion) return;
    const data = new FormData(event.currentTarget);
    await applyOperation({
      type: "region.update",
      regionId: selectedRegion.id,
      expectedVersion: selectedRegion.version,
      patch: { name: String(data.get("name")), description: String(data.get("description")) },
    }, [`region:${selectedRegion.id}`]);
  };

  const createLayer = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const id = createClientId("layer");
    const parentLayerId = String(data.get("parentLayerId") || "") || null;
    const created = await applyOperation({
      type: "layer.create",
      layer: {
        id,
        name: String(data.get("name")),
        description: String(data.get("description")),
        parentLayerId,
        version: 1,
      },
    }, [`layer:${parentLayerId ?? "world-root"}`]);
    if (!created) return;
    form.reset();
    setLayerId(id);
    setCenterChunk({ x: 0, y: 0 });
    setSelectedLocationId(null);
    setSelectedRegionId(null);
  };

  const saveLayer = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await applyOperation({
      type: "layer.update",
      layerId: selectedLayer.id,
      expectedVersion: selectedLayer.version,
      patch: {
        name: String(data.get("name")),
        description: String(data.get("description")),
        parentLayerId: String(data.get("parentLayerId") || "") || null,
      },
    }, [`layer:${selectedLayer.id}`]);
  };

  const deleteLayer = async () => {
    const nextLayerId = selectedLayer.parentLayerId ?? "world-root";
    const deleted = await applyOperation(
      { type: "layer.delete", layerId: selectedLayer.id },
      [`layer:${selectedLayer.id}`],
    );
    if (!deleted) return;
    setLayerId(nextLayerId);
    setCenterChunk({ x: 0, y: 0 });
    setSelectedLocationId(null);
    setSelectedRegionId(null);
  };

  const createRoute = async () => {
    if (!selectedLocation || !routeTarget) return;
    const target = routeLocationMap.get(routeTarget);
    if (!target) return;
    await applyOperation({
      type: "route.create",
      fromLocation: selectedLocation.id,
      toLocation: target.id,
      routeType,
      transitionKind: routeType === "transition" ? transitionKind : undefined,
    }, [
      scopeForPoint(selectedLocation.layerId, selectedLocation.regionId, selectedLocation.gridX, selectedLocation.gridY),
      scopeForPoint(target.layerId, target.regionId, target.gridX, target.gridY),
    ]);
  };

  const changeRouteType = async (nextType: RouteType) => {
    setRouteType(nextType);
    setRouteTarget("");
    if (nextType === "normal") {
      setRouteTargetLayerId(layerId);
      return;
    }
    const targetLayer = viewport.layers.find((layer) => layer.id !== layerId)?.id ?? layerId;
    setRouteTargetLayerId(targetLayer);
    setRouteTargets([]);
    await loadRouteTargets(targetLayer, routeSearch);
  };

  const changeRouteTargetLayer = async (targetLayerId: string) => {
    setRouteTargetLayerId(targetLayerId);
    setRouteTarget("");
    setRouteTargets([]);
    await loadRouteTargets(targetLayerId, routeSearch);
  };

  const finishEditing = async () => {
    if (!session) return;
    try {
      await send({ type: "map.lock.release", sessionId: session.id });
      setSession(null);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "释放锁失败。");
    }
  };

  const gridLines = useMemo(() => {
    const lines: Array<{ vertical: boolean; value: number }> = [];
    for (let x = Math.floor(viewX / 160) * 160; x <= viewX + worldWidth; x += 160) lines.push({ vertical: true, value: x });
    for (let y = Math.floor(viewY / 160) * 160; y <= viewY + worldHeight; y += 160) lines.push({ vertical: false, value: y });
    return lines;
  }, [viewX, viewY, worldHeight, worldWidth]);

  return (
    <main className="map-editor-shell">
      <header className="editor-header">
        <div>
          <h1>地图设计工具</h1>
          <p>连续大地图使用八方向道路 · 仅室内或特殊空间使用入口连接 · 所有改动自动保存</p>
        </div>
        <div className="editor-header-actions">
          <span>{player.name} · {connected ? "已连接" : "连接中"}</span>
          <Link href="/">返回游戏</Link>
          <button disabled={!session?.history.canUndo} onClick={() => session && send({ type: "map.history.undo", sessionId: session.id }).catch((error) => setNotice(error.message))}>撤销</button>
          <button disabled={!session?.history.canRedo} onClick={() => session && send({ type: "map.history.redo", sessionId: session.id }).catch((error) => setNotice(error.message))}>重做</button>
          <button disabled={!session} onClick={finishEditing}>完成编辑</button>
        </div>
      </header>

      <aside className="editor-tools bordered-box">
        <h2>地图范围</h2>
        <p className="editor-tools-note">大宋与帕洛斯都属于“八方世界”；住宅楼层是独立室内地图。</p>
        <label>当前地图
          <select value={layerId} onChange={(event) => {
            const nextLayerId = event.target.value;
            setLayerId(nextLayerId);
            setCenterChunk({ x: 0, y: 0 });
            setSelectedLocationId(null);
            setSelectedRegionId(null);
            setRouteType("normal");
            setRouteTarget("");
            setRouteTargetLayerId(nextLayerId);
          }}>
            {viewport.layers.map((layer) => <option key={layer.id} value={layer.id}>{layerLabel(layer, viewport.layers)}</option>)}
          </select>
        </label>
        <details className="layer-editor" open>
          <summary>编辑当前层</summary>
          <form key={`${selectedLayer.id}-${selectedLayer.version}`} onSubmit={saveLayer}>
            <label>地图层名称<input name="name" defaultValue={selectedLayer.name} /></label>
            <label>地图层描述<textarea name="description" defaultValue={selectedLayer.description} /></label>
            <label>父地图层
              <select name="parentLayerId" defaultValue={selectedLayer.parentLayerId ?? ""} disabled={selectedLayer.id === "world-root"}>
                <option value="">无父层</option>
                {viewport.layers.filter((layer) => layer.id !== selectedLayer.id).map((layer) => (
                  <option key={layer.id} value={layer.id}>{layerLabel(layer, viewport.layers)}</option>
                ))}
              </select>
            </label>
            <button>保存地图层</button>
            <button
              type="button"
              disabled={["world-root", "home-ground", "song-overview", "palos-overview"].includes(selectedLayer.id)}
              onClick={deleteLayer}
            >删除空地图层</button>
          </form>
        </details>
        <details className="layer-editor">
          <summary>新增地图层</summary>
          <form onSubmit={createLayer}>
            <label>新层名称<input name="name" defaultValue="新地图层" /></label>
            <label>新层描述<textarea name="description" defaultValue="通过地图设计工具新增的地图层。" /></label>
            <label>放在此层之下
              <select name="parentLayerId" defaultValue={selectedLayer.id}>
                {viewport.layers.map((layer) => <option key={layer.id} value={layer.id}>{layerLabel(layer, viewport.layers)}</option>)}
              </select>
            </label>
            <button>新增地图层</button>
          </form>
        </details>
        <h2>拖拽素材</h2>
        <div className="palette-item" draggable onDragStart={(event) => event.dataTransfer.setData("application/x-map-tool", "region")}>大区域</div>
        <div className="palette-item" draggable onDragStart={(event) => event.dataTransfer.setData("application/x-map-tool", "location")}>小地点</div>
        <h2>视口区块</h2>
        <label>预加载
          <select value={radius} onChange={(event) => setRadius(Number(event.target.value))}>
            <option value={1}>9 区块</option>
            <option value={2}>25 区块</option>
            <option value={3}>49 区块</option>
          </select>
        </label>
        <label>缩放
          <input type="range" min="0.3" max="2" step="0.1" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} />
        </label>
        <div className="pan-controls">
          <button onClick={() => setCenterChunk((item) => ({ ...item, y: item.y - 1 }))}>上</button>
          <button onClick={() => setCenterChunk((item) => ({ ...item, x: item.x - 1 }))}>左</button>
          <button onClick={() => setCenterChunk((item) => ({ ...item, x: item.x + 1 }))}>右</button>
          <button onClick={() => setCenterChunk((item) => ({ ...item, y: item.y + 1 }))}>下</button>
        </div>
        <p>已加载 {viewport.loadedChunkCount} 区块 / {viewport.locations.length} 地点</p>
        {viewport.truncated && <p className="editor-warning">地点过密，已限制为1200个。</p>}
      </aside>

      <section className="editor-canvas bordered-box" aria-label="地图编辑画布">
        <header className="editor-canvas-status" aria-label="画布信息">
          <div>
            <span>当前地图</span>
            <strong>{selectedLayer.name}</strong>
          </div>
          <p>
            {selectedLocation
              ? `已选地点：${selectedLocation.name} · 网格 (${selectedLocation.gridX}, ${selectedLocation.gridY})`
              : selectedRegion
                ? `已选区域：${selectedRegion.name}`
                : "选择地点或区域后，可在右侧编辑资料。"}
          </p>
          <span>{viewport.loadedChunkCount} 区块 · {viewport.locations.length} 地点 · {Math.round(zoom * 100)}%</span>
        </header>
        <div className="editor-canvas-viewport">
          <svg
            viewBox={viewBox}
            onDragOver={(event) => event.preventDefault()}
            onDrop={onDrop}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          >
          {gridLines.map((line) => line.vertical
            ? <line className="editor-grid-line" key={`x-${line.value}`} x1={line.value} y1={viewY} x2={line.value} y2={viewY + worldHeight} />
            : <line className="editor-grid-line" key={`y-${line.value}`} x1={viewX} y1={line.value} x2={viewX + worldWidth} y2={line.value} />)}
          {zoom < 0.6 && viewport.chunks.map((chunk) => (
            <g className="editor-chunk-summary" key={`${chunk.chunkX}:${chunk.chunkY}`}>
              <rect x={chunk.chunkX * 1000} y={chunk.chunkY * 1000} width="1000" height="1000" />
              <text x={chunk.chunkX * 1000 + 500} y={chunk.chunkY * 1000 + 500} textAnchor="middle">
                {chunk.locationCount} 地点
              </text>
            </g>
          ))}
          {viewport.regions.map((region) => (
            <g
              className={`editor-region ${selectedRegionId === region.id ? "selected" : ""}`}
              key={region.id}
              onClick={() => { setSelectedRegionId(region.id); setSelectedLocationId(null); }}
              onPointerDown={(event) => {
                const point = worldPoint(event.clientX, event.clientY, event.currentTarget.ownerSVGElement!);
                startDrag(event, {
                  kind: "region",
                  id: region.id,
                  offsetX: point.x - region.x,
                  offsetY: point.y - region.y,
                  originalX: region.x,
                  originalY: region.y,
                });
              }}
            >
              <rect x={region.x} y={region.y} width={region.width} height={region.height} />
              <text x={region.x + 12} y={region.y + 24}>{region.name}</text>
              <rect
                className="resize-handle"
                x={region.x + region.width - 16}
                y={region.y + region.height - 16}
                width={16}
                height={16}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  startDrag(event, { kind: "resize", id: region.id, startX: region.width, startY: region.height });
                }}
              />
            </g>
          ))}
          {viewport.routes.map((route) => {
            const from = locationMap.get(route.fromLocation);
            const to = locationMap.get(route.toLocation);
            if (!from || !to) return null;
            return (
              <line className={`editor-route ${route.routeType}`} key={route.id} x1={from.x} y1={from.y} x2={to.x} y2={to.y}>
                <title>{route.routeType === "portal" ? "传送门" : route.fromDirection ? DIRECTION_LABEL[route.fromDirection] : "路线"}</title>
              </line>
            );
          })}
            {viewport.locations.map((location) => (
              <g
                className={`editor-location ${selectedLocationId === location.id ? "selected" : ""}`}
                key={location.id}
                transform={`translate(${location.x} ${location.y})`}
                onClick={() => { setSelectedLocationId(location.id); setSelectedRegionId(null); }}
                onPointerDown={(event) => startDrag(event, {
                  kind: "location",
                  id: location.id,
                  originalRegionId: location.regionId,
                  originalGridX: location.gridX,
                  originalGridY: location.gridY,
                })}
              >
                <rect x="-50" y="-50" width="100" height="100" />
                <foreignObject x="-46" y="-46" width="92" height="92" pointerEvents="none">
                  <div className="editor-location-name">{conciseLocationName(location.name)}</div>
                </foreignObject>
              </g>
            ))}
          </svg>
        </div>
      </section>

      <aside className="editor-inspector bordered-box">
        <h2>属性与连接</h2>
        {selectedLocation && (
          <form key={`${selectedLocation.id}-${selectedLocation.version}`} onSubmit={saveLocation}>
            <div className="editor-selection-summary">
              <span>已选地点</span>
              <strong>{selectedLocation.name}</strong>
              <small>{selectedLocation.region} · 网格 ({selectedLocation.gridX}, {selectedLocation.gridY})</small>
            </div>
            <label>名称<input name="name" defaultValue={selectedLocation.name} /></label>
            <label>描述<textarea name="description" defaultValue={selectedLocation.description} /></label>
            <label>所属大区域
              <select name="regionId" defaultValue={selectedLocation.regionId ?? ""}>
                <option value="">公共区域</option>
                {viewport.regions.map((region) => <option key={region.id} value={region.id}>{region.name}</option>)}
              </select>
            </label>
            <button>保存地点资料</button>
            <button type="button" disabled={selectedLocation.id === "home-entrance"} onClick={() => applyOperation(
              { type: "location.delete", locationId: selectedLocation.id },
              [scopeForPoint(selectedLocation.layerId, selectedLocation.regionId, selectedLocation.gridX, selectedLocation.gridY)],
            )}>删除地点</button>
            <hr />
            <label>路线类型
              <select value={routeType} onChange={(event) => changeRouteType(event.target.value as RouteType)}>
                <option value="normal">八方向普通路线</option>
                <option value="transition">跨层连接</option>
                <option value="portal">传送门</option>
              </select>
            </label>
            {routeType !== "normal" && (
              <>
                <label>目标地图层
                  <select value={routeTargetLayerId} onChange={(event) => changeRouteTargetLayer(event.target.value)}>
                    {viewport.layers
                      .filter((layer) => routeType !== "transition" || layer.id !== selectedLocation.layerId)
                      .map((layer) => <option key={layer.id} value={layer.id}>{layerLabel(layer, viewport.layers)}</option>)}
                  </select>
                </label>
                <label>搜索目标地点
                  <span className="editor-inline-search">
                    <input value={routeSearch} onChange={(event) => setRouteSearch(event.target.value)} placeholder="名称（可留空）" />
                    <button type="button" onClick={() => loadRouteTargets(routeTargetLayerId, routeSearch)}>搜索</button>
                  </span>
                </label>
              </>
            )}
            <label>连接目标
              <select value={routeTarget} onChange={(event) => setRouteTarget(event.target.value)}>
                <option value="">请选择</option>
                {(routeType === "normal" ? viewport.locations : routeTargets)
                  .filter((item) => item.id !== selectedLocation.id)
                  .map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </label>
            {routeType === "transition" && (
              <label>跨层方式
                <select value={transitionKind} onChange={(event) => setTransitionKind(event.target.value as TransitionKind)}>
                  <option value="door">门</option>
                  <option value="stairs">楼梯</option>
                  <option value="elevator">电梯</option>
                  <option value="gate">关门 / 区域入口</option>
                  <option value="road">道路</option>
                  <option value="ferry">渡船</option>
                  <option value="dungeon">地下城入口</option>
                  <option value="fast-travel">快速传送点</option>
                </select>
              </label>
            )}
            <button type="button" disabled={!routeTarget} onClick={createRoute}>建立连接</button>
            <div className="route-list">
              {viewport.routes.filter((route) => route.fromLocation === selectedLocation.id || route.toLocation === selectedLocation.id).map((route) => (
                <button type="button" key={route.id} onClick={() => {
                  const otherId = route.fromLocation === selectedLocation.id ? route.toLocation : route.fromLocation;
                  const other = routeLocationMap.get(otherId);
                  if (!other) return;
                  applyOperation({ type: "route.delete", routeId: route.id }, [
                    scopeForPoint(selectedLocation.layerId, selectedLocation.regionId, selectedLocation.gridX, selectedLocation.gridY),
                    scopeForPoint(other.layerId, other.regionId, other.gridX, other.gridY),
                  ]);
                }}>删除 {route.routeType === "portal" ? "传送门" : route.routeType === "transition" ? "跨层连接" : "路线"} → {routeLocationMap.get(route.fromLocation === selectedLocation.id ? route.toLocation : route.fromLocation)?.name}</button>
              ))}
            </div>
          </form>
        )}
        {selectedRegion && (
          <form key={`${selectedRegion.id}-${selectedRegion.version}`} onSubmit={saveRegion}>
            <div className="editor-selection-summary">
              <span>已选区域</span>
              <strong>{selectedRegion.name}</strong>
              <small>{Math.round(selectedRegion.width)} × {Math.round(selectedRegion.height)}</small>
            </div>
            <label>名称<input name="name" defaultValue={selectedRegion.name} /></label>
            <label>描述<textarea name="description" defaultValue={selectedRegion.description} /></label>
            <button>保存区域资料</button>
            <button type="button" disabled={selectedRegion.id === "home"} onClick={() => applyOperation(
              { type: "region.delete", regionId: selectedRegion.id },
              [`region:${selectedRegion.id}`],
            )}>删除区域</button>
          </form>
        )}
        {!selectedLocation && !selectedRegion && <p>选择地点或大区域进行编辑。</p>}
        <h2>编辑锁</h2>
        {session ? <p>当前持有：{session.scopes.join("、")}</p> : <p>拖拽或保存时自动申请。</p>}
        {locks.map((lock) => <p key={lock.scopeKey}>{lock.scopeKey} · {lock.playerName}</p>)}
      </aside>

      <footer className="editor-status" role="status">{notice}</footer>
    </main>
  );
}
