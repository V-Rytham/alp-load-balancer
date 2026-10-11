# ALP Load Balancer

A custom Node.js load balancer for **After the Last Page**, my book platform. It distributes API requests across backend instances and keeps Socket.IO sessions connected to the instance that created them.

Built with Node.js HTTP/HTTPS modules; `dotenv` is the only external dependency.

## What it handles

- **Round-robin routing** across available backends.
- **Socket.IO affinity** using Engine.IO session IDs, including polling-to-WebSocket upgrades.
- **Failure cooldowns** that temporarily remove unreachable backends from rotation, with optional active health checks.
- **Separate timeouts** for API requests and long-polling connections.
- **Health endpoint** at `/healthz`, reporting backend availability and pinned sessions.

Session mappings are stored in memory. Restarting the balancer requires clients to reconnect; multiple balancer instances do not share mappings.

## Run locally

With Node.js and npm installed:

```bash
git clone https://github.com/V-Rytham/alp-load-balancer.git
cd alp-load-balancer
npm ci
```

Create a `.env` file pointing to your running backends:

```env
PORT=10000
BACKEND_TARGETS=http://localhost:3001,http://localhost:3002
HEALTH_CHECK_PATH=/api/health
HEALTH_CHECK_INTERVAL_MS=15000
```

```bash
npm start
curl http://localhost:10000/healthz
```

Send API and Socket.IO traffic through `http://localhost:10000`. Backends should serve the configured health path. Set `HEALTH_CHECK_INTERVAL_MS=0` to disable active probes on hosts that suspend idle instances.

## Code layout

| File | Responsibility |
| --- | --- |
| `server.js` | Server startup, health endpoint and shutdown |
| `src/backendPool.js` | Backend selection and health tracking |
| `src/proxy.js` | HTTP forwarding and WebSocket tunnels |
| `src/stickySessions.js` | Session affinity and expiry |
| `src/config.js` | Environment settings and defaults |
| `src/logger.js` | Console logging |
