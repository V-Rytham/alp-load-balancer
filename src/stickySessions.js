import { config } from './config.js';

// Engine.IO's polling handshake replies with an "open" packet: 0{"sid":"...",...}
const SID_IN_BODY = /"sid"\s*:\s*"([^"]+)"/;

/**
 * Maps an Engine.IO session id to the backend that issued it.
 *
 * Engine.IO stores a session in the memory of the single process that created
 * it. The handshake (`GET /socket.io/?EIO=4&transport=polling`, no sid) may be
 * served by any backend, but every subsequent request carries `?sid=` and MUST
 * reach that same process, or it answers HTTP 400 {"code":1,"message":"Session
 * ID unknown"} and the client reconnects forever.
 *
 * The sid is learned by reading it out of the handshake response body, which
 * keeps affinity transport-agnostic: it needs no cookie jar on the client and
 * survives the polling -> websocket upgrade, since the upgrade request carries
 * the same sid in its query string.
 */
export class StickySessions {
  constructor({ ttlMs = config.stickyTtlMs } = {}) {
    this.ttlMs = ttlMs;
    this.entries = new Map(); // sid -> { url, expiresAt }
    this.timer = null;
  }

  get size() {
    return this.entries.size;
  }

  /** Reads the sid a client is addressing, if any. */
  static sidFrom(requestUrl) {
    const query = requestUrl.slice(requestUrl.indexOf('?') + 1);
    const sid = new URLSearchParams(query).get('sid');
    return sid || null;
  }

  /** Extracts the sid a backend just issued, from its handshake response body. */
  static sidFromHandshake(body) {
    return SID_IN_BODY.exec(body)?.[1] || null;
  }

  get(sid) {
    const entry = this.entries.get(sid);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(sid);
      return null;
    }
    // Touch: an active session should not expire mid-conversation.
    entry.expiresAt = Date.now() + this.ttlMs;
    return entry.url;
  }

  set(sid, url) {
    this.entries.set(sid, { url, expiresAt: Date.now() + this.ttlMs });
  }

  delete(sid) {
    this.entries.delete(sid);
  }

  sweep() {
    const now = Date.now();
    for (const [sid, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(sid);
    }
  }

  start() {
    this.timer = setInterval(() => this.sweep(), this.ttlMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
