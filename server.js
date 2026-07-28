import express from 'express';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';

import { RoomManager } from './server/roomManager.js';
import { createRatingStore } from './server/ratings.js';
import { randomSecret } from './server/tokens.js';
import { NET } from './shared/src/protocol/net.js';
import {
  PROTOCOL_VERSION, BALANCE_VERSION, ROSTER_CHECKSUM, APP_PHASE, versionTag,
} from './shared/src/protocol/version.js';

const ROOT = dirname(fileURLToPath(import.meta.url));

function parseOrigins(value) {
  return String(value || '').split(',').map((origin) => origin.trim()).filter(Boolean);
}

function makeOriginGate(allowed) {
  const LOCALHOST = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i;
  const CAPACITOR = /^(?:capacitor|ionic|https?):\/\/localhost$/i;
  return (origin, callback) => {
    if (!origin || LOCALHOST.test(origin) || CAPACITOR.test(origin) || allowed.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error('Origin not allowed'));
  };
}

export function createGameServer(opts = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  const server = http.createServer(app);
  server.keepAliveTimeout = 5000;
  server.headersTimeout = 7000;

  const allowedOrigins = opts.allowedOrigins || parseOrigins(process.env.ALLOWED_ORIGINS);
  const maxConnections = Number(opts.maxConnections || process.env.MAX_CONNECTIONS || 600);
  const maxConnectionsPerIp = Number(
    opts.maxConnectionsPerIp || process.env.MAX_CONNECTIONS_PER_IP || 50,
  );
  const connectionsByIp = new Map();
  const secret = opts.secret || process.env.SESSION_SECRET || randomSecret();
  const eventLoop = monitorEventLoopDelay({ resolution: 20 });
  eventLoop.enable();

  const io = new Server(server, {
    serveClient: false,
    cors: { origin: makeOriginGate(allowedOrigins), methods: ['GET', 'POST'] },
    maxHttpBufferSize: 16 * 1024,
    pingTimeout: 20000,
    pingInterval: 12000,
    perMessageDeflate: {
      threshold: 256,
      concurrencyLimit: 16,
      zlibDeflateOptions: { level: 4, memLevel: 7 },
    },
    httpCompression: true,
  });

  let rooms = null;
  let ratingStore = opts.ratingStore || null;

  app.use((_request, response, next) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    response.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.get('/', (_request, response) => {
    response.json({
      service: 'aetherglyph-authoritative-server',
      assetsServed: false,
      version: versionTag(),
    });
  });
  app.get('/privacy.html', (_request, response) => {
    response.sendFile(join(ROOT, 'legal', 'privacy.html'));
  });
  app.get('/account-deletion.html', (_request, response) => {
    response.sendFile(join(ROOT, 'legal', 'account-deletion.html'));
  });

  app.get('/healthz', (_request, response) => {
    const memory = process.memoryUsage();
    response.json({
      ok: true,
      phase: APP_PHASE,
      service: 'aetherglyph-server',
      version: versionTag(),
      connections: io.engine.clientsCount,
      capacity: maxConnections,
      capacityPerIp: maxConnectionsPerIp,
      rating: ratingStore ? ratingStore.kind : 'pending',
      memoryMb: Math.round(memory.rss / 1024 / 1024),
      eventLoopP95Ms: Math.round(eventLoop.percentile(95) / 1e6),
      snapshotHz: NET.SNAPSHOT_HZ,
      ...(rooms ? rooms.stats() : { rooms: 0, queue: 0, matches: 0 }),
    });
  });

  io.use(async (socket, next) => {
    if (io.engine.clientsCount > maxConnections) {
      const error = new Error('Server full');
      error.data = { code: 'capacity' };
      next(error);
      return;
    }
    const auth = socket.handshake.auth || {};
    if (Number(auth.protocol) !== PROTOCOL_VERSION
        || Number(auth.balance) !== BALANCE_VERSION
        || String(auth.roster) !== String(ROSTER_CHECKSUM)) {
      const error = new Error('Incompatible client - update required');
      error.data = { code: 'incompatible', server: versionTag() };
      next(error);
      return;
    }
    const ip = socket.handshake.address || 'unknown';
    const count = connectionsByIp.get(ip) || 0;
    if (count >= maxConnectionsPerIp) {
      const error = new Error('Too many connections from this address');
      error.data = { code: 'ip-capacity' };
      next(error);
      return;
    }
    connectionsByIp.set(ip, count + 1);
    socket.data.capacityIp = ip;
    try {
      if (auth.accountToken && ratingStore) {
        socket.data.verifiedAccount = await ratingStore.resolveTemporarySession(auth.accountToken);
      }
      next();
    } catch (error) {
      connectionsByIp.set(ip, Math.max(0, (connectionsByIp.get(ip) || 1) - 1));
      next(new Error(`Account session verification failed: ${error.message}`));
    }
  });

  async function listen(port) {
    if (!ratingStore) ratingStore = await createRatingStore();
    rooms = new RoomManager(io, {
      secret,
      ratingStore,
      graceMs: opts.graceMs,
      intermissionMs: opts.intermissionMs,
      privateLobbyGraceMs: opts.privateLobbyGraceMs,
      rankedRange: opts.rankedRange,
      rankedRangeWaitMs: opts.rankedRangeWaitMs,
      requireAccounts: opts.requireAccounts,
      log: (...args) => console.warn('[rooms]', ...args),
    });
    io.on('connection', (socket) => {
      const ip = socket.data.capacityIp;
      socket.once('disconnect', () => {
        if (!ip) return;
        const remaining = Math.max(0, (connectionsByIp.get(ip) || 1) - 1);
        if (remaining > 0) connectionsByIp.set(ip, remaining);
        else connectionsByIp.delete(ip);
      });
      rooms.register(socket);
    });
    const target = port === undefined ? Number(process.env.PORT || 10000) : port;
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(target, '0.0.0.0', () => {
        server.off('error', reject);
        resolve();
      });
    });
    return server.address().port;
  }

  async function close(reason) {
    if (rooms) rooms.close(reason);
    eventLoop.disable();
    await new Promise((resolve) => io.close(resolve));
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    if (ratingStore?.close) {
      try { await ratingStore.close(); } catch { /* best effort */ }
    }
  }

  return { app, server, io, get rooms() { return rooms; }, listen, close };
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const gameServer = createGameServer();
  gameServer.listen().then((port) => {
    console.log(`Aetherglyph authoritative server listening on ${port} [${versionTag()}]`);
    console.log(`tick=${NET.TICK_HZ}Hz snapshots=${NET.SNAPSHOT_HZ}Hz assets=none`);
  }).catch((error) => {
    console.error('[server] startup failed:', error);
    process.exit(1);
  });

  let shuttingDown = false;
  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('[server] draining matches...');
    if (gameServer.rooms) gameServer.rooms.drain('Server maintenance');
    setTimeout(() => {
      gameServer.close('Server maintenance').finally(() => process.exit(0));
    }, 400).unref();
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
