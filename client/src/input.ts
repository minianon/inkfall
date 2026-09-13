import { H, W } from "../../shared/src/constants";
import type { Tool } from "../../shared/src/protocol";

export interface PenEvents {
  onDown: (x: number, y: number) => void;
  onMove: (x: number, y: number, down: boolean) => void;
  onUp: () => void;
}

export class Input {
  left = false;
  right = false;
  jump = false;

  tool: Tool = "ink";
  penX = -99;
  penY = -99;
  penDown = false;
  penVisible = false;

  /** Set by the owner — the pen is inert unless this player holds it. */
  canDraw = false;
  onToolChange: (tool: Tool) => void = () => {};

  constructor(private canvas: HTMLCanvasElement, private pen: PenEvents) {
    addEventListener("keydown", this.onKey);
    addEventListener("keyup", this.onKey);
    addEventListener("blur", this.releaseAll);

    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerUp);
    canvas.addEventListener("pointerleave", () => {
      this.penVisible = false;
      this.onPointerUp();
    });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());

    this.bindTouch("t-left", "left");
    this.bindTouch("t-right", "right");
    this.bindTouch("t-jump", "jump");
  }

  /** Whether this device wants on-screen controls at all. */
  static get isTouch(): boolean {
    return matchMedia("(pointer: coarse)").matches || navigator.maxTouchPoints > 0;
  }

  private bindTouch(id: string, key: "left" | "right" | "jump"): void {
    const el = document.getElementById(id);
    if (!el) return;
    const set = (down: boolean) => (e: PointerEvent) => {
      e.preventDefault();
      this[key] = down;
      el.classList.toggle("held", down);
    };
    el.addEventListener("pointerdown", set(true));
    // Up, cancel and leave all have to release, or a finger that slides off sticks.
    for (const ev of ["pointerup", "pointercancel", "pointerleave"]) {
      el.addEventListener(ev, set(false) as EventListener);
    }
  }

  setTool(tool: Tool): void {
    if (this.tool === tool) return;
    this.tool = tool;
    this.onToolChange(tool);
  }

  private onKey = (e: KeyboardEvent) => {
    const down = e.type === "keydown";
    // Typing a room code shouldn't make your runner sprint off the ledge.
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;

    switch (e.code) {
      case "ArrowLeft": case "KeyA": this.left = down; break;
      case "ArrowRight": case "KeyD": this.right = down; break;
      case "Space": case "ArrowUp": case "KeyW":
        this.jump = down;
        if (down) e.preventDefault();
        break;
      case "Digit1": if (down && this.canDraw) this.setTool("ink"); break;
      case "Digit2": if (down && this.canDraw) this.setTool("spike"); break;
      case "Digit3": if (down && this.canDraw) this.setTool("erase"); break;
      default: return;
    }
  };

  private releaseAll = () => {
    this.left = this.right = this.jump = false;
    this.onPointerUp();
  };

  private toWorld(e: PointerEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * W,
      y: ((e.clientY - r.top) / r.height) * H,
    };
  }

  private onPointerDown = (e: PointerEvent) => {
    const p = this.toWorld(e);
    this.penX = p.x;
    this.penY = p.y;
    this.penVisible = true;
    if (!this.canDraw) return;
    e.preventDefault();
    // Capture can fail for a pointer the browser has already released.
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* keep drawing without capture */
    }
    this.penDown = true;
    this.pen.onDown(p.x, p.y);
  };

  private onPointerMove = (e: PointerEvent) => {
    const p = this.toWorld(e);
    this.penX = p.x;
    this.penY = p.y;
    this.penVisible = true;
    if (!this.canDraw) return;
    this.pen.onMove(p.x, p.y, this.penDown);
  };

  private onPointerUp = () => {
    if (!this.penDown) return;
    this.penDown = false;
    this.pen.onUp();
  };
}
