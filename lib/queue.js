'use strict';

/**
 * A minimal concurrency-limited task queue. Accepts async task functions,
 * runs at most `concurrency` at a time, and queues the rest. A queued task
 * never fails just for waiting - it runs as soon as a slot frees up.
 */
class ConcurrencyQueue {
  constructor(concurrency) {
    this.concurrency = concurrency;
    this.running = 0;
    this.pending = [];
  }

  push(taskFn) {
    this.pending.push(taskFn);
    this._drain();
  }

  _drain() {
    while (this.running < this.concurrency && this.pending.length > 0) {
      const task = this.pending.shift();
      this.running++;
      Promise.resolve()
        .then(() => task())
        .catch((err) => {
          // Task functions are expected to handle their own errors and mark
          // the job as failed; this catch is a last-resort safety net so a
          // bug in one job can never take down the process or the queue.
          // eslint-disable-next-line no-console
          console.error('Unhandled error in queued task:', err);
        })
        .finally(() => {
          this.running--;
          this._drain();
        });
    }
  }
}

module.exports = { ConcurrencyQueue };
