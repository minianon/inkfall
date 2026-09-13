import type { WebSocket } from "ws";
import {
  INTERMISSION_SECONDS, MAX_PLAYERS, MIN_PLAYERS, PREP_SECONDS,
  ROUND_SECONDS, RUNNER_COLORS, SCORE_CLEAN_ROUND, SCORE_ESCAPE,
  SCORE_FIRST_OUT, SCORE_PER_DROP, SNAPSHOT_HZ, TICK_HZ,
} from "../../shared/src/constants";
import type {
  ClientMsg, Phase, PlayerInfo, ScoreRow, ServerMsg, Tool, WireRunner,
} from "../../shared/src/protocol";
import { encode } from "../../shared/src/protocol";
import {
  createRunner, markDown, markOut, NEUTRAL_INPUT, respawn, stepRunner,
  type InputFrame, type RunnerState,
} from "../../shared/src/runner";
import { InkBoard } from "../../shared/src/strokes";

/** Inputs arrive jittery; never let one client bank more than this many ticks. */
const MAX_INPUT_BACKLOG = 8;
/** A full board is re-sent this often to heal any drift from dropped ops. */
const RESYNC_EVERY_TICKS = TICK_HZ * 5;
/** Silence longer than this means the player is gone from the keyboard, not holding a key. */
const INPUT_IDLE_TICKS = 10;
/** A dropped player keeps their seat, name and score this long before the room forgets them. */
const RECONNECT_GRACE_TICKS = TICK_HZ * 45;
/** If the drawer is gone this long mid-round, the round can't continue. */
const DRAWER_ABANDON_TICKS = TICK_HZ * 4;

interface Player {
  id: string;
  name: string;
  colour: string;
  score: number;
  roundDelta: number;
  hasDrawn: boolean;
  connected: boolean;
  ws: WebSocket | null;
  runner: RunnerState;
  queue: InputFrame[];
  lastInput: InputFrame;
  lastSeq: number;
  /** Ticks since an input actually arrived. */
  idleTicks: number;
  /** Tick they dropped at, or -1 while connected. */
  goneAt: number;
}

export class Room {
  readonly code: string;
  private players = new Map<string, Player>();
  private board = new InkBoard();

  private phase: Phase = "lobby";
  private phaseEndsAt = 0;
  private drawerId: string | null = null;
  private order: string[] = [];
  private roundIndex = 0;

  private tick = 0;
  private escaped = 0;
  private downed = 0;
  private firstOutClaimed = false;
  private lobbyDirty = false;

  private onEmpty: () => void;

  constructor(code: string, onEmpty: () => void) {
    this.code = code;
    this.onEmpty = onEmpty;
  }

  get size(): number {
    return this.players.size;
  }

  get isFull(): boolean {
    return this.players.size >= MAX_PLAYERS;
  }

  // ------------------------------------------------------------- membership
  join(id: string, name: string, ws: WebSocket): boolean {
    const returning = this.players.get(id);
    if (returning) {
      // Same person, same seat: their score, colour and place in the rotation survive.
      returning.ws = ws;
      returning.connected = true;
      returning.goneAt = -1;
      returning.name = name.slice(0, 14) || returning.name;
      if (returning.runner.status === "down") respawn(returning.runner);
      this.send(returning, { t: "welcome", you: id, room: this.code, tickHz: TICK_HZ });
      this.send(returning, { t: "board", strokes: this.board.snapshot(), inkUsed: this.board.inkUsed });
      this.sendPhase(returning);
      this.broadcastLobby();
      this.broadcast({ t: "toast", text: `${returning.name} reconnected` });
      return true;
    }

    if (this.isFull) return false;

    const taken = new Set([...this.players.values()].map((p) => p.colour));
    const colour = RUNNER_COLORS.find((c) => !taken.has(c)) ?? RUNNER_COLORS[0];

    const player: Player = {
      id, name: name.slice(0, 14) || "runner", colour,
      score: 0, roundDelta: 0, hasDrawn: false, connected: true, ws,
      runner: createRunner(),
      queue: [],
      lastInput: { seq: 0, left: false, right: false, jump: false },
      lastSeq: 0,
      idleTicks: 0,
      goneAt: -1,
    };
    this.players.set(id, player);

    this.send(player, { t: "welcome", you: id, room: this.code, tickHz: TICK_HZ });
    this.send(player, { t: "board", strokes: this.board.snapshot(), inkUsed: this.board.inkUsed });
    this.sendPhase(player);
    this.broadcastLobby();
    this.broadcast({ t: "toast", text: `${player.name} joined` });
    return true;
  }

  /** A dropped socket, not a departure — they have `RECONNECT_GRACE_TICKS` to come back. */
  leave(id: string): void {
    const player = this.players.get(id);
    if (!player || !player.connected) return;

    player.connected = false;
    player.ws = null;
    player.goneAt = this.tick;
    player.queue.length = 0;
    player.lastInput = NEUTRAL_INPUT;
    // Take them off the board rather than leaving a statue for the drawer to farm.
    player.runner.status = "down";
    player.runner.respawnIn = 0;

    this.broadcast({ t: "toast", text: `${player.name} dropped` });
    this.broadcastLobby();

    if (this.connectedCount === 0) this.onEmpty();
  }

  private get connectedCount(): number {
    let n = 0;
    for (const p of this.players.values()) if (p.connected) n++;
    return n;
  }

  /** Forget players who never came back, and end a round whose drawer is gone. */
  private reapAbsent(): void {
    for (const [id, p] of [...this.players]) {
      if (p.connected) continue;
      const gone = this.tick - p.goneAt;

      if (id === this.drawerId && gone > DRAWER_ABANDON_TICKS &&
          (this.phase === "prep" || this.phase === "round")) {
        this.broadcast({ t: "toast", text: `${p.name} left with the pen`, tone: "warn" });
        this.endRound(true);
      }

      if (gone > RECONNECT_GRACE_TICKS) {
        this.players.delete(id);
        this.order = this.order.filter((o) => o !== id);
        this.broadcast({ t: "toast", text: `${p.name} left` });
        this.broadcastLobby();
      }
    }
    if (this.players.size === 0) this.onEmpty();
  }

  private get hostId(): string | null {
    for (const [id, p] of this.players) if (p.connected) return id;
    return null;
  }

  // ------------------------------------------------------------- messages in
  handle(id: string, msg: ClientMsg): void {
    const player = this.players.get(id);
    if (!player) return;

    switch (msg.t) {
      case "ping":
        this.send(player, { t: "pong", ts: msg.ts });
        return;

      case "start":
        if (id === this.hostId && (this.phase === "lobby" || this.phase === "final")) {
          if (this.connectedCount < MIN_PLAYERS) {
            this.send(player, { t: "toast", text: `Need ${MIN_PLAYERS} players to start`, tone: "warn" });
            return;
          }
          this.startMatch();
        }
        return;

      case "input": {
        if (player.queue.length >= MAX_INPUT_BACKLOG) player.queue.shift();
        player.queue.push({ seq: msg.seq, left: !!msg.l, right: !!msg.r, jump: !!msg.j });
        return;
      }

      case "cursor":
        if (id !== this.drawerId) return;
        // Rate-limited on the way out, not on the way in.
        this.pendingCursor = { x: msg.x, y: msg.y, tool: msg.tool };
        return;

      case "pen":
        this.handlePen(player, msg);
        return;
    }
  }

  private pendingCursor: { x: number; y: number; tool: Tool } | null = null;

  private handlePen(player: Player, msg: Extract<ClientMsg, { t: "pen" }>): void {
    if (player.id !== this.drawerId) return;
    if (this.phase !== "prep" && this.phase !== "round") return;

    switch (msg.op) {
      case "begin": {
        const stroke = this.board.begin(msg.kind, msg.x, msg.y);
        if (!stroke) return this.refuse(player);
        this.broadcastExcept(player.id, {
          t: "penBegin", id: stroke.id, kind: stroke.kind,
          x: stroke.pts[0].x, y: stroke.pts[0].y, inkUsed: this.board.inkUsed,
        });
        return;
      }
      case "point": {
        const open = this.board.strokes[this.board.strokes.length - 1];
        const p = this.board.extend(msg.x, msg.y);
        if (!p) {
          if (this.board.lastRefusal) this.refuse(player);
          return;
        }
        this.broadcastExcept(player.id, {
          t: "penPoint", id: open.id, x: p.x, y: p.y, inkUsed: this.board.inkUsed,
        });
        return;
      }
      case "end":
        this.board.end();
        this.broadcastExcept(player.id, { t: "penEnd", inkUsed: this.board.inkUsed });
        return;
      case "erase": {
        if (!this.board.erase(msg.x, msg.y)) return;
        // Erasing is deterministic, so every client can apply the same op.
        this.broadcast({ t: "penErase", x: msg.x, y: msg.y, inkUsed: this.board.inkUsed });
        return;
      }
    }
  }

  /** The pen was refused — tell the drawer why and hand back the real board. */
  private refuse(player: Player): void {
    const why = this.board.lastRefusal;
    this.board.lastRefusal = null;
    if (why === "ink") this.send(player, { t: "toast", text: "Out of ink", tone: "warn" });
    else if (why === "spawn") this.send(player, { t: "toast", text: "No spikes on the spawn ledge", tone: "warn" });
    else if (why === "limit") this.send(player, { t: "toast", text: "Too much ink on the board", tone: "warn" });
    this.send(player, { t: "board", strokes: this.board.snapshot(), inkUsed: this.board.inkUsed });
  }

  // ------------------------------------------------------------- match flow
  private startMatch(): void {
    this.order = shuffle([...this.players.keys()]);
    this.roundIndex = -1;
    for (const p of this.players.values()) {
      p.score = 0;
      p.roundDelta = 0;
      p.hasDrawn = false;
    }
    this.nextRound();
  }

  private nextRound(): void {
    this.order = this.order.filter((id) => this.players.has(id));
    this.roundIndex++;

    if (this.roundIndex >= this.order.length) {
      this.phase = "final";
      this.phaseEndsAt = Date.now() + 1e9;
      this.drawerId = null;
      this.broadcastPhase();
      this.broadcastScores(false);
      return;
    }

    this.drawerId = this.order[this.roundIndex];
    this.board.reset();
    this.escaped = 0;
    this.downed = 0;
    this.firstOutClaimed = false;

    for (const p of this.players.values()) {
      p.roundDelta = 0;
      respawn(p.runner);
      p.queue.length = 0;
    }
    const drawer = this.players.get(this.drawerId);
    if (drawer) drawer.hasDrawn = true;

    this.setPhase("prep", PREP_SECONDS);
    this.broadcast({ t: "board", strokes: [], inkUsed: 0 });
    this.broadcastLobby();
  }

  private setPhase(phase: Phase, seconds: number): void {
    this.phase = phase;
    this.phaseEndsAt = Date.now() + seconds * 1000;
    this.broadcastPhase();
  }

  private endRound(abandoned: boolean): void {
    const drawer = this.drawerId ? this.players.get(this.drawerId) : null;

    if (!abandoned && drawer) {
      if (this.escaped === 0) {
        // A wall isn't a level. Everything earned this round is struck off.
        drawer.score -= drawer.roundDelta;
        drawer.roundDelta = 0;
        this.send(drawer, { t: "toast", text: "Total wipe — a wall isn't a level. No points.", tone: "warn" });
      } else if (this.escaped === 1) {
        drawer.score += SCORE_CLEAN_ROUND;
        drawer.roundDelta += SCORE_CLEAN_ROUND;
      }
    }

    this.broadcastScores(this.escaped === 0 && !abandoned);
    this.setPhase("intermission", INTERMISSION_SECONDS);
  }

  // ------------------------------------------------------------- simulation
  step(): void {
    this.tick++;
    this.reapAbsent();
    if (this.players.size === 0) return;

    const now = Date.now();
    const expired = now >= this.phaseEndsAt;

    if (this.phase === "round") {
      this.simulate();
      const live = this.activeRunners().filter((p) => p.connected);
      const allOut = live.length > 0 && live.every((p) => p.runner.status === "out");
      if (expired || allOut) this.endRound(false);
    } else if (this.phase === "prep" && expired) {
      if (this.board.strokes.length === 0) this.layStarterBridge();
      this.setPhase("round", ROUND_SECONDS);
    } else if (this.phase === "intermission" && expired) {
      this.nextRound();
    }

    if (this.tick % Math.round(TICK_HZ / SNAPSHOT_HZ) === 0) this.broadcastSnapshot();
    // Scores move mid-round; the roster should show it without waiting for the whistle.
    if (this.lobbyDirty && this.tick % 15 === 0) {
      this.lobbyDirty = false;
      this.broadcastLobby();
    }
    if (this.pendingCursor && this.tick % 2 === 0) {
      const c = this.pendingCursor;
      this.pendingCursor = null;
      this.broadcastExcept(this.drawerId ?? "", { t: "cursor", x: c.x, y: c.y, tool: c.tool, down: 1 });
    }
    if (this.tick % RESYNC_EVERY_TICKS === 0 && (this.phase === "round" || this.phase === "prep")) {
      this.broadcast({ t: "board", strokes: this.board.snapshot(), inkUsed: this.board.inkUsed });
    }
  }

  /**
   * An idle or absent drawer would otherwise hand everyone 45 seconds of empty
   * pit. Lay a plain, crossable span so the round is at least a round — they
   * keep the leftover ink and can still ruin it.
   */
  private layStarterBridge(): void {
    const span = (pts: [number, number][]) => {
      this.board.begin("ink", pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) this.board.extend(pts[i][0], pts[i][1]);
      this.board.end();
    };
    span([[128, 366], [240, 372], [340, 374], [430, 370]]);
    span([[505, 358], [620, 360], [730, 358], [828, 362]]);

    this.broadcast({ t: "board", strokes: this.board.snapshot(), inkUsed: this.board.inkUsed });
    this.broadcast({ t: "toast", text: "Nothing was drawn — a plain bridge was laid" });
  }

  private activeRunners(): Player[] {
    return [...this.players.values()].filter((p) => p.id !== this.drawerId);
  }

  private simulate(): void {
    const drawer = this.drawerId ? this.players.get(this.drawerId) : null;

    for (const player of this.activeRunners()) {
      if (!player.connected) continue;

      // Consume one buffered input per tick, catching up by at most one extra.
      let frame = player.queue.shift();
      if (player.queue.length > 3) {
        const extra = player.queue.shift();
        if (extra) frame = extra;
      }
      if (frame) {
        player.lastInput = frame;
        player.lastSeq = frame.seq;
        player.idleTicks = 0;
      } else if (++player.idleTicks > INPUT_IDLE_TICKS) {
        // A backgrounded tab stops sending; do not keep sprinting on their behalf.
        player.lastInput = NEUTRAL_INPUT;
      }

      const event = stepRunner(player.runner, player.lastInput, this.board.segs);

      if (event?.kind === "down") {
        markDown(player.runner);
        this.downed++;
        if (drawer) {
          drawer.score += SCORE_PER_DROP;
          drawer.roundDelta += SCORE_PER_DROP;
        }
        this.lobbyDirty = true;
        this.broadcast({ t: "fx", kind: "down", id: player.id, x: event.x, y: event.y, cause: event.cause });
      } else if (event?.kind === "out") {
        markOut(player.runner);
        this.escaped++;
        let gain = SCORE_ESCAPE;
        if (!this.firstOutClaimed) {
          this.firstOutClaimed = true;
          gain += SCORE_FIRST_OUT;
        }
        player.score += gain;
        player.roundDelta += gain;
        this.lobbyDirty = true;
        this.broadcast({ t: "fx", kind: "out", id: player.id, x: player.runner.x, y: player.runner.y });
      }

      if (player.runner.status === "down" && player.runner.respawnIn === 0) {
        respawn(player.runner);
      }
    }
  }

  // ------------------------------------------------------------- messages out
  private broadcastSnapshot(): void {
    const runners: WireRunner[] = [];
    for (const p of this.activeRunners()) {
      const r = p.runner;
      runners.push({
        i: p.id,
        x: Math.round(r.x * 10) / 10,
        y: Math.round(r.y * 10) / 10,
        vx: Math.round(r.vx),
        vy: Math.round(r.vy),
        st: r.status === "alive" ? 0 : r.status === "down" ? 1 : 2,
        s: p.lastSeq,
        g: r.onGround ? 1 : 0,
      });
    }
    this.broadcast({ t: "snap", tick: this.tick, runners });
  }

  private broadcastLobby(): void {
    const players: PlayerInfo[] = [...this.players.values()].map((p) => ({
      id: p.id, name: p.name, colour: p.colour,
      score: p.score, connected: p.connected, hasDrawn: p.hasDrawn,
    }));
    this.broadcast({ t: "lobby", players, hostId: this.hostId });
  }

  private broadcastScores(wipe: boolean): void {
    const rows: ScoreRow[] = [...this.players.values()]
      .map((p) => ({ id: p.id, name: p.name, colour: p.colour, score: p.score, delta: p.roundDelta }))
      .sort((a, b) => b.score - a.score);
    this.broadcast({ t: "scores", rows, escaped: this.escaped, downed: this.downed, wipe });
  }

  private broadcastPhase(): void {
    for (const p of this.players.values()) this.sendPhase(p);
  }

  private sendPhase(player: Player): void {
    this.send(player, {
      t: "phase",
      phase: this.phase,
      drawerId: this.drawerId,
      roundIndex: this.roundIndex,
      totalRounds: this.order.length,
      endsInMs: Math.max(0, this.phaseEndsAt - Date.now()),
    });
  }

  private send(player: Player, msg: ServerMsg): void {
    if (player.ws && player.ws.readyState === 1) player.ws.send(encode(msg));
  }

  private broadcast(msg: ServerMsg): void {
    const raw = encode(msg);
    for (const p of this.players.values()) {
      if (p.ws && p.ws.readyState === 1) p.ws.send(raw);
    }
  }

  private broadcastExcept(skipId: string, msg: ServerMsg): void {
    const raw = encode(msg);
    for (const p of this.players.values()) {
      if (p.id === skipId) continue;
      if (p.ws && p.ws.readyState === 1) p.ws.send(raw);
    }
  }
}

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

