export interface Vec {
  x: number;
  y: number;
}

export interface Seg {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** `rock` is the fixed arena, `ink` is a drawn platform, `spike` kills. */
  kind: "rock" | "ink" | "spike";
}

export function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

/** Closest point to (px,py) on segment (x1,y1)-(x2,y2). Written into `out`. */
export function closestOnSeg(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  out: Vec,
): Vec {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) {
    out.x = x1;
    out.y = y1;
    return out;
  }
  let u = ((px - x1) * dx + (py - y1) * dy) / len2;
  u = u < 0 ? 0 : u > 1 ? 1 : u;
  out.x = x1 + u * dx;
  out.y = y1 + u * dy;
  return out;
}

/** Proper segment intersection (shared endpoints do not count as crossing). */
export function segsIntersect(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): boolean {
  const d1 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d2 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  const d3 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d4 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  return d1 > 0 !== d2 > 0 && d3 > 0 !== d4 > 0;
}

export function polyLength(pts: readonly Vec[]): number {
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += dist(pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y);
  }
  return total;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
