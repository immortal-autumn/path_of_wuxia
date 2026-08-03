import WebSocket from "ws";

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3000";
const webSocketUrl = baseUrl.replace(/^http/, "ws") + "/ws";

async function createBrowserSession() {
  const response = await fetch(`${baseUrl}/api/session?returnTo=/`, { redirect: "manual" });
  if (response.status < 300 || response.status >= 400) {
    throw new Error(`Session bootstrap returned ${response.status}`);
  }
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) throw new Error("Session bootstrap did not set a cookie");
  return setCookie.split(";", 1)[0];
}

async function connect(cookie) {
  const socket = new WebSocket(webSocketUrl, {
    headers: { Cookie: cookie, Origin: baseUrl },
  });
  const queue = [];
  const waiters = [];

  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    const waiterIndex = waiters.findIndex((waiter) => waiter.predicate(message));
    if (waiterIndex >= 0) {
      const [waiter] = waiters.splice(waiterIndex, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    } else {
      queue.push(message);
    }
  });

  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });

  return {
    socket,
    waitFor(predicate, timeoutMs = 5000) {
      const queuedIndex = queue.findIndex(predicate);
      if (queuedIndex >= 0) return Promise.resolve(queue.splice(queuedIndex, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, reject, timer: undefined };
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error("Timed out waiting for WebSocket message"));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
  };
}

const firstCookie = await createBrowserSession();
const secondCookie = await createBrowserSession();
const first = await connect(firstCookie);
const firstSnapshot = await first.waitFor((message) => message.type === "snapshot");
const second = await connect(secondCookie);
const secondSnapshot = await second.waitFor((message) => message.type === "snapshot");

if (secondSnapshot.snapshot.onlinePlayers.length < 2) {
  throw new Error("Second client did not see both smoke-test players");
}

const chatContent = `联机试音-${Date.now()}`;
first.socket.send(JSON.stringify({ type: "chat.send", requestId: "chat-smoke", content: chatContent }));
const receivedChat = await second.waitFor(
  (message) => message.type === "chat.message" && message.message.content === chatContent,
);
if (receivedChat.message.playerId !== firstSnapshot.snapshot.self.id) {
  throw new Error("Chat message was attributed to the wrong player");
}

first.socket.send(JSON.stringify({ type: "move", requestId: "move-smoke", locationId: "loumen-road" }));
const movedSelf = await first.waitFor(
  (message) => message.type === "self.updated" && message.player.currentLocation === "loumen-road",
);
const observedMove = await second.waitFor(
  (message) =>
    message.type === "players.updated" &&
    message.players.some(
      (player) => player.id === firstSnapshot.snapshot.self.id && player.currentLocation === "loumen-road",
    ),
  7000,
);

console.log(
  JSON.stringify(
    {
      players: [firstSnapshot.snapshot.self.name, secondSnapshot.snapshot.self.name],
      online: secondSnapshot.snapshot.onlinePlayers.length,
      chat: receivedChat.message.content,
      movedTo: movedSelf.player.currentLocation,
      observedBySecondClient: Boolean(observedMove),
    },
    null,
    2,
  ),
);

first.socket.close();
second.socket.close();
