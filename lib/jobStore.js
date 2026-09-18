'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');

function uuidv4() {
  return crypto.randomUUID();
}

function hashContent(diff, options) {
  const normalized = JSON.stringify({ diff, options: options || {} });
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

class Job {
  constructor(id, diff, options) {
    this.id = id;
    this.diff = diff;
    this.options = options;
    this.status = 'queued'; // queued | running | done | failed
    this.findings = [];
    this.usage = { inputBytes: Buffer.byteLength(diff, 'utf8'), chunks: 0, cacheHit: false };
    this.error = null;
    this.events = []; // recorded SSE events, for replay: {event, data}
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(0);
    this.createdAt = Date.now();
  }

  recordEvent(event, data) {
    const entry = { event, data };
    this.events.push(entry);
    this.emitter.emit('event', entry);
  }

  setStatus(status) {
    this.status = status;
    this.recordEvent('status', { status });
  }

  addFinding(finding) {
    this.findings.push(finding);
    this.recordEvent('finding', finding);
  }

  finishDone() {
    this.status = 'done';
    const data = { total: this.findings.length, usage: this.usage };
    this.recordEvent('status', { status: 'done' });
    this.recordEvent('done', data);
  }

  finishFailed(errorMessage) {
    this.status = 'failed';
    this.error = errorMessage;
    this.recordEvent('status', { status: 'failed', error: errorMessage });
    this.recordEvent('done', { total: this.findings.length, usage: this.usage, error: errorMessage });
  }
}

class JobStore {
  constructor() {
    this.jobs = new Map(); // jobId -> Job
    this.cache = new Map(); // contentHash -> { findings, usage }
    this.idempotency = new Map(); // key -> { bodyHash, jobId }
  }

  /**
   * Handles idempotency-key bookkeeping. Returns:
   *   { conflict: true } - same key, different body -> caller should 409
   *   { existingJobId: '<id>' } - same key, same body -> reuse that job
   *   { fresh: true } - new key, caller should register after creating job
   */
  checkIdempotency(key, bodyHash) {
    if (!key) return { fresh: true };
    const existing = this.idempotency.get(key);
    if (!existing) return { fresh: true };
    if (existing.bodyHash !== bodyHash) return { conflict: true };
    return { existingJobId: existing.jobId };
  }

  registerIdempotency(key, bodyHash, jobId) {
    if (!key) return;
    this.idempotency.set(key, { bodyHash, jobId });
  }

  getCached(contentHash) {
    return this.cache.get(contentHash) || null;
  }

  setCached(contentHash, findings, usage) {
    // Store the pre-cacheHit usage/findings snapshot so future hits can
    // reproduce identical findings.
    this.cache.set(contentHash, {
      findings: findings.map((f) => ({ ...f })),
      usage: { inputBytes: usage.inputBytes, chunks: usage.chunks },
    });
  }

  createJob(diff, options) {
    const id = uuidv4();
    const job = new Job(id, diff, options);
    this.jobs.set(id, job);
    return job;
  }

  get(id) {
    return this.jobs.get(id) || null;
  }
}

module.exports = { JobStore, hashContent };
