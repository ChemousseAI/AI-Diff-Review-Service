'use strict';

const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

const { loadEnv } = require('./lib/loadEnv');
loadEnv();

const { sendError, sendJson } = require('./lib/errors');
const { isLikelyUnifiedDiff } = require('./lib/diffParser');
const { JobStore } = require('./lib/jobStore');
const { ConcurrencyQueue } = require('./lib/queue');
const { RateLimiter } = require('./lib/rateLimit');
const { streamJob } = require('./lib/sse');
const { processMockJob, CHUNK_BYTES } = require('./lib/providers/mock');
const { processLlmJob } = require('./lib/providers/llm');

const VERSION = '1.0.0';
const PORT = parseInt(process.env.PORT, 10) || 3000;
const AUTH_TOKEN = process.env.AUTH_TOKEN;
const MAX_PAYLOAD_BYTES = 1024 * 1024; // 1 MiB
const MAX_READ_BYTES = MAX_PAYLOAD_BYTES + 4096; // small slack so we can detect "over" cleanly
const MAX_CONCURRENT_JOBS = 4;
const RATE_LIMIT_PER_MINUTE = 30;

if (!AUTH_TOKEN) {
  // eslint-disable-next-line no-console
  console.error('FATAL: AUTH_TOKEN env var is not set. Refusing to start with an open /v1 API.');
  process.exit(1);
}

const jobStore = new JobStore();
const queue = new ConcurrencyQueue(MAX_CONCURRENT_JOBS);
const rateLimiter = new RateLimiter(RATE_LIMIT_PER_MINUTE);
const startedAt = Date.now();

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function checkAuth(req) {
  const header = req.headers['authorization'] || '';
  const match = /^Bearer (.+)$/.exec(header);
  return !!match && match[1] === AUTH_TOKEN;
}

/**
 * Reads the request body into a Buffer, capped at MAX_READ_BYTES to avoid
 * unbounded memory use from a hostile client. Resolves even for oversized
 * bodies (the caller checks buf.length against MAX_PAYLOAD_BYTES and
 * responds 413); the connection is then closed rather than fully drained,
 * which is fine since we're about to reject the request anyway.
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let overLimit = false;
    req.on('data', (chunk) => {
      if (overLimit) return;
      total += chunk.length;
      if (total > MAX_READ_BYTES) {
        overLimit = true;
        resolve(Buffer.concat(chunks.concat([chunk])).subarray(0, MAX_READ_BYTES + 1));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!overLimit) resolve(Buffer.concat(chunks, total));
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

function handleHealth(req, res) {
  sendJson(res, 200, {
    status: 'ok',
    version: VERSION,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
  });
}

function handleSpec(req, res) {
  sendJson(res, 200, {
    specVersion: '1.0',
    providers: ['mock', 'llm'],
    limits: {
      maxPayloadBytes: MAX_PAYLOAD_BYTES,
      chunkBytes: CHUNK_BYTES,
      maxConcurrentJobs: MAX_CONCURRENT_JOBS,
      rateLimitPerMinute: RATE_LIMIT_PER_MINUTE,
    },
  });
}

async function handleCreateReview(req, res) {
  const buf = await readBody(req);

  if (buf.length > MAX_PAYLOAD_BYTES) {
    return sendError(res, 'payload_too_large', `Payload of ${buf.length} bytes exceeds the ${MAX_PAYLOAD_BYTES}-byte limit.`);
  }

  let body;
  try {
    body = buf.length === 0 ? {} : JSON.parse(buf.toString('utf8'));
  } catch (e) {
    return sendError(res, 'invalid_json', 'Request body is not valid JSON.');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return sendError(res, 'invalid_json', 'Request body must be a JSON object.');
  }

  const diff = body.diff;
  if (typeof diff !== 'string' || diff.trim().length === 0 || !isLikelyUnifiedDiff(diff)) {
    return sendError(res, 'invalid_diff', 'The `diff` field is missing, empty, or not a parseable unified diff.');
  }

  const rawOptions = (typeof body.options === 'object' && body.options !== null) ? body.options : {};
  let provider = typeof rawOptions.provider === 'string' ? rawOptions.provider : 'mock';
  if (provider !== 'mock' && provider !== 'llm') provider = 'mock';
  const maxFindings = Number.isInteger(rawOptions.maxFindings) && rawOptions.maxFindings >= 0
    ? rawOptions.maxFindings
    : 100;
  const options = { provider, maxFindings };

  // Rate limiting applies only to this route, and only once the request is
  // otherwise well-formed and authenticated (auth already checked by the
  // caller before dispatch).
  const rl = rateLimiter.check();
  if (!rl.allowed) {
    return sendError(res, 'rate_limited', 'Too many submissions; slow down.', {
      'Retry-After': String(rl.retryAfterSeconds),
    });
  }

  const bodyHash = crypto.createHash('sha256').update(buf).digest('hex');
  const idemKey = req.headers['idempotency-key'] || null;

  const idemResult = jobStore.checkIdempotency(idemKey, bodyHash);
  if (idemResult.conflict) {
    return sendError(res, 'idempotency_conflict', 'This Idempotency-Key was already used with a different request body.');
  }
  if (idemResult.existingJobId) {
    const existing = jobStore.get(idemResult.existingJobId);
    return sendJson(res, 202, { jobId: existing.id, status: existing.status });
  }

  const job = jobStore.createJob(diff, options);
  jobStore.registerIdempotency(idemKey, bodyHash, job.id);

  const cached = jobStore.getCached(bodyHash);

  queue.push(async () => {
    if (cached) {
      job.setStatus('running');
      job.usage.inputBytes = cached.usage.inputBytes;
      job.usage.chunks = cached.usage.chunks;
      job.usage.cacheHit = true;
      for (const finding of cached.findings) {
        job.addFinding({ ...finding });
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setImmediate(resolve));
      }
      job.finishDone();
      return;
    }

    if (options.provider === 'llm') {
      await processLlmJob(job);
    } else {
      await processMockJob(job);
    }

    if (job.status === 'done') {
      jobStore.setCached(bodyHash, job.findings, job.usage);
    }
  });

  return sendJson(res, 202, { jobId: job.id, status: job.status });
}

function handleGetReview(req, res, jobId) {
  const job = jobStore.get(jobId);
  if (!job) return sendError(res, 'not_found', 'No job with that id.');

  const payload = {
    jobId: job.id,
    status: job.status,
    findings: job.findings,
    usage: job.usage,
  };
  if (job.status === 'failed' && job.error) payload.error = job.error;

  return sendJson(res, 200, payload);
}

function handleStreamReview(req, res, jobId) {
  const job = jobStore.get(jobId);
  if (!job) return sendError(res, 'not_found', 'No job with that id.');
  return streamJob(req, res, job);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const REVIEW_ID_RE = /^\/v1\/reviews\/([^/]+)$/;
const REVIEW_STREAM_RE = /^\/v1\/reviews\/([^/]+)\/stream$/;

async function router(req, res) {
  let pathname;
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch (e) {
    return sendError(res, 'invalid_json', 'Malformed request URL.');
  }

  if (req.method === 'GET' && pathname === '/health') return handleHealth(req, res);
  if (req.method === 'GET' && pathname === '/spec') return handleSpec(req, res);

  if (pathname === '/v1/reviews' || REVIEW_ID_RE.test(pathname) || REVIEW_STREAM_RE.test(pathname)) {
    if (!checkAuth(req)) {
      return sendError(res, 'unauthorized', 'Missing or invalid bearer token.');
    }

    if (req.method === 'POST' && pathname === '/v1/reviews') {
      try {
        return await handleCreateReview(req, res);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('Unhandled error in POST /v1/reviews:', err);
        return sendError(res, 'internal', 'Internal server error.');
      }
    }

    const streamMatch = REVIEW_STREAM_RE.exec(pathname);
    if (req.method === 'GET' && streamMatch) {
      return handleStreamReview(req, res, decodeURIComponent(streamMatch[1]));
    }

    const idMatch = REVIEW_ID_RE.exec(pathname);
    if (req.method === 'GET' && idMatch) {
      return handleGetReview(req, res, decodeURIComponent(idMatch[1]));
    }

    return sendError(res, 'not_found', 'No such route.');
  }

  return sendError(res, 'not_found', 'No such route.');
}

const server = http.createServer((req, res) => {
  router(req, res).catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Unhandled router error:', err);
    if (!res.headersSent) sendError(res, 'internal', 'Internal server error.');
  });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`AI diff review service listening on :${PORT}`);
});

module.exports = server;
