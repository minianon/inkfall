import type { Stroke, StrokeKind } from "./strokes";

export type Tool = "ink" | "spike" | "erase";
export type Phase = "lobby" | "prep" | "round" | "intermission" | "final";

export interface PlayerInfo {
  id: string;
  name: string;
  colour: string;
  score: number;
  connected: boolean;
  /** Has already held the pen this match. */
  hasDrawn: boolean;
}

/** Runner state on the wire. Short keys — this ships 20 times a second. */
export interface WireRunner {
  i: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** 0 alive · 1 down · 2 out */
  st: 0 | 1 | 2;
  /** Last input sequence the server has consumed for this player. */
  s: number;
  /** 1 when standing on something. */
  g: 0 | 1;
}

export interface ScoreRow {
  id: string;
  name: string;
  colour: string;
  score: number;
  /** Points earned in the round that just finished. */
  delta: number;
}

// ---------------------------------------------------------------- client → server
export type ClientMsg =
  | { t: "join"; room: string; name: string; pid?: string }
  | { t: "input"; seq: number; l: 0 | 1; r: 0 | 1; j: 0 | 1 }
  | { t: "pen"; op: "begin"; kind: StrokeKind; x: number; y: number }
  | { t: "pen"; op: "point"; x: number; y: number }
  | { t: "pen"; op: "end" }
  | { t: "pen"; op: "erase"; x: number; y: number }
  | { t: "cursor"; x: number; y: number; tool: Tool }
  | { t: "start" }
  | { t: "ping"; ts: number };

// ---------------------------------------------------------------- server → client
export type ServerMsg =
  | { t: "welcome"; you: string; room: string; tickHz: number }
  | { t: "lobby"; players: PlayerInfo[]; hostId: string | null }
  | {
      t: "phase";
      phase: Phase;
      drawerId: string | null;
      roundIndex: number;
      totalRounds: number;
      /** Server time in ms until this phase ends. */
      endsInMs: number;
    }
  | { t: "board"; strokes: Stroke[]; inkUsed: number }
  | { t: "penBegin"; id: number; kind: StrokeKind; x: number; y: number; inkUsed: number }
  | { t: "penPoint"; id: number; x: number; y: number; inkUsed: number }
  | { t: "penEnd"; inkUsed: number }
  | { t: "penErase"; x: number; y: number; inkUsed: number }
  | { t: "snap"; tick: number; runners: WireRunner[] }
  | { t: "cursor"; x: number; y: number; tool: Tool; down: 0 | 1 }
  | { t: "fx"; kind: "down" | "out"; id: string; x: number; y: number; cause?: "spike" | "pit" }
  | { t: "scores"; rows: ScoreRow[]; escaped: number; downed: number; wipe: boolean }
  | { t: "toast"; text: string; tone?: "info" | "warn" }
  | { t: "pong"; ts: number };

export function encode(msg: ServerMsg | ClientMsg): string {
  return JSON.stringify(msg);
}

export function decode<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
