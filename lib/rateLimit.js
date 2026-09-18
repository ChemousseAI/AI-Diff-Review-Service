'use strict';

/**
 * Simple sliding-window-log limiter. Since every /v1 request is authenticated
 * with a single shared bearer token, we limit globally per the declared
 * `rateLimitPerMinute`. Sustained submissions at exactly the limit succeed;
 * anything beyond it within the trailing 60s window is rejected with 429.
 */
class RateLimiter {
  constructor(limitPerMinute) {
    this.limit = limitPerMinute;
    this.windowMs = 60 * 1000;
    this.timestamps = [];
  }

  /**
   * Returns { allowed: true } or { allowed: false, retryAfterSeconds }.
   */
  check() {
    const now = Date.now();
    // Drop timestamps outside the window.
    while (this.timestamps.length > 0 && now - this.timestamps[0] >= this.windowMs) {
      this.timestamps.shift();
    }
    if (this.timestamps.length < this.limit) {
      this.timestamps.push(now);
      return { allowed: true };
    }
    const oldest = this.timestamps[0];
    const retryAfterMs = this.windowMs - (now - oldest);
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
  }
}

module.exports = { RateLimiter };
