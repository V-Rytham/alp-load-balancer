// Loads .env before any module reads process.env (ESM evaluates imports in order).
import 'dotenv/config';

import http from 'node:http';

import { config } from './src/config.js';
import { logger } from './src/logger.js';
import { BackendPool } from './src/backendPool.js';
import { StickySessions } from './src/stickySessions.js';
import { forwardRequest, forwardUpgrade } from './src/proxy.js';

if (config.targets.length === 0) {
  logger.error('BACKEND_TARGETS is empty; nothing to balance');
  process.exit(1);
}

const pool = new BackendPool(config.targets);
const sticky = new StickySessions();
const ctx = { pool, sticky };

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    const healthy = pool.healthyCount;
    res.writeHead(healthy > 0 ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: healthy > 0, healthy, total: pool.size, pinnedSessions: sticky.size }));
    return;
  }
  forwardRequest(req, res, ctx);
});

server.on('upgrade', (req, socket, head) => forwardUpgrade(req, socket, head, ctx));

pool.startHealthChecks();
sticky.start();

server.listen(config.port, () => {
  logger.info('listening', { port: config.port, targets: pool.size });
});

const shutdown = (signal) => {
  logger.info('shutting down', { signal });
  pool.stopHealthChecks();
  sticky.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10_000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
