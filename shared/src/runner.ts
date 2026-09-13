import {
  AIR_ACCEL, COYOTE_TICKS, DOOR, GRAVITY, GROUND_ACCEL, JUMP_BUFFER_TICKS,
  JUMP_CUT, JUMP_V, KILL_Y, MAX_FALL, RESPAWN_TICKS, RUN_SPEED, RUNNER_R,
  SPAWN, SUBSTEPS, SUB_DT,
} from "./constants";
import { closestOnSeg, type Seg, type Vec } from "./geom";

export type RunnerStatus = "alive" | "down" | "out";

export interface RunnerState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  onGround: boolean;
  coyote: number;
  jumpBuffer: number;
  jumpHeld: boolean;
  facing: 1 | -1;
  status: RunnerStatus;
  respawnIn: number;
  /** Bumped on every death so clients can fire one effect per death, not per tick. */
  deaths: number;
}

export interface InputFrame {
  seq: number;
  left: boolean;
  right: boolean;
  jump: boolean;
}

export const NEUTRAL_INPUT: InputFrame = { seq: 0, left: false, right: false, jump: false };

/** What happened to a runner during one tick, for the caller to score. */
export type TickEvent = { kind: "down"; cause: "spike" | "pit"; x: number; y: number } | { kind: "out" } | null;

export function createRunner(): RunnerState {
  return {
    x: SPAWN.x, y: SPAWN.y, vx: 0, vy: 0,
    onGround: false, coyote: 0, jumpBuffer: 0, jumpHeld: false,
    facing: 1, status: "alive", respawnIn: 0, deaths: 0,
  };
}

export function respawn(r: RunnerState): void {
  r.x = SPAWN.x;
  r.y = SPAWN.y;
  r.vx = 0;
  r.vy = 0;
  r.onGround = false;
  r.coyote = 0;
  r.jumpBuffer = 0;
  r.jumpHeld = false;
  r.facing = 1;
  r.status = "alive";
  r.respawnIn = 0;
}

const scratch: Vec = { x: 0, y: 0 };

/**
 * Advance one runner by exactly one tick. Pure apart from mutating `r`, and
 * identical on both sides of the wire — the client replays this for prediction
 * and the server replays it for authority.
 */
export function stepRunner(r: RunnerState, input: InputFrame, segs: readonly Seg[]): TickEvent {
  if (r.status === "out") return null;
  if (r.status === "down") {
    if (r.respawnIn > 0) r.respawnIn--;
    return null;
  }

  // ---- jump intent ----
  if (input.jump && !r.jumpHeld) r.jumpBuffer = JUMP_BUFFER_TICKS;
  else if (r.jumpBuffer > 0) r.jumpBuffer--;
  r.jumpHeld = input.jump;

  if (r.onGround) r.coyote = COYOTE_TICKS;
  else if (r.coyote > 0) r.coyote--;

  if (r.jumpBuffer > 0 && r.coyote > 0) {
    r.vy = JUMP_V;
    r.jumpBuffer = 0;
    r.coyote = 0;
    r.onGround = false;
  }
  // Releasing early clips the arc, which is what makes small hops possible.
  if (!input.jump && r.vy < JUMP_V * JUMP_CUT) r.vy = JUMP_V * JUMP_CUT;

  const dir = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  if (dir !== 0) r.facing = dir > 0 ? 1 : -1;

  let grounded = false;
  let event: TickEvent = null;

  for (let s = 0; s < SUBSTEPS; s++) {
    const accel = (r.onGround || grounded ? GROUND_ACCEL : AIR_ACCEL) * SUB_DT;
    const target = dir * RUN_SPEED;
    if (r.vx < target) r.vx = Math.min(target, r.vx + accel);
    else if (r.vx > target) r.vx = Math.max(target, r.vx - accel);

    r.vy += GRAVITY * SUB_DT;
    if (r.vy > MAX_FALL) r.vy = MAX_FALL;

    r.x += r.vx * SUB_DT;
    r.y += r.vy * SUB_DT;

    const hit = resolve(r, segs);
    if (hit === "spike") {
      return { kind: "down", cause: "spike", x: r.x, y: r.y };
    }
    if (hit === "ground") grounded = true;
  }

  r.onGround = grounded;

  if (r.y > KILL_Y) return { kind: "down", cause: "pit", x: r.x, y: KILL_Y };
  if (r.x > DOOR.x && r.y < DOOR.y + DOOR.h + 30) return { kind: "out" };

  return event;
}

type Hit = "none" | "ground" | "wall" | "spike";

function resolve(r: RunnerState, segs: readonly Seg[]): Hit {
  let result: Hit = "none";

  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      closestOnSeg(r.x, r.y, seg.x1, seg.y1, seg.x2, seg.y2, scratch);
      let dx = r.x - scratch.x;
      let dy = r.y - scratch.y;
      let d = Math.hypot(dx, dy);
      if (d >= RUNNER_R) continue;
      if (seg.kind === "spike") return "spike";

      // Dead centre on the line: push straight up rather than dividing by zero.
      if (d < 1e-4) {
        dx = 0;
        dy = -1;
        d = 1;
      }
      const nx = dx / d;
      const ny = dy / d;
      r.x += nx * (RUNNER_R - d);
      r.y += ny * (RUNNER_R - d);

      const vn = r.vx * nx + r.vy * ny;
      if (vn < 0) {
        r.vx -= vn * nx;
        r.vy -= vn * ny;
      }
      if (ny < -0.55) result = "ground";
      else if (result === "none") result = "wall";
    }
  }
  return result;
}

export function markDown(r: RunnerState): void {
  r.status = "down";
  r.respawnIn = RESPAWN_TICKS;
  r.vx = 0;
  r.vy = 0;
  r.deaths++;
}

export function markOut(r: RunnerState): void {
  r.status = "out";
  r.vx = 0;
  r.vy = 0;
}
