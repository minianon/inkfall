/**
 * Deterministic checks on the load-bearing rules. The sim is pure and shared,
 * so this exercises exactly the code the server runs — no browser needed.
 *
 *   npm test
 */
import assert from "node:assert/strict";
import {
  DOOR, INK_MAX, KILL_Y, MIN_POINT_GAP, SPAWN, TICK_HZ,
} from "../shared/src/constants";
import {
  createRunner, stepRunner, type InputFrame, type RunnerState, type TickEvent,
} from "../shared/src/runner";
import { InkBoard } from "../shared/src/strokes";

// ---------------------------------------------------------------- harness
const HOLD_RIGHT: InputFrame = { seq: 0, left: false, right: true, jump: false };
const HOLD_RIGHT_JUMP: InputFrame = { seq: 0, left: false, right: true, jump: true };

let failures = 0;
let ran = 0;

function test(name: string, fn: () => void): void {
  ran++;
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL ${name}`);
    console.log(`       ${(err as Error).message.split("\n")[0]}`);
  }
}

/** Draw a polyline through the board the way a player's pen would. */
function span(board: InkBoard, kind: "ink" | "spike", pts: [number, number][]): void {
  board.begin(kind, pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) board.extend(pts[i][0], pts[i][1]);
  board.end();
}

function flatBridge(board: InkBoard): void {
  span(board, "ink", [[128, 362], [300, 362], [500, 362], [700, 362], [900, 362]]);
}

/** Step for `seconds`, returning the first event and the tick it landed on. */
function advance(
  runner: RunnerState,
  board: InkBoard,
  input: InputFrame,
  seconds: number,
  onTick?: (tick: number) => void,
): { event: TickEvent; tick: number } {
  const ticks = Math.round(seconds * TICK_HZ);
  for (let t = 0; t < ticks; t++) {
    onTick?.(t);
    const event = stepRunner(runner, input, board.segs);
    if (event) return { event, tick: t };
  }
  return { event: null, tick: ticks };
}

// ---------------------------------------------------------------- the rules
console.log("\ninkfall · simulation\n");

test("a runner crosses a flat bridge and reaches the exit", () => {
  const board = new InkBoard();
  flatBridge(board);
  const r = createRunner();

  const { event } = advance(r, board, HOLD_RIGHT, 12);
  assert.equal(event?.kind, "out", "expected the runner to get out");
  assert.ok(r.x > DOOR.x, `runner should be past the door, was at x=${r.x.toFixed(0)}`);
});

test("erasing the bridge under a moving runner drops them into the pit", () => {
  const board = new InkBoard();
  flatBridge(board);
  const r = createRunner();

  // Two seconds of running puts them well out over the pit.
  advance(r, board, HOLD_RIGHT, 2);
  const standingAt = r.x;
  assert.ok(standingAt > 200, `runner should be out on the bridge, was x=${standingAt.toFixed(0)}`);
  assert.ok(r.onGround, "runner should be standing on the bridge before the erase");

  // The pen goes through the floor they are standing on, right now.
  board.erase(standingAt, 362);
  board.erase(standingAt + 18, 362);

  const { event } = advance(r, board, HOLD_RIGHT, 3);
  assert.equal(event?.kind, "down", "expected the runner to go down");
  assert.equal(event?.kind === "down" && event.cause, "pit", "expected a pit death, not a spike");
  assert.ok(r.y >= KILL_Y - 1, `runner should be below the kill line, was y=${r.y.toFixed(0)}`);
});

test("a spike on the path kills on contact", () => {
  const board = new InkBoard();
  flatBridge(board);
  span(board, "spike", [[360, 352], [400, 352]]);
  const r = createRunner();

  const { event } = advance(r, board, HOLD_RIGHT, 6);
  assert.equal(event?.kind, "down");
  assert.equal(event?.kind === "down" && event.cause, "spike");
  assert.ok(r.x > 330 && r.x < 420, `should die at the spikes, died at x=${r.x.toFixed(0)}`);
});

test("an unbridged pit drops a runner who walks off the ledge", () => {
  const board = new InkBoard();
  const r = createRunner();
  const { event } = advance(r, board, HOLD_RIGHT, 4);
  assert.equal(event?.kind, "down");
  assert.equal(event?.kind === "down" && event.cause, "pit");
});

test("a well-timed jump clears a 60px gap", () => {
  const board = new InkBoard();
  span(board, "ink", [[128, 362], [300, 362], [430, 362]]);
  span(board, "ink", [[490, 362], [700, 362], [900, 362]]);
  const r = createRunner();

  // Hold jump only while approaching the lip, the way a player would.
  const { event } = advance(r, board, HOLD_RIGHT, 12, () => {
    /* replaced below */
  });
  void event;

  const r2 = createRunner();
  let out: TickEvent = null;
  for (let t = 0; t < 12 * TICK_HZ; t++) {
    const nearLip = r2.x > 400 && r2.x < 432;
    const ev = stepRunner(r2, nearLip ? HOLD_RIGHT_JUMP : HOLD_RIGHT, board.segs);
    if (ev) {
      out = ev;
      break;
    }
  }
  assert.equal(out?.kind, "out", `expected to clear the gap, ended at x=${r2.x.toFixed(0)}`);
});

test("ink is finite and the pen is refused when it runs out", () => {
  const board = new InkBoard();
  // Scribble far past the budget.
  // Short steps, so the budget is spent to the last unit rather than a long
  // final stroke being refused wholesale with ink left over.
  board.begin("ink", 10, 300);
  let x = 10;
  for (let i = 1; i < 400 && board.inkLeft > 0; i++) {
    x = 10 + ((i * 11) % 900);
    board.extend(x, 300 + ((i * 7) % 90));
  }
  board.end();

  assert.ok(board.inkUsed <= INK_MAX + 1, `ink used ${board.inkUsed} exceeded the cap ${INK_MAX}`);
  // Spent down to less than one drawable step — the bar is telling the truth.
  assert.ok(board.inkLeft < MIN_POINT_GAP, `budget should be spent, ${board.inkLeft} left`);
  assert.equal(board.begin("ink", 500, 200), null, "a new stroke should be refused with no ink");
  assert.equal(board.lastRefusal, "ink");
});

test("erasing refunds the ink that was spent", () => {
  const board = new InkBoard();
  flatBridge(board);
  const spent = board.inkUsed;
  assert.ok(spent > 0);

  board.erase(400, 362);
  assert.ok(board.inkUsed < spent, `erase should refund; ${board.inkUsed} vs ${spent}`);
});

test("spikes are refused on the spawn ledge but platforms are not", () => {
  const board = new InkBoard();
  assert.equal(board.begin("spike", SPAWN.x + 4, SPAWN.y), null, "spike at spawn should be refused");
  assert.equal(board.lastRefusal, "spawn");
  assert.ok(board.begin("ink", SPAWN.x + 4, SPAWN.y), "a platform at spawn is fine");
});

test("erasing the middle of a stroke splits it in two", () => {
  const board = new InkBoard();
  flatBridge(board);
  assert.equal(board.strokes.length, 1);
  board.erase(500, 362);
  assert.equal(board.strokes.length, 2, "the hole should leave a piece either side");
});

test("a standing runner never tunnels through a thin platform", () => {
  const board = new InkBoard();
  flatBridge(board);
  const r = createRunner();
  advance(r, board, HOLD_RIGHT, 1);

  // Drop them from high up at terminal velocity onto a 1px-thin line.
  r.y = 40;
  r.vy = 2000;
  const { event } = advance(r, board, HOLD_RIGHT, 2);
  assert.equal(event, null, "a fast fall should land, not fall through");
  assert.ok(r.y < KILL_Y, `should have landed, ended at y=${r.y.toFixed(0)}`);
});

// ---------------------------------------------------------------- report
console.log(`\n${ran - failures}/${ran} passed\n`);
process.exit(failures === 0 ? 0 : 1);
