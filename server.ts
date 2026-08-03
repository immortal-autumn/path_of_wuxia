import { createServer, type IncomingMessage } from "node:http";
import next from "next";
import WebSocket, { WebSocketServer } from "ws";
import { closeGameDatabase } from "./lib/game/database";
import { clientMessageSchema, type ServerMessage } from "./lib/game/protocol";
import { getGameService, SESSION_COOKIE } from "./lib/game/service";
import { worldStatusKey } from "./lib/game/time";

const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.GAME_HOST ?? "0.0.0.0";
const port = Number(process.env.PORT ?? 3000);
const service = getGameService();

type SocketContext = {
  playerId: string;
  alive: boolean;
  visibleLocationIds: Set<string>;
};

function readCookie(request: IncomingMessage, name: string) {
  const cookieHeader = request.headers.cookie;
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return undefined;
}

function isSameOrigin(request: IncomingMessage) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "江湖中起了些波折，请稍后再试。";
}

async function main() {
  const httpServer = createServer();
  const app = next({ dev, hostname, port, httpServer });
  const handle = app.getRequestHandler();
  const sockets = new Map<WebSocket, SocketContext>();
  const chatTimestamps = new Map<string, number>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });

  const onlinePlayerIds = () => [...new Set([...sockets.values()].map((context) => context.playerId))];

  const send = (socket: WebSocket, message: ServerMessage) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };

  const broadcast = (message: ServerMessage) => {
    const payload = JSON.stringify(message);
    for (const socket of sockets.keys()) {
      if (socket.readyState === WebSocket.OPEN) socket.send(payload);
    }
  };

  const broadcastPresence = () => {
    const playerIds = onlinePlayerIds();
    const players = service.getOnlinePlayers(playerIds);
    for (const [socket, context] of sockets) {
      send(socket, {
        type: "players.updated",
        players: players.filter((player) => context.visibleLocationIds.has(player.currentLocation)),
      });
    }
    broadcast({ type: "world.updated", world: service.getWorldStatus(playerIds.length) });
  };

  const sendSnapshot = (socket: WebSocket, context: SocketContext) => {
    const snapshot = service.getSnapshot(context.playerId, onlinePlayerIds());
    context.visibleLocationIds = new Set(snapshot.locations.map((location) => location.id));
    send(socket, { type: "snapshot", snapshot });
  };

  wss.on("connection", (socket, request) => {
    const token = readCookie(request, SESSION_COOKIE);
    const player = service.getPlayerBySessionToken(token);
    if (!player) {
      socket.close(4001, "会话无效");
      return;
    }

    const context: SocketContext = { playerId: player.id, alive: true, visibleLocationIds: new Set() };
    sockets.set(socket, context);
    service.touchPlayers([player.id]);
    sendSnapshot(socket, context);
    broadcastPresence();

    socket.on("pong", () => {
      const context = sockets.get(socket);
      if (context) context.alive = true;
    });

    socket.on("message", (rawMessage) => {
      const context = sockets.get(socket);
      if (!context) return;

      let raw: unknown;
      try {
        raw = JSON.parse(rawMessage.toString());
      } catch {
        send(socket, { type: "error", message: "消息格式不正确。" });
        return;
      }

      const parsed = clientMessageSchema.safeParse(raw);
      if (!parsed.success) {
        send(socket, { type: "error", message: "无法识别这条指令。" });
        return;
      }

      const command = parsed.data;
      try {
        if (command.type === "sync") {
          sendSnapshot(socket, context);
          send(socket, { type: "ack", requestId: command.requestId });
          return;
        }

        if (command.type === "ping") {
          send(socket, { type: "pong", requestId: command.requestId });
          return;
        }

        if (command.type === "map.visited") {
          send(socket, {
            type: "map.visited.snapshot",
            requestId: command.requestId,
            map: service.getVisitedMap(context.playerId),
          });
          return;
        }

        if (command.type === "chat.send") {
          const now = Date.now();
          const lastSentAt = chatTimestamps.get(context.playerId) ?? 0;
          if (now - lastSentAt < 1000) throw new Error("说话太快了，稍候片刻吧。");
          const message = service.sendChat(context.playerId, command.content);
          chatTimestamps.set(context.playerId, now);
          broadcast({ type: "chat.message", message });
          send(socket, { type: "ack", requestId: command.requestId });
          return;
        }

        if (command.type === "map.viewport.subscribe") {
          send(socket, {
            type: "map.viewport.snapshot",
            requestId: command.requestId,
            viewport: service.getMapViewport(
              command.layerId,
              command.centerChunkX,
              command.centerChunkY,
              command.radius,
              command.zoom,
            ),
            locks: service.getActiveLocks(),
          });
          return;
        }

        if (command.type === "map.locations.search") {
          send(socket, {
            type: "map.locations.result",
            requestId: command.requestId,
            layerId: command.layerId,
            locations: service.searchMapLocations(command.layerId, command.query, command.limit),
          });
          return;
        }

        if (command.type === "map.lock.acquire") {
          const session = service.acquireMapLocks(
            context.playerId,
            command.scopes,
            command.sessionId,
          );
          send(socket, { type: "map.edit.session", requestId: command.requestId, session });
          broadcast({ type: "map.locks.updated", locks: service.getActiveLocks() });
          send(socket, { type: "ack", requestId: command.requestId, message: "编辑锁已获取。" });
          return;
        }

        if (command.type === "map.lock.renew") {
          const session = service.renewMapLocks(context.playerId, command.sessionId);
          send(socket, { type: "map.edit.session", requestId: command.requestId, session });
          return;
        }

        if (command.type === "map.lock.release") {
          service.releaseMapLocks(context.playerId, command.sessionId);
          broadcast({ type: "map.locks.updated", locks: service.getActiveLocks() });
          send(socket, { type: "ack", requestId: command.requestId, message: "编辑已完成，锁已释放。" });
          return;
        }

        if (command.type === "map.edit") {
          const result = service.applyMapOperation(context.playerId, command.sessionId, command.operation);
          send(socket, { type: "map.history.state", requestId: command.requestId, history: result.history });
          broadcast({ type: "map.chunks.invalidated", chunkKeys: result.invalidatedChunks });
          send(socket, { type: "ack", requestId: command.requestId, message: "地图改动已自动保存。" });
          return;
        }

        if (command.type === "map.history.undo" || command.type === "map.history.redo") {
          const result = command.type === "map.history.undo"
            ? service.undoMapOperation(context.playerId, command.sessionId)
            : service.redoMapOperation(context.playerId, command.sessionId);
          send(socket, { type: "map.history.state", requestId: command.requestId, history: result.history });
          broadcast({ type: "map.chunks.invalidated", chunkKeys: result.invalidatedChunks });
          send(socket, {
            type: "ack",
            requestId: command.requestId,
            message: command.type === "map.history.undo" ? "已撤销。" : "已重做。",
          });
          return;
        }

        if (command.type === "action.start" || command.type === "action.cancel" || command.type === "action.queue.reorder") {
          const result = command.type === "action.start"
            ? service.startAction(context.playerId, command.actionId)
            : command.type === "action.cancel"
              ? service.cancelAction(context.playerId, command.jobId)
              : service.reorderActionQueue(context.playerId, command.jobIds);
          send(socket, { type: "action.updated", actionState: result.actionState });
          send(socket, { type: "inventory.updated", inventory: service.getInventoryState(context.playerId) });
          send(socket, { type: "self.updated", player: service.getPlayer(context.playerId) });
          send(socket, { type: "ack", requestId: command.requestId, message: result.message });
          return;
        }

        if (command.type === "inventory.equip" || command.type === "inventory.unequip" || command.type === "inventory.use") {
          const result = command.type === "inventory.equip"
            ? service.equipItem(context.playerId, command.itemId)
            : command.type === "inventory.unequip"
              ? service.unequipItem(context.playerId, command.itemId)
              : service.useItem(context.playerId, command.itemId);
          send(socket, { type: "inventory.updated", inventory: result.inventory });
          send(socket, { type: "self.updated", player: result.player });
          send(socket, { type: "ack", requestId: command.requestId, message: result.message });
          return;
        }

        if (command.type === "craft.start" || command.type === "farm.start") {
          const result = command.type === "craft.start"
            ? service.startCraft(context.playerId, command.recipeId)
            : service.startFarmAction(context.playerId, command.plotId, command.operation, command.cropId);
          send(socket, { type: "action.updated", actionState: result.actionState });
          send(socket, { type: "inventory.updated", inventory: result.inventory });
          send(socket, { type: "ack", requestId: command.requestId, message: result.message });
          return;
        }

        if (command.type === "attributes.allocate") {
          const result = service.allocateAttributes(context.playerId, command.allocations);
          send(socket, { type: "self.updated", player: result.player });
          send(socket, { type: "ack", requestId: command.requestId, message: result.message });
          return;
        }

        if (command.type === "cultivation.breakthrough") {
          const result = service.breakthrough(context.playerId);
          send(socket, { type: "self.updated", player: result.self });
          broadcast({ type: "world.event", event: result.event });
          send(socket, { type: "ack", requestId: command.requestId, message: result.message });
          return;
        }

        const mutation =
          command.type === "move"
            ? service.move(context.playerId, command.locationId)
            : service.act(context.playerId, command.actionId);
        send(socket, { type: "self.updated", player: mutation.self });
        broadcast({ type: "world.event", event: mutation.event });
        if (command.type === "move") {
          sendSnapshot(socket, context);
          broadcastPresence();
        }
        send(socket, { type: "ack", requestId: command.requestId, message: mutation.message });
      } catch (error) {
        send(socket, {
          type: "error",
          requestId: "requestId" in command ? command.requestId : undefined,
          message: errorMessage(error),
        });
      }
    });

    socket.on("close", () => {
      sockets.delete(socket);
      broadcastPresence();
    });

    socket.on("error", () => {
      socket.close();
    });
  });

  httpServer.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (url.pathname !== "/ws") return;
    if (!isSameOrigin(request)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (webSocket) => {
      wss.emit("connection", webSocket, request);
    });
  });

  await app.prepare();
  httpServer.on("request", (request, response) => handle(request, response));

  const heartbeat = setInterval(() => {
    const playersToTouch: string[] = [];
    for (const [socket, context] of sockets) {
      if (!context.alive) {
        socket.terminate();
        continue;
      }
      context.alive = false;
      playersToTouch.push(context.playerId);
      socket.ping();
    }
    for (const playerId of new Set(playersToTouch)) {
      const settlement = service.settleCultivation(playerId, false);
      if (settlement.delta <= 0) continue;
      for (const [socket, context] of sockets) {
        if (context.playerId === playerId) {
          send(socket, {
            type: "cultivation.updated",
            player: settlement.player,
            delta: settlement.delta,
            offline: false,
            message: `修炼获得${settlement.delta}点修为。`,
          });
        }
      }
    }
    service.touchPlayers(playersToTouch);
  }, 30_000);

  let previousWorldKey = worldStatusKey(service.getWorldStatus(0));
  const worldClock = setInterval(() => {
    const world = service.getWorldStatus(onlinePlayerIds().length);
    const nextKey = worldStatusKey(world);
    if (nextKey !== previousWorldKey) {
      previousWorldKey = nextKey;
      broadcast({ type: "world.updated", world });
    }
  }, 60_000);

  const actionClock = setInterval(() => {
    for (const playerId of new Set(onlinePlayerIds())) {
      if (service.settleDueActions(playerId) <= 0) continue;
      for (const [socket, context] of sockets) {
        if (context.playerId === playerId) sendSnapshot(socket, context);
      }
    }
  }, 1_000);

  httpServer.listen(port, hostname, () => {
    console.log(`> Path of Wuxia ready at http://${hostname}:${port}`);
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(heartbeat);
    clearInterval(worldClock);
    clearInterval(actionClock);
    for (const socket of sockets.keys()) socket.close(1001, "服务器正在关闭");
    wss.close();
    httpServer.close();
    await app.close();
    closeGameDatabase();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(error);
  closeGameDatabase();
  process.exit(1);
});
