import { URL } from 'node:url';

const num = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

// Distinct from `num`: 0 is meaningful here (it disables a feature), so it must
// not collapse into the fallback.
const numOrZero = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const hostnameOf = (value) => {
  try {
    return new URL(value.startsWith('http') ? value : `https://${value}`).hostname;
  } catch {
    return null;
  }
};

// A target list that contains the balancer's own hostname would make it proxy to
// itself; drop those entries at boot rather than discovering the loop at runtime.
const selfHostnames = new Set(
  [process.env.SELF_URL, process.env.RENDER_EXTERNAL_URL, process.env.RENDER_EXTERNAL_HOSTNAME]
    .filter(Boolean)
    .map(hostnameOf)
    .filter(Boolean),
);

const parseTargets = (raw) => raw
  .split(',')
  .map((value) => value.trim().replace(/\/$/, ''))
  .filter(Boolean)
  .filter((url) => {
    const hostname = hostnameOf(url);
    return !hostname || !selfHostnames.has(hostname);
  });

export const config = {
  port: num(process.env.PORT, 10000),
  targets: parseTargets(process.env.BACKEND_TARGETS || ''),

  healthPath: process.env.HEALTH_CHECK_PATH || '/api/health',
  // 0 disables active probing. Required on hosts that suspend idle instances
  // (Render's free tier): a probe is inbound traffic, so polling would hold every
  // backend awake and burn the workspace's instance-hour budget. With probing off
  // the pool falls back to passive health -- see BackendPool.
  healthIntervalMs: numOrZero(process.env.HEALTH_CHECK_INTERVAL_MS, 15_000),
  healthTimeoutMs: num(process.env.HEALTH_CHECK_TIMEOUT_MS, 5_000),

  // How long a backend stays out of rotation after a connection failure before
  // one request is allowed through to test it again (circuit-breaker half-open).
  failureCooldownMs: num(process.env.FAILURE_COOLDOWN_MS, 30_000),

  // Ordinary REST calls should fail fast -- unless the platform cold-starts idle
  // instances, in which case the first request must outlast the spin-up.
  requestTimeoutMs: num(process.env.PROXY_TIMEOUT_MS, 10_000),

  // Engine.IO holds a long-poll GET open for up to `pingInterval` (25s) and only
  // considers a peer dead after `pingTimeout` (60s). A proxy timeout below
  // 85s therefore severs healthy connections on a fixed cadence. Default well
  // above that ceiling.
  socketTimeoutMs: num(process.env.SOCKET_PROXY_TIMEOUT_MS, 120_000),

  // Affinity entries outlive a transport hop but must not leak. One idle Engine.IO
  // lifetime (pingInterval + pingTimeout) plus headroom.
  stickyTtlMs: num(process.env.STICKY_TTL_MS, 120_000),

  socketPathPrefix: process.env.SOCKET_PATH_PREFIX || '/socket.io/',
};
