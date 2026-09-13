import {
  DOOR, EXIT, H, KILL_Y, LEDGE, PALETTE, RUNNER_R, SPAWN, W,
} from "../../shared/src/constants";
import type { Phase, Tool } from "../../shared/src/protocol";
import type { RunnerStatus } from "../../shared/src/runner";
import type { InkBoard, Stroke } from "../../shared/src/strokes";

export interface RenderRunner {
  id: string;
  x: number;
  y: number;
  colour: string;
  name: string;
  status: RunnerStatus;
  facing: 1 | -1;
  isYou: boolean;
}

export interface RenderPen {
  x: number;
  y: number;
  tool: Tool;
  colour: string;
  name: string;
  isYou: boolean;
}

export interface RenderView {
  board: InkBoard;
  runners: RenderRunner[];
  pen: RenderPen | null;
  phase: Phase;
  youAreDrawer: boolean;
}

interface Trail {
  pts: { x: number; y: number }[];
  lastY: number;
  squash: number;
}

interface Particle {
  x: number; y: number; vx: number; vy: number;
  colour: string; life: number; max: number; r: number;
}

interface Pop {
  x: number; y: number; text: string; colour: string; life: number;
}

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private trails = new Map<string, Trail>();
  private particles: Particle[] = [];
  private pops: Pop[] = [];
  private reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas 2d unavailable");
    this.ctx = ctx;
    this.resize();
    addEventListener("resize", () => this.resize());
  }

  private resize(): void {
    const dpr = Math.min(2, devicePixelRatio || 1);
    this.canvas.width = W * dpr;
    this.canvas.height = H * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  burst(x: number, y: number, colour: string, n = 16): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 60 + Math.random() * 200;
      this.particles.push({
        x, y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 100,
        colour, life: 0.45 + Math.random() * 0.4, max: 0.85,
        r: 1.6 + Math.random() * 2.4,
      });
    }
  }

  pop(x: number, y: number, text: string, colour: string): void {
    this.pops.push({ x, y, text, colour, life: 0.9 });
  }

  clearFx(): void {
    this.particles.length = 0;
    this.pops.length = 0;
    this.trails.clear();
  }

  draw(view: RenderView, dt: number): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = PALETTE.ground;
    ctx.fillRect(0, 0, W, H);

    this.drawGrid();
    this.drawPit();
    this.drawSlabs(view);
    this.drawStrokes(view.board.strokes);
    this.stepFx(dt);
    this.drawParticles();
    this.drawRunners(view.runners, dt);
    this.drawPops();
    if (view.pen) this.drawPen(view.pen);
  }

  // ---------------------------------------------------------------- scenery
  private drawGrid(): void {
    const ctx = this.ctx;
    ctx.strokeStyle = PALETTE.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= W; x += 40) {
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, H);
    }
    for (let y = 0; y <= H; y += 40) {
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(W, y + 0.5);
    }
    ctx.stroke();
  }

  private drawPit(): void {
    const ctx = this.ctx;
    const g = ctx.createLinearGradient(0, 400, 0, H);
    g.addColorStop(0, "rgba(255,77,109,0)");
    g.addColorStop(1, "rgba(255,77,109,0.22)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 400, W, H - 400);

    ctx.strokeStyle = "rgba(255,77,109,0.45)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    const t = this.reduced ? 0 : performance.now() / 620;
    ctx.moveTo(0, KILL_Y);
    for (let x = 0; x <= W; x += 24) {
      ctx.lineTo(x, KILL_Y + (this.reduced ? 0 : Math.sin(x / 70 + t) * 3.5));
    }
    ctx.stroke();
  }

  private drawSlabs(view: RenderView): void {
    const ctx = this.ctx;
    const slab = (x0: number, x1: number, y: number) => {
      ctx.fillStyle = PALETTE.panel;
      ctx.fillRect(x0, y, x1 - x0, H - y);
      ctx.fillStyle = PALETTE.edge;
      ctx.fillRect(x0, y, x1 - x0, 3);
    };
    slab(LEDGE.x0, LEDGE.x1, LEDGE.y);
    slab(EXIT.x0, EXIT.x1, EXIT.y);

    ctx.fillStyle = PALETTE.dim;
    ctx.font = "600 10px 'IBM Plex Mono', monospace";
    ctx.textAlign = "left";
    ctx.fillText("SPAWN", 12, 384);

    // During prep the door is the only thing lit — it says where to aim.
    const pulse = this.reduced ? 0.5 : 0.5 + Math.sin(performance.now() / 380) * 0.28;
    const glow = view.phase === "prep" ? 0.26 + pulse * 0.2 : 0.14 + pulse * 0.14;
    ctx.fillStyle = `rgba(255,193,77,${glow})`;
    ctx.fillRect(DOOR.x - 8, DOOR.y - 8, DOOR.w + 16, DOOR.h + 8);
    ctx.fillStyle = PALETTE.gold;
    ctx.fillRect(DOOR.x, DOOR.y, DOOR.w, DOOR.h);
    ctx.fillStyle = PALETTE.ground;
    ctx.font = "600 10px 'IBM Plex Mono', monospace";
    ctx.textAlign = "center";
    ctx.fillText("EXIT", DOOR.x + DOOR.w / 2, DOOR.y + 34);

    if (view.phase === "prep") {
      ctx.fillStyle = "rgba(68,229,198,0.1)";
      ctx.fillRect(SPAWN.x - 26, LEDGE.y - 70, 52, 70);
    }
  }

  private drawStrokes(strokes: readonly Stroke[]): void {
    const ctx = this.ctx;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    for (const s of strokes) {
      if (s.pts.length < 2) continue;
      const spike = s.kind === "spike";
      ctx.strokeStyle = spike ? "rgba(255,77,109,0.16)" : "rgba(68,229,198,0.16)";
      ctx.lineWidth = 16;
      this.trace(s);
      ctx.stroke();

      ctx.strokeStyle = spike ? PALETTE.blood : PALETTE.ink;
      ctx.lineWidth = 7;
      this.trace(s);
      ctx.stroke();

      if (spike) this.drawTeeth(s);
    }
  }

  private trace(s: Stroke): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(s.pts[0].x, s.pts[0].y);
    for (let i = 1; i < s.pts.length; i++) ctx.lineTo(s.pts[i].x, s.pts[i].y);
  }

  private drawTeeth(s: Stroke): void {
    const ctx = this.ctx;
    ctx.fillStyle = PALETTE.blood;
    for (let i = 1; i < s.pts.length; i++) {
      const a = s.pts[i - 1];
      const b = s.pts[i];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 1) continue;
      const n = Math.max(1, Math.floor(len / 11));
      const ux = (b.x - a.x) / len;
      const uy = (b.y - a.y) / len;
      for (let k = 0; k < n; k++) {
        const u = (k + 0.5) / n;
        const px = a.x + (b.x - a.x) * u;
        const py = a.y + (b.y - a.y) * u;
        ctx.beginPath();
        ctx.moveTo(px + ux * 5, py + uy * 5);
        ctx.lineTo(px - ux * 5, py - uy * 5);
        ctx.lineTo(px - uy * 11, py + ux * 11);
        ctx.closePath();
        ctx.fill();
      }
    }
  }

  // ---------------------------------------------------------------- actors
  private drawRunners(runners: readonly RenderRunner[], dt: number): void {
    const ctx = this.ctx;
    const seen = new Set<string>();

    for (const r of runners) {
      seen.add(r.id);
      let trail = this.trails.get(r.id);
      if (!trail) {
        trail = { pts: [], lastY: r.y, squash: 0 };
        this.trails.set(r.id, trail);
      }

      if (r.status !== "alive") {
        trail.pts.length = 0;
        if (r.status === "down") this.drawRespawnMarker(r);
        continue;
      }

      // A sharp downward stop reads as a landing — squash on it.
      const fell = r.y - trail.lastY;
      if (fell > 4) trail.squash = Math.min(1, fell / 14);
      trail.lastY = r.y;
      trail.squash = Math.max(0, trail.squash - dt * 6);

      trail.pts.push({ x: r.x, y: r.y });
      if (trail.pts.length > 7) trail.pts.shift();

      for (let i = 0; i < trail.pts.length; i++) {
        const p = trail.pts[i];
        ctx.globalAlpha = (i / trail.pts.length) * 0.2;
        ctx.fillStyle = r.colour;
        ctx.beginPath();
        ctx.arc(p.x, p.y, RUNNER_R * 0.8, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      if (r.isYou) {
        ctx.strokeStyle = r.colour;
        ctx.globalAlpha = 0.5;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(r.x, r.y, RUNNER_R + 5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      ctx.save();
      ctx.translate(r.x, r.y);
      ctx.scale(1 + trail.squash * 0.35, 1 - trail.squash * 0.3);
      ctx.fillStyle = r.colour;
      ctx.beginPath();
      ctx.arc(0, 0, RUNNER_R, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(11,16,22,0.9)";
      const eye = r.facing * 2.5;
      ctx.beginPath();
      ctx.arc(eye, -2.5, 2.1, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(eye + r.facing * 4, -2.5, 2.1, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      ctx.fillStyle = r.isYou ? r.colour : "rgba(233,239,244,0.45)";
      ctx.font = "400 9px 'IBM Plex Mono', monospace";
      ctx.textAlign = "center";
      ctx.fillText(r.name, r.x, r.y - 17);
    }

    for (const id of [...this.trails.keys()]) {
      if (!seen.has(id)) this.trails.delete(id);
    }
  }

  private drawRespawnMarker(r: RenderRunner): void {
    const ctx = this.ctx;
    ctx.globalAlpha = 0.35;
    ctx.strokeStyle = r.colour;
    ctx.setLineDash([3, 4]);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(SPAWN.x, SPAWN.y, RUNNER_R + 3, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  private drawPen(pen: RenderPen): void {
    const ctx = this.ctx;
    const colour =
      pen.tool === "spike" ? PALETTE.blood : pen.tool === "erase" ? PALETTE.chalk : PALETTE.ink;
    const radius = pen.tool === "erase" ? 22 : 9;

    ctx.strokeStyle = colour;
    ctx.lineWidth = 1.4;
    ctx.globalAlpha = pen.isYou ? 1 : 0.8;
    ctx.beginPath();
    ctx.arc(pen.x, pen.y, radius, 0, Math.PI * 2);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(pen.x - radius - 8, pen.y);
    ctx.lineTo(pen.x - radius - 3, pen.y);
    ctx.moveTo(pen.x + radius + 3, pen.y);
    ctx.lineTo(pen.x + radius + 8, pen.y);
    ctx.stroke();

    if (!pen.isYou) {
      // Runners need to know whose hand that is, and what it's holding.
      ctx.fillStyle = colour;
      ctx.font = "600 9px 'IBM Plex Mono', monospace";
      ctx.textAlign = "left";
      ctx.fillText(pen.name.toUpperCase(), pen.x + radius + 12, pen.y - 8);
    }
    ctx.globalAlpha = 1;
  }

  // ---------------------------------------------------------------- effects
  private stepFx(dt: number): void {
    for (const p of this.particles) {
      p.vy += 420 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt;
    }
    this.particles = this.particles.filter((p) => p.life > 0);

    for (const p of this.pops) {
      p.y -= 22 * dt;
      p.life -= dt;
    }
    this.pops = this.pops.filter((p) => p.life > 0);
  }

  private drawParticles(): void {
    const ctx = this.ctx;
    for (const p of this.particles) {
      ctx.globalAlpha = Math.min(1, p.life / p.max);
      ctx.fillStyle = p.colour;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  private drawPops(): void {
    const ctx = this.ctx;
    ctx.font = "600 13px 'IBM Plex Mono', monospace";
    ctx.textAlign = "center";
    for (const p of this.pops) {
      ctx.globalAlpha = Math.min(1, p.life / 0.5);
      ctx.fillStyle = p.colour;
      ctx.fillText(p.text, p.x, p.y);
    }
    ctx.globalAlpha = 1;
  }
}
