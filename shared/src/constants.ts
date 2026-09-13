/**
 * Every number that defines how the game feels lives here, in real units
 * (pixels and seconds) so the sim can run at any tick rate without retuning.
 */

// ---- arena ----------------------------------------------------------------
export const W = 960;
export const H = 520;

/** The ledge everyone spawns on. Its top surface is solid; its edge is not. */
export const LEDGE = { x0: 0, x1: 128, y: 362 } as const;
/** The far slab holding the exit door. */
export const EXIT = { x0: 828, x1: 960, y: 362 } as const;
export const DOOR = { x: 874, y: 304, w: 42, h: 58 } as const;
/** Fall past this line and you are gone. */
export const KILL_Y = 486;
export const SPAWN = { x: 40, y: 336 } as const;

// ---- ticking --------------------------------------------------------------
/** Authoritative simulation rate. Inputs are consumed at this rate. */
export const TICK_HZ = 30;
export const DT = 1 / TICK_HZ;
/** Physics substeps per tick. Keeps fast falls from tunnelling thin platforms. */
export const SUBSTEPS = 4;
export const SUB_DT = DT / SUBSTEPS;
/** How often the server ships a world snapshot. */
export const SNAPSHOT_HZ = 20;
/** How often the drawer's cursor is broadcast — runners need to see them think. */
export const CURSOR_HZ = 15;

// ---- runner movement ------------------------------------------------------
export const RUNNER_R = 9;
export const RUN_SPEED = 150; // px/s
export const GROUND_ACCEL = 2400; // px/s^2
export const AIR_ACCEL = 900; // px/s^2
export const GRAVITY = 1500; // px/s^2
export const JUMP_V = -540; // px/s
export const MAX_FALL = 700; // px/s
/** Grace period after walking off a ledge where a jump still counts. */
export const COYOTE_TICKS = 5;
/** Jump pressed slightly before landing still fires on touchdown. */
export const JUMP_BUFFER_TICKS = 5;
/** Cutting the jump button short shortens the hop. */
export const JUMP_CUT = 0.45;
export const RESPAWN_TICKS = Math.round(1.6 * TICK_HZ);

// ---- the pen --------------------------------------------------------------
export const INK_MAX = 1100;
export const COST_INK = 1.0; // per px of line
export const COST_SPIKE = 2.2; // spikes are the premium good
export const ERASE_R = 22;
/** Points closer together than this are dropped — caps stroke density. */
export const MIN_POINT_GAP = 5;
/** Hard ceiling on points the server will hold, so one player can't flood a room. */
export const MAX_POINTS_PER_ROOM = 4000;
/** No drawing inside this radius of spawn — nobody wants an instant death. */
export const SPAWN_SAFE_R = 46;

// ---- round structure ------------------------------------------------------
export const ROUND_SECONDS = 45;
/** The drawer gets the pit to themselves before the gates open. */
export const PREP_SECONDS = 3;
export const INTERMISSION_SECONDS = 6;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 8;

// ---- scoring --------------------------------------------------------------
export const SCORE_PER_DROP = 100;
/** Letting exactly one runner through is the mark of a good host. */
export const SCORE_CLEAN_ROUND = 300;
export const SCORE_ESCAPE = 400;
export const SCORE_FIRST_OUT = 100;

// ---- presentation ---------------------------------------------------------
export const PALETTE = {
  ground: "#0B1016",
  panel: "#111924",
  grid: "#18242F",
  edge: "#22303D",
  chalk: "#E9EFF4",
  dim: "#6C8299",
  ink: "#44E5C6",
  blood: "#FF4D6D",
  gold: "#FFC14D",
} as const;

export const RUNNER_COLORS = [
  "#7CC6FF", "#FFB0D0", "#C4A6FF", "#9EE37D",
  "#FFD48A", "#8FE9E0", "#FF9E6D", "#B8C4FF",
] as const;
