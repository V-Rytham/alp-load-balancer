import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

import { config } from './config.js';
import { logger } from './logger.js';
import { StickySessions } from './stickySessions.js';

const clientFor = (protocol) => (protocol === 'https:' ? https : http);

// Errors that mean "this backend is not answering", as opposed to "this request
// took a long time", which is normal for a long-poll.
const CONNECTION_ERRORS = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE',
]);

// The exact payload Engine.IO sends for an unrecognised sid. Returning it from
// the balancer makes the client re-handshake immediately instead of retrying a
// session no backend can serve.
const UNKNOWN_SESSION = JSON.stringify({ code: 1, message: 'Session ID unknown' });

const isSocketRequest = (url) => url.startsWith(config.socketPathPrefix);

const buildUpstreamOptions = (req, targetUrl, timeoutMs) => {
  const upstream = new URL(req.url, targetUrl);
  const forwardedFor = req.headers['x-forwarded-for'];
  const clientIp = req.socket.remoteAddress || '';

  const headers = {
    ...req.headers,
    host: upstream.host,
    // Append, never overwrite: preserves the chain when another proxy (Render's
    // edge) already added a hop.
    'x-forwarded-for': forwardedFor ? `${forwardedFor}, ${clientIp}` : clientIp,
    // Must describe how the CLIENT reached us, not how we reach the backend.
    'x-forwarded-proto': req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http'),
    'x-forwarded-host': req.headers['x-forwarded-host'] || req.headers.host || upstream.host,
  };

  return {
    protocol: upstream.protocol,
    hostname: upstream.hostname,
    port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
    path: `${upstream.pathname}${upstream.search}`,
    method: req.method,
    headers,
    timeout: timeoutMs,
    agent: false,
  };
};

/**
 * Decides which backend serves a request.
 *
 * Stateless traffic round-robins. Socket traffic that names a session (`?sid=`)
 * is pinned to the backend that owns it.
 */
const resolveTarget = (req, { pool, sticky }) => {
  const sid = isSocketRequest(req.url) ? StickySessions.sidFrom(req.url) : null;

  if (!sid) {
    const url = pool.next();
    return url ? { url, sid: null } : { error: 'no_healthy_backends' };
  }

  const pinned = sticky.get(sid);
  if (!pinned) return { error: 'unknown_session', sid };
  if (!pool.isHealthy(pinned)) {
    sticky.delete(sid);
    return { error: 'unknown_session', sid };
  }
  return { url: pinned, sid };
};

const rejectUnknownSession = (res) => {
  res.writeHead(400, { 'content-type': 'application/json' });
  res.end(UNKNOWN_SESSION);
};

export const forwardRequest = (req, res, ctx) => {
  const { pool, sticky } = ctx;
  const socketTraffic = isSocketRequest(req.url);
  const route = resolveTarget(req, ctx);

  if (route.error === 'unknown_session') {
    logger.warn('unknown session, forcing re-handshake', { sid: route.sid });
    rejectUnknownSession(res);
    return;
  }
  if (route.error) {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'no_healthy_backends' }));
    return;
  }

  const timeoutMs = socketTraffic ? config.socketTimeoutMs : config.requestTimeoutMs;
  const options = buildUpstreamOptions(req, route.url, timeoutMs);
  const proxyReq = clientFor(options.protocol).request(options, (proxyRes) => {
    // A response of any status proves the backend is reachable, which is the only
    // recovery signal available when active probing is disabled.
    pool.markUp(route.url);

    // Learn the sid from a handshake so its follow-up requests can be pinned.
    const isHandshake = socketTraffic && !route.sid && proxyRes.statusCode === 200;
    if (isHandshake) {
      let captured = false;
      proxyRes.on('data', (chunk) => {
        if (captured) return;
        const sid = StickySessions.sidFromHandshake(chunk.toString('utf8'));
        if (sid) {
          captured = true;
          sticky.set(sid, route.url);
          logger.info('session pinned', { sid, backend: route.url });
        }
      });
    }

    res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('timeout', () => {
    // Not a health signal. Fail this one request only.
    proxyReq.destroy(new Error('proxy timeout'));
  });

  proxyReq.on('error', (error) => {
    if (CONNECTION_ERRORS.has(error.code)) pool.markDown(route.url, error.code);
    logger.error('upstream error', { backend: route.url, path: options.path, reason: error.message });
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'upstream_unavailable' }));
  });

  req.pipe(proxyReq);
};

const abortSocket = (socket, status, reason, body = '') => {
  const payload = body ? `\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}` : '';
  socket.write(`HTTP/1.1 ${status} ${reason}${payload}\r\n\r\n${body}`);
  socket.destroy();
};

export const forwardUpgrade = (req, socket, head, ctx) => {
  const { pool, sticky } = ctx;
  const route = resolveTarget(req, ctx);

  if (route.error === 'unknown_session') {
    abortSocket(socket, 400, 'Bad Request', UNKNOWN_SESSION);
    return;
  }
  if (route.error) {
    abortSocket(socket, 503, 'Service Unavailable');
    return;
  }

  const options = buildUpstreamOptions(req, route.url, config.socketTimeoutMs);
  options.headers.connection = 'upgrade';
  options.headers.upgrade = req.headers.upgrade || 'websocket';

  const proxyReq = clientFor(options.protocol).request(options);

  proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
    pool.markUp(route.url);

    // The tunnel is now client<->backend; neither side should carry an idle
    // timeout, and Nagle would add latency to small realtime frames.
    proxySocket.setTimeout(0);
    proxySocket.setNoDelay(true);
    socket.setTimeout(0);
    socket.setNoDelay(true);

    const headers = Object.entries(proxyRes.headers)
      .map(([key, value]) => `${key}: ${value}`)
      .join('\r\n');
    socket.write(`HTTP/1.1 101 ${proxyRes.statusMessage || 'Switching Protocols'}\r\n${headers}\r\n\r\n`);

    if (proxyHead?.length) proxySocket.unshift(proxyHead);

    const teardown = () => { proxySocket.destroy(); socket.destroy(); };
    proxySocket.on('error', teardown);
    socket.on('error', teardown);

    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
  });

  // A backend that answers an Upgrade with a normal response is refusing it.
  proxyReq.on('response', (proxyRes) => {
    const headers = Object.entries(proxyRes.headers)
      .map(([key, value]) => `${key}: ${value}`)
      .join('\r\n');
    socket.write(`HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage || ''}\r\n${headers}\r\n\r\n`);
    proxyRes.pipe(socket);
  });

  proxyReq.on('error', (error) => {
    if (CONNECTION_ERRORS.has(error.code)) pool.markDown(route.url, error.code);
    logger.error('upgrade failed', { backend: route.url, reason: error.message });
    abortSocket(socket, 502, 'Bad Gateway');
  });

  socket.on('error', () => proxyReq.destroy());
  proxyReq.end(head);
};
