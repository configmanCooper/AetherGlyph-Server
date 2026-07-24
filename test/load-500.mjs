import { io as connect } from 'socket.io-client';

import { createGameServer } from '../server.js';
import { starterLoadout } from '../shared/src/balance/loadouts.js';
import {
  PROTOCOL_VERSION, BALANCE_VERSION, ROSTER_CHECKSUM,
} from '../shared/src/protocol/version.js';
import { EVENTS } from '../shared/src/protocol/events.js';

const players = Math.max(2, Number(process.env.PLAYERS || 500));
const durationMs = Math.max(2000, Number(process.env.DURATION_MS || 5000));
const loadout = starterLoadout().map((spell) => spell.id);
const server = createGameServer({
  maxConnections: players + 20,
  maxConnectionsPerIp: players + 20,
  secret: 'load-test-secret',
  ratingStore: {
    kind: 'load-test',
    getRating: async () => 1000,
    recordResult: async () => {},
    close: async () => {},
  },
});
const sockets = [];
let snapshots = 0;
let snapshotBytes = 0;
let connectErrors = 0;
const connectErrorMessages = {};

function waitFor(condition, timeoutMs, label) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (condition()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for ${label}`));
      }
    }, 50);
  });
}

try {
  const port = await server.listen(0);
  const url = `http://127.0.0.1:${port}`;
  const started = Date.now();
  const batchSize = Math.max(1, Number(process.env.BATCH_SIZE || 25));
  for (let index = 0; index < players; index++) {
    const socket = connect(url, {
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
      auth: {
        protocol: PROTOCOL_VERSION,
        balance: BALANCE_VERSION,
        roster: ROSTER_CHECKSUM,
        clientId: `load-${index}`,
        name: `Load ${index}`,
      },
    });
    socket.on('connect_error', (error) => {
      connectErrors += 1;
      const message = error?.message || 'unknown';
      connectErrorMessages[message] = (connectErrorMessages[message] || 0) + 1;
    });
    socket.on(EVENTS.SNAPSHOT, (payload) => {
      snapshots += 1;
      snapshotBytes += Buffer.byteLength(JSON.stringify(payload));
    });
    socket.on('connect', () => {
      socket.emit(EVENTS.QUICK_MATCH, { loadout, name: `Load ${index}` }, () => {});
    });
    sockets.push(socket);
    if ((index + 1) % batchSize === 0) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  await waitFor(
    () => server.io.engine.clientsCount >= players - connectErrors,
    30000,
    `${players} connections`,
  );
  await waitFor(
    () => server.rooms.stats().matches >= Math.floor((players - connectErrors) / 2),
    30000,
    'matchmaking',
  );
  await new Promise((resolve) => setTimeout(resolve, durationMs));

  const health = await (await fetch(`${url}/healthz`)).json();
  const elapsedS = (Date.now() - started) / 1000;
  console.log(JSON.stringify({
    requestedPlayers: players,
    connected: health.connections,
    connectErrors,
    connectErrorMessages,
    matches: health.matches,
    snapshots,
    averageSnapshotBytes: snapshots ? Math.round(snapshotBytes / snapshots) : 0,
    applicationPayloadMbps: +(snapshotBytes * 8 / elapsedS / 1e6).toFixed(2),
    memoryMb: health.memoryMb,
    eventLoopP95Ms: health.eventLoopP95Ms,
    snapshotHz: health.snapshotHz,
  }, null, 2));

  if (connectErrors > 0 || health.matches < Math.floor(players / 2)) {
    throw new Error('Load target was not reached.');
  }
} finally {
  for (const socket of sockets) socket.close();
  await server.close('load test complete');
}
