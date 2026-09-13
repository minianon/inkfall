import { DT, INK_MAX, SNAPSHOT_HZ } from "../../shared/src/constants";
import type {
  Phase, PlayerInfo, ScoreRow, ServerMsg, Tool,
} from "../../shared/src/protocol";
import {
  createRunner, respawn, stepRunner, type InputFrame, type RunnerState,
} from "../../shared/src/runner";
import { InkBoard } from "../../shared/src/strokes";
import { Input } from "./input";
import { Net } from "./net";
import { Renderer, type RenderRunner, type RenderView } from "./render";

const SNAP_MS = 1000 / SNAPSHOT_HZ;
/** How fast a mispredicted position slides back to the truth. */
const ERROR_DECAY = 8;
/** A correction bigger than this is a teleport, not a nudge — snap it. */
const SNAP_THRESHOLD = 90;

// ------------------------------------------------------------------ dom
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const canvas = $<HTMLCanvasElement>("canvas");
const overlay = $<HTMLDivElement>("overlay");
const panel = $<HTMLDivElement>("panel");
const toasts = $<HTMLDivElement>("toasts");
const roster = $<HTMLOListElement>("roster");
const rail = $<HTMLDivElement>("rail");
const hint = $<HTMLDivElement>("hint");
const inkFill = $<HTMLDivElement>("ink-fill");
const inkNum = $<HTMLSpanElement>("ink-num");
const roleLabel = $<HTMLSpanElement>("role-label");
const objective = $<HTMLElement>("objective");
const phaseLabel = $<HTMLParagraphElement>("phase-label");
const roomCode = $<HTMLButtonElement>("room-code");
const pingEl = $<HTMLSpanElement>("ping");
const nOut = $<HTMLElement>("n-out");
const nDown = $<HTMLElement>("n-down");
const nClock = $<HTMLElement>("n-clock");
const clockBox = document.querySelector(".t-clock") as HTMLElement;

const toolButtons: Record<Tool, HTMLButtonElement> = {
  ink: $<HTMLButtonElement>("t-ink"),
  spike: $<HTMLButtonElement>("t-spike"),
  erase: $<HTMLButtonElement>("t-erase"),
};

// ------------------------------------------------------------------ state
const board = new InkBoard();
const renderer = new Renderer(canvas);
const net = new Net();

let you = "";
let joined = false;
let phase: Phase = "lobby";
let drawerId: string | null = null;
let roundIndex = 0;
let totalRounds = 0;
let phaseEndsAt = 0;
let hostId: string | null = null;

const players = new Map<string, PlayerInfo>();
let lastScores: { rows: ScoreRow[]; escaped: number; downed: number; wipe: boolean } | null = null;

let escaped = 0;
let downed = 0;

/** Locally predicted copy of your own runner. */
let local: RunnerState = createRunner();
let seq = 0;
const pending: InputFrame[] = [];
let localStalled = false;
const errorOffset = { x: 0, y: 0 };

interface Remote {
  fromX: number; fromY: number;
  toX: number; toY: number;
  t0: number;
  status: RunnerState["status"];
  facing: 1 | -1;
}
const remotes = new Map<string, Remote>();

/** The drawer's cursor as relayed to everyone else. */
let remotePen: { x: number; y: number; tool: Tool; at: number } | null = null;

const youAreDrawer = () => joined && drawerId === you;

// ------------------------------------------------------------------ input
let lastEraseX = -999;
let lastEraseY = -999;

const input = new Input(canvas, {
  onDown(x, y) {
    if (input.tool === "erase") {
      applyErase(x, y, true);
      return;
    }
    if (board.begin(input.tool, x, y)) {
      net.send({ t: "pen", op: "begin", kind: input.tool, x, y });
    }
    paintInk();
  },
  onMove(x, y, down) {
    net.send({ t: "cursor", x, y, tool: input.tool });
    if (!down) return;
    if (input.tool === "erase") {
      applyErase(x, y, false);
      return;
    }
    const p = board.extend(x, y);
    if (p) net.send({ t: "pen", op: "point", x: p.x, y: p.y });
    paintInk();
  },
  onUp() {
    if (input.tool !== "erase") {
      board.end();
      net.send({ t: "pen", op: "end" });
    }
    paintInk();
  },
});

function applyErase(x: number, y: number, force: boolean): void {
  // One erase per ~8px of travel is plenty, and keeps the wire quiet.
  if (!force && Math.hypot(x - lastEraseX, y - lastEraseY) < 8) return;
  lastEraseX = x;
  lastEraseY = y;
  board.erase(x, y);
  net.send({ t: "pen", op: "erase", x, y });
  paintInk();
}

input.onToolChange = (tool) => {
  for (const [name, btn] of Object.entries(toolButtons)) {
    btn.setAttribute("aria-pressed", String(name === tool));
  }
};
for (const [name, btn] of Object.entries(toolButtons)) {
  btn.addEventListener("click", () => input.setTool(name as Tool));
}

roomCode.addEventListener("click", async () => {
  const url = `${location.origin}/#${roomCode.textContent?.trim() ?? ""}`;
  try {
    await navigator.clipboard.writeText(url);
    toast("Invite link copied");
  } catch {
    toast(url);
  }
});

// ------------------------------------------------------------------ network
net.onStatus = (up) => {
  if (!up) {
    phaseLabel.textContent = "Reconnecting";
    toast("Connection lost — retrying", "warn");
  }
};

net.onMessage = (msg: ServerMsg) => {
  switch (msg.t) {
    case "welcome":
      you = msg.you;
      joined = true;
      roomCode.textContent = msg.room;
      location.hash = msg.room;
      break;

    case "lobby":
      players.clear();
      for (const p of msg.players) players.set(p.id, p);
      hostId = msg.hostId;
      paintRoster();
      paintPanel();
      break;

    case "phase": {
      const changed = msg.phase !== phase || msg.roundIndex !== roundIndex;
      phase = msg.phase;
      drawerId = msg.drawerId;
      roundIndex = msg.roundIndex;
      totalRounds = msg.totalRounds;
      phaseEndsAt = performance.now() + msg.endsInMs;
      if (changed && (phase === "prep" || phase === "lobby")) {
        escaped = 0;
        downed = 0;
        renderer.clearFx();
        remotes.clear();
        respawn(local);
        pending.length = 0;
      }
      input.canDraw = youAreDrawer() && (phase === "prep" || phase === "round");
      canvas.classList.toggle("drawing", input.canDraw);
      paintChrome();
      paintPanel();
      break;
    }

    case "board":
      board.load(msg.strokes);
      paintInk();
      break;

    case "penBegin":
      board.begin(msg.kind, msg.x, msg.y, msg.id);
      paintInk();
      break;

    case "penPoint":
      board.extend(msg.x, msg.y);
      paintInk();
      break;

    case "penEnd":
      board.end();
      paintInk();
      break;

    case "penErase":
      if (!youAreDrawer()) board.erase(msg.x, msg.y);
      paintInk();
      break;

    case "snap":
      applySnapshot(msg.runners);
      break;

    case "cursor":
      remotePen = { x: msg.x, y: msg.y, tool: msg.tool, at: performance.now() };
      break;

    case "fx": {
      const p = players.get(msg.id);
      const colour = p?.colour ?? "#fff";
      if (msg.kind === "down") {
        downed++;
        renderer.burst(msg.x, msg.y, colour, 18);
        renderer.pop(msg.x, msg.y - 20, "+100", "#FF4D6D");
      } else {
        escaped++;
        renderer.burst(msg.x, msg.y, "#FFC14D", 20);
        renderer.pop(msg.x, msg.y - 24, "OUT", "#FFC14D");
      }
      paintChrome();
      break;
    }

    case "scores":
      lastScores = { rows: msg.rows, escaped: msg.escaped, downed: msg.downed, wipe: msg.wipe };
      for (const row of msg.rows) {
        const p = players.get(row.id);
        if (p) p.score = row.score;
      }
      paintRoster();
      break;

    case "toast":
      toast(msg.text, msg.tone);
      break;
  }
};

function applySnapshot(runners: Extract<ServerMsg, { t: "snap" }>["runners"]): void {
  const now = performance.now();
  const seen = new Set<string>();

  for (const w of runners) {
    seen.add(w.i);
    const status: RunnerState["status"] = w.st === 0 ? "alive" : w.st === 1 ? "down" : "out";

    if (w.i === you) {
      reconcile(w, status);
      continue;
    }

    let r = remotes.get(w.i);
    if (!r) {
      r = { fromX: w.x, fromY: w.y, toX: w.x, toY: w.y, t0: now, status, facing: 1 };
      remotes.set(w.i, r);
    }
    const lerped = lerpRemote(r, now);
    r.fromX = status === "alive" && r.status === "alive" ? lerped.x : w.x;
    r.fromY = status === "alive" && r.status === "alive" ? lerped.y : w.y;
    if (w.x > r.toX + 0.5) r.facing = 1;
    else if (w.x < r.toX - 0.5) r.facing = -1;
    r.toX = w.x;
    r.toY = w.y;
    r.t0 = now;
    r.status = status;
  }

  for (const id of [...remotes.keys()]) {
    if (!seen.has(id)) remotes.delete(id);
  }
}

function reconcile(w: Extract<ServerMsg, { t: "snap" }>["runners"][number], status: RunnerState["status"]): void {
  const beforeX = local.x;
  const beforeY = local.y;

  local.x = w.x;
  local.y = w.y;
  local.vx = w.vx;
  local.vy = w.vy;
  local.onGround = w.g === 1;
  local.status = status;
  localStalled = false;

  while (pending.length && pending[0].seq <= w.s) pending.shift();
  if (status === "alive") {
    for (const frame of pending) stepRunner(local, frame, board.segs);
  } else {
    pending.length = 0;
  }

  const dx = beforeX - local.x;
  const dy = beforeY - local.y;
  if (Math.hypot(dx, dy) < SNAP_THRESHOLD) {
    errorOffset.x = dx;
    errorOffset.y = dy;
  } else {
    errorOffset.x = 0;
    errorOffset.y = 0;
  }
}

function lerpRemote(r: Remote, now: number): { x: number; y: number } {
  const t = Math.min(1, (now - r.t0) / SNAP_MS);
  return { x: r.fromX + (r.toX - r.fromX) * t, y: r.fromY + (r.toY - r.fromY) * t };
}

// ------------------------------------------------------------------ loop
let acc = 0;
let last = performance.now();

function frame(now: number): void {
  let dt = (now - last) / 1000;
  last = now;
  if (dt > 0.25) dt = 0.25;

  acc += dt;
  let guard = 5;
  while (acc >= DT && guard-- > 0) {
    tick();
    acc -= DT;
  }

  errorOffset.x -= errorOffset.x * Math.min(1, ERROR_DECAY * dt);
  errorOffset.y -= errorOffset.y * Math.min(1, ERROR_DECAY * dt);

  renderer.draw(buildView(now), dt);
  paintClock(now);
  pingEl.textContent = `${net.rtt} ms`;
  requestAnimationFrame(frame);
}

function tick(): void {
  if (!joined || youAreDrawer() || phase !== "round") return;

  seq++;
  const f: InputFrame = { seq, left: input.left, right: input.right, jump: input.jump };
  net.send({ t: "input", seq, l: f.left ? 1 : 0, r: f.right ? 1 : 0, j: f.jump ? 1 : 0 });

  if (local.status !== "alive") return;
  pending.push(f);
  if (pending.length > 60) pending.shift();

  if (!localStalled) {
    // The server decides who dies; prediction just stops guessing at that point.
    const event = stepRunner(local, f, board.segs);
    if (event) localStalled = true;
  }
}

function buildView(now: number): RenderView {
  const runners: RenderRunner[] = [];

  for (const [id, p] of players) {
    if (id === drawerId) continue;

    if (id === you) {
      runners.push({
        id, colour: p.colour, name: p.name, isYou: true,
        x: local.x + errorOffset.x,
        y: local.y + errorOffset.y,
        status: local.status,
        facing: local.facing,
      });
      continue;
    }

    const r = remotes.get(id);
    if (!r) continue;
    const pos = lerpRemote(r, now);
    runners.push({
      id, colour: p.colour, name: p.name, isYou: false,
      x: pos.x, y: pos.y, status: r.status, facing: r.facing,
    });
  }

  let pen: RenderView["pen"] = null;
  const drawer = drawerId ? players.get(drawerId) : null;
  if (drawer && (phase === "prep" || phase === "round")) {
    if (youAreDrawer() && input.penVisible) {
      pen = { x: input.penX, y: input.penY, tool: input.tool, colour: drawer.colour, name: drawer.name, isYou: true };
    } else if (remotePen && now - remotePen.at < 1400) {
      pen = { x: remotePen.x, y: remotePen.y, tool: remotePen.tool, colour: drawer.colour, name: drawer.name, isYou: false };
    }
  }

  return { board, runners, pen, phase, youAreDrawer: youAreDrawer() };
}

// ------------------------------------------------------------------ chrome
function paintInk(): void {
  const left = board.inkLeft;
  const pct = (left / INK_MAX) * 100;
  inkFill.style.width = `${pct}%`;
  inkFill.classList.toggle("low", pct < 22);
  inkNum.textContent = String(Math.round(left));
}

function paintChrome(): void {
  nOut.textContent = String(escaped);
  nDown.textContent = String(downed);

  const drawing = youAreDrawer();
  rail.hidden = !drawing || (phase !== "prep" && phase !== "round");
  hint.hidden = drawing || (phase !== "prep" && phase !== "round");

  if (phase === "lobby") phaseLabel.textContent = "Lobby";
  else if (phase === "final") phaseLabel.textContent = "Match over";
  else phaseLabel.textContent = `Round ${roundIndex + 1} of ${totalRounds}`;

  if (drawing) {
    roleLabel.textContent = phase === "prep" ? "You hold the pen — build" : "You hold the pen";
    objective.textContent = "Let one through. Kill the rest.";
  } else if (phase === "prep") {
    const drawer = drawerId ? players.get(drawerId) : null;
    roleLabel.textContent = "Runner";
    objective.textContent = drawer ? `${drawer.name} is drawing…` : "Level incoming…";
  } else if (phase === "round") {
    roleLabel.textContent = "Runner";
    objective.textContent = "Reach the exit. Trust nothing.";
  } else {
    roleLabel.textContent = "Waiting";
    objective.textContent = "Next round shortly";
  }
  paintRoster();
}

function paintClock(now: number): void {
  if (phase !== "prep" && phase !== "round" && phase !== "intermission") {
    nClock.textContent = "--";
    clockBox.classList.remove("urgent");
    return;
  }
  const left = Math.max(0, (phaseEndsAt - now) / 1000);
  nClock.textContent = String(Math.ceil(left));
  clockBox.classList.toggle("urgent", phase === "round" && left <= 10);
}

function paintRoster(): void {
  roster.replaceChildren();
  const rows = [...players.values()].sort((a, b) => b.score - a.score);
  for (const p of rows) {
    const li = document.createElement("li");
    if (p.id === drawerId) li.classList.add("drawer");
    if (p.id === you) li.classList.add("you");
    li.innerHTML = `
      <span class="dot" style="background:${p.colour}"></span>
      <span class="nm">${escapeHtml(p.name)}${p.id === drawerId ? ' <span class="pen">PEN</span>' : ""}</span>
      <span class="sc">${p.score}</span>`;
    roster.appendChild(li);
  }
}

function paintPanel(): void {
  if (!joined) return renderJoin();

  if (phase === "lobby") return renderWaiting();
  if (phase === "intermission") return renderScores(false);
  if (phase === "final") return renderScores(true);

  overlay.hidden = true;
}

function renderJoin(): void {
  overlay.hidden = false;
  const suggested = location.hash.replace("#", "").toUpperCase().slice(0, 4);
  panel.innerHTML = `
    <h2>ONE DRAWS.<br>EVERYONE ELSE RUNS.</h2>
    <p>Enter a room code to play with friends, or leave it blank for a public room.</p>
    <div class="fields">
      <input id="f-name" maxlength="14" placeholder="Your name" value="${escapeHtml(savedName())}">
      <input id="f-code" class="code" maxlength="4" placeholder="Code" value="${escapeHtml(suggested)}">
    </div>
    <button id="f-go">Join a room</button>`;

  const nameEl = $<HTMLInputElement>("f-name");
  const codeEl = $<HTMLInputElement>("f-code");
  const go = () => {
    const name = nameEl.value.trim() || "runner";
    localStorage.setItem("inkfall:name", name);
    net.connect(codeEl.value.trim().toUpperCase(), name);
    $<HTMLButtonElement>("f-go").disabled = true;
  };
  $<HTMLButtonElement>("f-go").addEventListener("click", go);
  for (const el of [nameEl, codeEl]) {
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") go();
    });
  }
}

function renderWaiting(): void {
  overlay.hidden = false;
  const isHost = you === hostId;
  const count = players.size;
  panel.innerHTML = `
    <h2>ROOM ${escapeHtml(roomCode.textContent ?? "")}</h2>
    <p>${count} ${count === 1 ? "player" : "players"} here · everyone gets one turn with the pen</p>
    <div class="scores">${players.size ? [...players.values()].map((p) => scoreRowHtml(p)).join("") : ""}</div>
    ${isHost
      ? `<button id="f-start"${count < 2 ? " disabled" : ""}>${count < 2 ? "Waiting for one more" : "Start match"}</button>`
      : `<p>Waiting for the host to start…</p>`}
    <p>Share the code above — anyone with it drops straight in.</p>`;

  document.getElementById("f-start")?.addEventListener("click", () => net.send({ t: "start" }));
}

function renderScores(final: boolean): void {
  overlay.hidden = false;
  const s = lastScores;
  const rows = s?.rows ?? [...players.values()].map((p) => ({ ...p, delta: 0 }));
  const winner = rows[0];

  let headline: string;
  let cls = "";
  if (final) {
    headline = winner ? `${winner.name.toUpperCase()} WINS` : "MATCH OVER";
    cls = "good";
  } else if (s?.wipe) {
    headline = "TOTAL WIPE";
    cls = "bad";
  } else if (s?.escaped === 1) {
    headline = "CLEAN ROUND";
    cls = "good";
  } else {
    headline = "ROUND OVER";
  }

  const sub = final
    ? `${rows.length} players · ${totalRounds} rounds`
    : s?.wipe
      ? "Nobody made it out. <em>A wall isn't a level.</em>"
      : `${s?.downed ?? 0} dropped · ${s?.escaped ?? 0} escaped`;

  panel.innerHTML = `
    <h2 class="${cls}">${escapeHtml(headline)}</h2>
    <p>${sub}</p>
    <div class="scores">${rows.map((r) => scoreRowHtml(r, "delta" in r ? r.delta : 0)).join("")}</div>
    ${final && you === hostId ? `<button id="f-again">Play again</button>` : ""}`;

  document.getElementById("f-again")?.addEventListener("click", () => net.send({ t: "start" }));
}

function scoreRowHtml(p: { id: string; name: string; colour: string; score: number }, delta = 0): string {
  return `<div class="row${p.id === you ? " you" : ""}">
    <span class="dot" style="background:${p.colour}"></span>
    <span class="nm">${escapeHtml(p.name)}</span>
    <span class="dl${delta ? "" : " zero"}">${delta ? `+${delta}` : "—"}</span>
    <span class="sc">${p.score}</span>
  </div>`;
}

function toast(text: string, tone?: "info" | "warn"): void {
  const el = document.createElement("div");
  el.className = `toast${tone === "warn" ? " warn" : ""}`;
  el.textContent = text;
  toasts.appendChild(el);
  setTimeout(() => el.remove(), 3200);
  while (toasts.children.length > 4) toasts.firstChild?.remove();
}

function savedName(): string {
  return localStorage.getItem("inkfall:name") ?? "";
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

// ------------------------------------------------------------------ boot
paintInk();
paintChrome();
renderJoin();
requestAnimationFrame(frame);
