import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

import { config } from './config.js';
import { logger } from './logger.js';

const clientFor = (protocol) => (protocol === 'https:' ? https : http);

/**
 * Owns the backend list, their health, and round-robin selection.
 *
 * Health is passive by default and never inferred from a slow request. A backend
 * leaves rotation only on a connection-level failure (ECONNREFUSED, ENOTFOUND,
 * ...) and rejoins either when a probe succeeds or, if probing is disabled, once
 * a cooldown elapses and one request is let through to test it (half-open).
 *
 * A proxied request that times out does NOT trip the breaker: a long-poll a
 * client left idle is normal traffic, and a cold-starting instance is slow, not
 * dead. Treating either as failure takes healthy instances out of rotation.
 *
 * Active probing (`HEALTH_CHECK_INTERVAL_MS > 0`) detects failures sooner, but
 * counts as inbound traffic. On platforms that suspend idle instances it holds
 * every backend awake, so it can be turned off.
 */
export class BackendPool {
  constructor(urls, { cooldownMs = config.failureCooldownMs } = {}) {
    this.cooldownMs = cooldownMs;
    // `downUntil = 0` means in rotation. Otherwise it is the epoch ms after which
    // one trial request may pass.
    this.backends = urls.map((url) => ({ url, downUntil: 0 }));
    this.cursor = 0;
    this.timer = null;
  }

  get size() {
    return this.backends.length;
  }

  get healthyCount() {
    return this.backends.filter((backend) => this.#inRotation(backend)).length;
  }

  get probing() {
    return config.healthIntervalMs > 0;
  }

  #find(url) {
    return this.backends.find((backend) => backend.url === url);
  }

  #inRotation(backend) {
    return backend.downUntil === 0 || Date.now() >= backend.downUntil;
  }

  isHealthy(url) {
    const backend = this.#find(url);
    return Boolean(backend && this.#inRotation(backend));
  }

  next() {
    const available = this.backends.filter((backend) => this.#inRotation(backend));
    if (available.length === 0) return null;

    const backend = available[this.cursor % available.length];
    this.cursor = (this.cursor + 1) % available.length;
    return backend.url;
  }

  /** Trip the breaker. Only ever called for connection-level failures. */
  markDown(url, reason) {
    const backend = this.#find(url);
    if (!backend) return;
    backend.downUntil = Date.now() + this.cooldownMs;
    logger.warn('backend out of rotation', { url, reason, retryInMs: this.cooldownMs });
  }

  /** Any successful exchange proves the backend is serving. */
  markUp(url) {
    const backend = this.#find(url);
    if (!backend || backend.downUntil === 0) return;
    backend.downUntil = 0;
    logger.info('backend back in rotation', { url });
  }

  #probe(url) {
    return new Promise((resolve) => {
      let target;
      try {
        target = new URL(`${url}${config.healthPath}`);
      } catch {
        resolve({ ok: false, reason: 'invalid health url' });
        return;
      }

      const req = clientFor(target.protocol).request(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || (target.protocol === 'https:' ? 443 : 80),
          path: `${target.pathname}${target.search}`,
          method: 'GET',
          timeout: config.healthTimeoutMs,
        },
        (res) => {
          const status = res.statusCode || 0;
          res.resume();
          resolve(status >= 200 && status < 400 ? { ok: true } : { ok: false, reason: `HTTP ${status}` });
        },
      );

      req.on('timeout', () => req.destroy(new Error('health timeout')));
      req.on('error', (error) => resolve({ ok: false, reason: error.message }));
      req.end();
    });
  }

  async runHealthChecks() {
    await Promise.all(this.backends.map(async ({ url }) => {
      const { ok, reason } = await this.#probe(url);
      if (ok) this.markUp(url);
      else this.markDown(url, reason);
    }));
  }

  startHealthChecks() {
    if (!this.probing) {
      logger.info('active health probing disabled; using passive breaker', { cooldownMs: this.cooldownMs });
      return;
    }
    void this.runHealthChecks();
    this.timer = setInterval(() => { void this.runHealthChecks(); }, config.healthIntervalMs);
    this.timer.unref?.();
  }

  stopHealthChecks() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
