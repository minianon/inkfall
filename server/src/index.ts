import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { TICK_HZ } from "../../shared/src/constants";
import { decode, type ClientMsg } from "../../shared/src/protocol";
import { Room } from "./room";

// Deliberately not the generic PORT: the dev harness sets that to the client port.
const PORT = Number(process.env.GAME_PORT ?? 8787);
const DIST = join(process.cwd(), "client", "dist");

const rooms = new Map<string, Room>();

function makeCode(): string {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I/O, they read as 1/0
  let code = "";
  do {
    code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function getRoom(requested: string): Room {
  const code = requested.trim().toUpperCase().slice(0, 4);

  if (code) {
    let room = rooms.get(code);
    if (!room) {
      room = new Room(code, () => rooms.delete(code));
      rooms.set(code, room);
    }
    return room;
  }

  // No code given: drop into any room with space, otherwise open a new one.
  for (const room of rooms.values()) {
    if (!room.isFull) return room;
  }
  const fresh = makeCode();
  const room = new Room(fresh, () => rooms.delete(fresh));
  rooms.set(fresh, room);
  return room;
}

// ---------------------------------------------------------------- http
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

const http = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }

  // In production the built client is served from here; in dev Vite does it.
  if (!existsSync(DIST)) {
    res.writeHead(404).end("Run the client with `npm run dev:client`.");
    return;
  }
  const urlPath = (req.url ?? "/").split("?")[0];
  const rel = normalize(urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, ""));
  if (rel.startsWith("..")) {
    res.writeHead(403).end("nope");
    return;
  }
  const file = join(DIST, rel);
  const target = existsSync(file) ? file : join(DIST, "index.html");
  res.writeHead(200, { "content-type": MIME[extname(target)] ?? "application/octet-stream" });
  res.end(readFileSync(target));
});

// ---------------------------------------------------------------- websocket
const wss = new WebSocketServer({ server: http, path: "/ws" });

let nextId = 1;

wss.on("connection", (ws: WebSocket) => {
  const id = `p${nextId++}`;
  let room: Room | null = null;
  let alive = true;

  ws.on("message", (raw) => {
    const msg = decode<ClientMsg>(raw.toString());
    if (!msg || typeof msg.t !== "string") return;

    if (msg.t === "join") {
      if (room) return;
      room = getRoom(msg.room ?? "");
      if (!room.join(id, msg.name ?? "runner", ws)) {
        ws.send(JSON.stringify({ t: "toast", text: "That room is full", tone: "warn" }));
        ws.close();
        room = null;
      }
      return;
    }

    room?.handle(id, msg);
  });

  ws.on("pong", () => {
    alive = true;
  });

  ws.on("close", () => {
    room?.leave(id);
    room = null;
  });

  ws.on("error", () => {
    room?.leave(id);
    room = null;
  });

  // Drop connections that stop answering rather than simulating ghosts.
  const heartbeat = setInterval(() => {
    if (!alive) {
      clearInterval(heartbeat);
      ws.terminate();
      return;
    }
    alive = false;
    ws.ping();
  }, 15000);
  ws.on("close", () => clearInterval(heartbeat));
});

// ---------------------------------------------------------------- tick loop
const STEP_MS = 1000 / TICK_HZ;
let nextTickAt = Date.now();

setInterval(() => {
  const now = Date.now();
  // Catch up if the loop slipped, but never spiral trying to replay a stall.
  let budget = 5;
  while (now >= nextTickAt && budget-- > 0) {
    for (const room of rooms.values()) room.step();
    nextTickAt += STEP_MS;
  }
  if (budget <= 0) nextTickAt = now + STEP_MS;
}, Math.floor(STEP_MS / 2));

http.listen(PORT, () => {
  console.log(`inkfall · server on :${PORT} · ${TICK_HZ}Hz`);
});
