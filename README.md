# Inkfall

**One player draws the level. Everyone else is already running through it.**

A browser multiplayer game. Each round, one player becomes **the drawer** — they get the pen and 45 seconds over an
empty pit. Everyone else spawns on the ledge and has to cross. The drawer scores for every
runner they drop — but scores **nothing** if nobody makes it out, so they can't just seal
the pit. They have to build something that looks survivable and mostly isn't.

The pen rotates: everyone draws exactly once per match.

```
Let one through. Kill the rest.
```

## Running it

```bash
npm install
npm run dev
```

Open http://localhost:5173. Open it again in a second window, paste the room code from the
first, and hit **Start match**. Two players minimum, eight maximum.

- `npm run dev` — game server (`:8787`) and Vite client (`:5173`) together
- `npm run build` — builds the client to `client/dist`, which the game server will then
  serve itself on `:8787` (single origin, no Vite needed)
- `npm run typecheck` — strict TS across client, server and shared

The server port is `GAME_PORT`, **not** `PORT` — dev harnesses set `PORT` to the client's
port and the two collide.

## Layout

```
shared/src/     the simulation, run identically on both sides of the wire
  constants.ts    every tunable, in px and seconds
  geom.ts         segment maths
  strokes.ts      InkBoard: draw, extend, erase, ink accounting
  runner.ts       stepRunner — one tick of one runner
  protocol.ts     the message union

server/src/
  room.ts         authoritative game loop, phases, scoring, rotation
  index.ts        ws + http, room registry, 30Hz tick for all rooms

client/src/
  main.ts         state, prediction, reconciliation, all DOM chrome
  net.ts          socket with backoff reconnect
  input.ts        keyboard for runners, pointer for the pen
  render.ts       canvas 2D
```

## How the netcode works

Server-authoritative, 30Hz tick, 20Hz snapshots, JSON over WebSocket.

**Runners.** Clients send inputs only — never positions. Each client predicts its own
runner by running the exact same `stepRunner` locally and keeps the inputs it hasn't seen
acknowledged. Every snapshot carries the last input sequence the server consumed; the
client rewinds to the server's position and replays the unacknowledged inputs on top. Any
residual error under 90px is absorbed as a decaying visual offset rather than a visible
snap. Other players' runners are interpolated one snapshot behind.

**The pen.** Stroke ops (`begin`/`point`/`end`) are relayed to everyone *except* the
drawer, who has already drawn them locally — so their own pen has no latency at all. The
server validates ink and refuses points that exceed the budget, then hands the drawer a
full board back so the two can't drift. Erase is deterministic given an identical board,
so it ships as a single op that every client applies to its own copy. A full board resync
goes out every 5 seconds regardless, to heal anything dropped.

**The drawer's cursor** is broadcast at 15Hz. This is not decoration — runners deciding
whether to commit to a bridge are reading that cursor.

Cheating is bounded by construction: the server owns every position, the ink budget and
the kill checks. A client can lie about its inputs and nothing else.

## Design rules that are load-bearing

- **Nobody escapes → the drawer scores zero.** Without this the optimal play is a wall and
  the game is dead. With it, the drawer has to be a bad host rather than a locked door.
- **Erasing refunds the ink.** This is what makes the bait-and-switch affordable, and the
  bait-and-switch is the moment the whole game exists for.
- **Spikes cost 2.2× a platform, and none within 46px of spawn.** Cruelty should be
  rationed, and spawn-camping isn't a strategy.
- **Runners respawn on a 1.6s timer; escaping is once per round.** Repeated attempts keep
  the pressure on the drawer for the full 45 seconds.

## Not built yet

- **Touch controls.** The pen works on touch; runners have no on-screen buttons.
- **Binary wire format.** JSON at 20Hz is ~10KB/s per client — fine for 8 players, the
  first thing to change if that stops being true.
- **Matchmaking beyond "leave the code blank".** That drops you into any room with space,
  which is enough for a handful of concurrent players and no more.
- **Accounts, cosmetics, persistence.** Nothing is stored; a room dies when it empties.
- **Spectator view for the drawer's own runner.** The drawer sits out their own round.
