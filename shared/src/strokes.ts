import {
  COST_INK, COST_SPIKE, ERASE_R, EXIT, H, INK_MAX, LEDGE,
  MAX_POINTS_PER_ROOM, MIN_POINT_GAP, SPAWN, SPAWN_SAFE_R, W,
} from "./constants";
import { clamp, dist, polyLength, type Seg, type Vec } from "./geom";

export type StrokeKind = "ink" | "spike";

export interface Stroke {
  id: number;
  kind: StrokeKind;
  pts: Vec[];
}

/** Why a drawing action was refused, so the UI can say something useful. */
export type InkRefusal = "ink" | "limit" | "spawn" | null;

/**
 * The drawn level. The server owns the authoritative instance; each client
 * keeps its own copy so the pen feels instant, then accepts server truth.
 */
export class InkBoard {
  strokes: Stroke[] = [];
  segs: Seg[] = [];
  inkUsed = 0;
  lastRefusal: InkRefusal = null;

  private nextId = 1;
  private open: Stroke | null = null;

  constructor() {
    this.rebuild();
  }

  get inkLeft(): number {
    return Math.max(0, INK_MAX - this.inkUsed);
  }

  get pointCount(): number {
    let n = 0;
    for (const s of this.strokes) n += s.pts.length;
    return n;
  }

  reset(): void {
    this.strokes = [];
    this.inkUsed = 0;
    this.open = null;
    this.nextId = 1;
    this.lastRefusal = null;
    this.rebuild();
  }

  /** Start a stroke. Returns the stroke, or null if the pen was refused. */
  begin(kind: StrokeKind, x: number, y: number, forceId?: number): Stroke | null {
    this.open = null;
    const p = this.sanitise(x, y);
    // Needs enough ink for at least one drawable step, so starting a stroke you
    // cannot draw tells you why instead of leaving a dot that vanishes.
    const refusal = this.refuse(kind, p, MIN_POINT_GAP);
    if (refusal) {
      this.lastRefusal = refusal;
      return null;
    }
    this.lastRefusal = null;
    const stroke: Stroke = { id: forceId ?? this.nextId++, kind, pts: [p] };
    if (forceId !== undefined) this.nextId = Math.max(this.nextId, forceId + 1);
    this.strokes.push(stroke);
    this.rebuild();
    return stroke;
  }

  /** Extend the open stroke. Returns the appended point, or null if refused. */
  extend(x: number, y: number): Vec | null {
    const open = this.open ?? this.strokes[this.strokes.length - 1];
    if (!open) return null;
    this.open = open;

    let p = this.sanitise(x, y);
    const last = open.pts[open.pts.length - 1];
    let step = dist(last.x, last.y, p.x, p.y);
    if (step < MIN_POINT_GAP) return null;

    // Run dry exactly where the budget ends, rather than refusing the whole
    // move and stranding ink the bar still shows.
    const cost = costOf(open.kind);
    const affordable = this.inkLeft / cost;
    if (step > affordable) {
      if (affordable < MIN_POINT_GAP) {
        this.lastRefusal = "ink";
        this.open = null;
        return null;
      }
      const u = affordable / step;
      p = this.sanitise(last.x + (p.x - last.x) * u, last.y + (p.y - last.y) * u);
      step = dist(last.x, last.y, p.x, p.y);
    }

    const refusal = this.refuse(open.kind, p, step);
    if (refusal) {
      this.lastRefusal = refusal;
      this.open = null; // a refused stroke is finished, not paused
      return null;
    }

    open.pts.push(p);
    this.inkUsed += step * cost;
    this.rebuild();
    return p;
  }

  end(): void {
    // A stroke of one point draws nothing; drop it so it can't collect dust.
    if (this.open && this.open.pts.length < 2) {
      this.strokes = this.strokes.filter((s) => s !== this.open);
      this.rebuild();
    }
    this.open = null;
    this.recomputeInk();
  }

  /**
   * Rub out everything within ERASE_R of (x,y), splitting strokes in two where
   * the hole falls in the middle. Ink comes back — that is the whole point.
   */
  erase(x: number, y: number): boolean {
    const next: Stroke[] = [];
    let changed = false;

    for (const s of this.strokes) {
      let run: Vec[] = [];
      const pieces: Vec[][] = [];
      let touched = false;

      // A fast drag leaves points far apart. Erase works on points, so without
      // this a hole could not open in the middle of a long straight run — which
      // is precisely where the floor needs to vanish from under someone.
      for (const p of densify(s.pts, ERASE_R * 0.6)) {
        if (dist(p.x, p.y, x, y) < ERASE_R) {
          touched = true;
          if (run.length > 1) pieces.push(run);
          run = [];
        } else {
          run.push(p);
        }
      }
      if (run.length > 1) pieces.push(run);

      if (!touched) {
        next.push(s); // Untouched strokes keep their original points.
        continue;
      }
      changed = true;
      // First piece keeps the id so clients can track it; the rest are new.
      for (let i = 0; i < pieces.length; i++) {
        next.push({ id: i === 0 ? s.id : this.nextId++, kind: s.kind, pts: pieces[i] });
      }
    }

    if (!changed) return false;
    this.strokes = next;
    this.open = null;
    this.rebuild();
    this.recomputeInk();
    return true;
  }

  /** Replace the whole board — used when a client accepts server truth. */
  load(strokes: Stroke[]): void {
    this.strokes = strokes.map((s) => ({ id: s.id, kind: s.kind, pts: s.pts.map((p) => ({ ...p })) }));
    for (const s of this.strokes) this.nextId = Math.max(this.nextId, s.id + 1);
    this.open = null;
    this.rebuild();
    this.recomputeInk();
  }

  snapshot(): Stroke[] {
    return this.strokes.map((s) => ({ id: s.id, kind: s.kind, pts: s.pts.map((p) => ({ ...p })) }));
  }

  rebuild(): void {
    const segs: Seg[] = [
      { x1: LEDGE.x0, y1: LEDGE.y, x2: LEDGE.x1, y2: LEDGE.y, kind: "rock" },
      { x1: EXIT.x0, y1: EXIT.y, x2: EXIT.x1, y2: EXIT.y, kind: "rock" },
    ];
    for (const s of this.strokes) {
      for (let i = 1; i < s.pts.length; i++) {
        segs.push({
          x1: s.pts[i - 1].x, y1: s.pts[i - 1].y,
          x2: s.pts[i].x, y2: s.pts[i].y,
          kind: s.kind,
        });
      }
    }
    this.segs = segs;
  }

  private recomputeInk(): void {
    let used = 0;
    for (const s of this.strokes) used += polyLength(s.pts) * costOf(s.kind);
    this.inkUsed = used;
  }

  private sanitise(x: number, y: number): Vec {
    return { x: Math.round(clamp(x, 0, W) * 10) / 10, y: Math.round(clamp(y, 0, H) * 10) / 10 };
  }

  private refuse(kind: StrokeKind, p: Vec, step: number): InkRefusal {
    // Spikes on top of the spawn point are a non-game, not a strategy.
    if (kind === "spike" && dist(p.x, p.y, SPAWN.x, SPAWN.y) < SPAWN_SAFE_R) return "spawn";
    if (this.pointCount >= MAX_POINTS_PER_ROOM) return "limit";
    if (step * costOf(kind) > this.inkLeft) return "ink";
    return null;
  }
}

export function costOf(kind: StrokeKind): number {
  return kind === "spike" ? COST_SPIKE : COST_INK;
}

/**
 * Insert collinear points so no two are further apart than `maxGap`. Length —
 * and therefore ink cost — is unchanged, and it is deterministic, so every
 * client that applies the same erase gets the same board.
 */
function densify(pts: readonly Vec[], maxGap: number): Vec[] {
  const out: Vec[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    out.push(a);
    const b = pts[i + 1];
    if (!b) break;
    const steps = Math.floor(dist(a.x, a.y, b.x, b.y) / maxGap);
    for (let k = 1; k <= steps; k++) {
      const u = k / (steps + 1);
      out.push({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u });
    }
  }
  return out;
}
