# Aetherglyph Authoritative Render Server

This is a separate, asset-free deployment package for Aetherglyph online play.
It contains only the deterministic simulation, gesture recognizer, matchmaking,
private rooms, reconnect/resume handling, temporary username/PIN authentication,
and PostgreSQL-backed Glyph rankings.

It does **not** include or serve the game client, Three.js, graphics, music, or
screenshots. Android, Windows, and web clients carry their own assets and connect
directly through Socket.IO. It serves only two small required legal HTML pages:
`/privacy.html` and `/account-deletion.html`.

## Render deployment

1. Put this folder in its own private repository.
2. Create a Render Blueprint from `render.yaml`.
3. Set `ALLOWED_ORIGINS` to any web origins that should connect. Native Capacitor
   apps and loopback-hosted Windows apps are accepted automatically.
4. Keep `numInstances: 1`. Match ownership is in memory; horizontal scaling
   requires shared match leases and queue ownership.
5. Use a paid always-on plan for production. The configured `standard` plan is
   the recommended starting point for up to roughly 500 concurrent players.

The health endpoint reports connections, active matches, memory, event-loop lag,
snapshot rate, and ranking-store type:

```text
GET /healthz
```

## Bandwidth/performance choices

- 60 Hz authoritative deterministic simulation.
- 10 Hz compressed snapshots.
- Nonterminal snapshots use Socket.IO volatile delivery, preventing stale frame
  backlogs on slow clients.
- Small WebSocket compression threshold (256 bytes).
- No static asset traffic.
- Cast and input payload/rate limits remain enforced.
- Ping/resume/leave events are rate-limited, with global and per-IP connection
  caps to prevent a reconnect storm from consuming all player slots.

## Local verification

```powershell
npm install
npm test
$env:PLAYERS=500
npm run load:500
```

The load test starts the server, connects clients over WebSocket, fills quick
matchmaking, and reports matches, snapshot throughput, memory, and event-loop lag.

## Updating from the game project

Run `sync-from-game.ps1` after authoritative simulation/server changes. It copies
only `shared\` and `server\`, then reapplies the dedicated 10 Hz/volatile snapshot
settings. Review and rerun both tests afterward.
