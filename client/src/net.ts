import { decode, encode, type ClientMsg, type ServerMsg } from "../../shared/src/protocol";

const RECONNECT_MS = [400, 800, 1600, 3000, 5000];

export class Net {
  rtt = 0;
  connected = false;

  onMessage: (msg: ServerMsg) => void = () => {};
  onStatus: (connected: boolean) => void = () => {};

  private ws: WebSocket | null = null;
  private attempt = 0;
  private pingTimer: number | null = null;
  private room = "";
  private name = "";
  private pid = "";
  private closedByUs = false;

  connect(room: string, name: string, pid: string): void {
    this.room = room;
    this.name = name;
    this.pid = pid;
    this.closedByUs = false;
    this.open();
  }

  disconnect(): void {
    this.closedByUs = true;
    this.ws?.close();
  }

  send(msg: ClientMsg): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(encode(msg));
  }

  private open(): void {
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${scheme}://${location.host}/ws`);
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.attempt = 0;
      this.connected = true;
      this.onStatus(true);
      // The room we were given may have been assigned by the server last time;
      // reuse it so a reconnect lands us back with the same people.
      this.send({ t: "join", room: this.room, name: this.name, pid: this.pid });
      this.pingTimer = window.setInterval(() => this.send({ t: "ping", ts: performance.now() }), 2000);
    });

    ws.addEventListener("message", (ev) => {
      const msg = decode<ServerMsg>(String(ev.data));
      if (!msg) return;
      if (msg.t === "pong") {
        this.rtt = Math.round(performance.now() - msg.ts);
        return;
      }
      if (msg.t === "welcome") this.room = msg.room;
      this.onMessage(msg);
    });

    // Settled per socket, not per client: a failed retry must still queue another.
    let settled = false;
    const drop = () => {
      if (settled) return;
      settled = true;
      if (this.pingTimer !== null) {
        clearInterval(this.pingTimer);
        this.pingTimer = null;
      }
      if (this.connected) {
        this.connected = false;
        this.onStatus(false);
      }
      if (this.closedByUs) return;
      const wait = RECONNECT_MS[Math.min(this.attempt++, RECONNECT_MS.length - 1)];
      setTimeout(() => this.open(), wait);
    };

    ws.addEventListener("close", drop);
    ws.addEventListener("error", drop);
  }
}
