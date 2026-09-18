# Take-home task: AI Diff Review Service

This task asks you to build and deploy a small HTTP service, the kind of component we build and run in production. 

We will evaluate your **running service** by calling it — exactly against the contract below — plus a short walkthrough of your code and decisions during the interview.

# What it is?
It simulates a very basic, single pass AI code review service that takes in diff as input and returns review as output

## Ground rules

- Suggested effort: You do not need to be perfect; the contract below has depth on purpose. Prioritize, and tell us what you skipped and why.

- **AI coding tools are allowed and encouraged.** 

- Any language/runtime is fine. 

- **Deployment:** any option works — a free-tier host, your own server, or a tunnel to your machine (ngrok, cloudflared).  

Your service must be reachable for the **48-hour scoring window** starting when you submit 

- You do NOT need to buy anything. The scored behavior uses the deterministic
  `mock` provider defined below.
- The `llm` provider must be fully configured on YOUR server — model access,
  credentials, everything. We call your API with your bearer token only; we
  never send an LLM key and we do not provide one. How you source model access
  is part of the task and is up to you. If the model is ever unreachable, the
  job must fail gracefully (a `failed` job with a clear error), never crash.
  Verify the `llm` path works end to end before you submit.

## What you build

An **AI diff review service**: clients POST a unified diff, your service analyzes it asynchronously and returns structured review findings.

The service reviews diffs through a **provider** interface:

1. **`mock`** — fully deterministic, implements the finding rules table below exactly. This is what we score: it proves your pipeline (parsing, chunking, ordering, streaming, caching) works, independent of any model.

2. **`llm`** — a real-LLM code path behind the same pipeline (any vendor). Model access and credentials live entirely on your server, configured via environment variables and documented in your README — our requests carry only your bearer token. If the model is unreachable at runtime, the job must fail gracefully (a `failed` job with a clear error), never crash.

## The contract

### GET /health  (public)

`200` → `{ "status": "ok", "version": "<semver>", "uptimeSeconds": <number> }`

### GET /spec  (public)

`200` → machine-readable self-declaration:

```json
{
  "specVersion": "1.0",
  "providers": ["mock", "llm"],
  "limits": {
    "maxPayloadBytes": 1048576,
    "chunkBytes": 65536,
    "maxConcurrentJobs": 4,
    "rateLimitPerMinute": 30
  }
}
```

Declared limits must match your actual behavior.

### Authentication

All `/v1/*` routes (every method, including GET) require `Authorization: Bearer <token>` — the token you give us at submission.
Missing/wrong token → `401` with the error envelope. `/health` and `/spec` are public.

### POST /v1/reviews

Body:

```json
{
  "diff": "<unified diff, required>",
  "options": {
    "provider": "mock" | "llm",     // default "mock"
    "maxFindings": <int, default 100>
  }
}
```

- `202` → `{ "jobId": "<opaque>", "status": "queued" }` — processing is async.

- Payload over 1 MiB → `413`. Invalid JSON → `400`. `diff` missing, empty, or
  not parseable as a unified diff → `422`. Unknown body fields are ignored.

- **Idempotency:** header `Idempotency-Key: <key>` — same key + byte-identical
  body → the same `jobId`. Same key + different body → `409`.

- **Caching:** a byte-identical `{diff, options}` submitted again (any key or
  none) must not redo the work: the result reports `"cacheHit": true` with
  findings identical to the first run.

### GET /v1/reviews/{jobId}

`200` →

```json
{
  "jobId": "...",
  "status": "queued" | "running" | "done" | "failed",
  "findings": [ ... ],          // when done
  "usage": { "inputBytes": <int>, "chunks": <int>, "cacheHit": <bool> }
}
```

Unknown jobId → `404`. Jobs with diffs ≤64 KiB must reach `done` within 30 s.

### GET /v1/reviews/{jobId}/stream

Server-Sent Events (`Content-Type: text/event-stream`):

- event `status` — at least on status transitions.
- event `finding` — one per finding, as discovered.
- event `done` — `{"total": <count>, "usage": {...}}`, then close.

Connecting to a finished job's stream must replay all events identically.

### Error envelope (all non-2xx)

```json
{ "error": { "code": "<machine_code>", "message": "<human text>" } }
```

Codes: `unauthorized`, `payload_too_large`, `invalid_json`, `invalid_diff`,
`idempotency_conflict`, `not_found`, `rate_limited`, `internal`.

## Finding object

```json
{
  "id": "MOCK-003:src/db.ts:41",
  "ruleId": "MOCK-003",
  "path": "src/db.ts",
  "line": 41,
  "severity": "critical" | "high" | "medium" | "low",
  "category": "security" | "correctness" | "performance" | "style",
  "title": "<short>",
  "evidence": "<the offending added line, verbatim>"
}
```

Ordering everywhere (results and streams): by `path` (lexicographic), then
`line` (ascending), then `ruleId`. Deduplicate by `id`.

## Mock provider rules (scored exactly)

Rules apply to **added lines only** (`+` lines, excluding the `+++` header).
`line` is the line number in the new file. One finding per matching line per rule.

| ruleId   | severity | category    | trigger (on the added line)                                   | title                       |
|----------|----------|-------------|---------------------------------------------------------------|-----------------------------|
| MOCK-001 | critical | security    | contains `eval(`                                              | eval usage                  |
| MOCK-002 | critical | security    | matches `/(api[_-]?key|secret|token)\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/i` | hardcoded credential |
| MOCK-003 | high     | security    | SQL keyword (`SELECT`, `INSERT`, `UPDATE`, `DELETE`) inside a string concatenated with `+` | SQL string concatenation |
| MOCK-004 | high     | correctness | empty catch block (may span lines; report the `catch` line)   | swallowed exception         |
| MOCK-005 | medium   | correctness | `== null` or `!= null`                                        | loose null comparison       |
| MOCK-006 | medium   | performance | `JSON.parse(JSON.stringify(`                                  | deep-clone via JSON         |
| MOCK-007 | low      | style       | contains `console.log(`                                       | console.log left in         |
| MOCK-008 | low      | style       | contains `TODO` or `FIXME`                                    | unresolved marker           |
| MOCK-INJ | critical | security    | contains, case-insensitive, `ignore previous instructions` or `disregard all prior` or `you are now` | prompt-injection content |

Injection content must never alter your service's behavior or the other
rules — report it as a finding and treat it as inert text. `maxFindings`
truncates the ordered list; `usage` still reflects the full scan.

## Chunking

Diffs over 64 KiB are split into chunks of at most 64 KiB, only on file
boundaries (one file's diff never spans two chunks; a single file over 64 KiB
is its own chunk). `usage.chunks` reports the count. Findings must be
identical to an unchunked scan: no duplicates, no losses, ordering preserved.

## Rate limiting

Applies to `POST /v1/reviews` only — GETs are never rate limited. Sustained
30 submissions/minute must succeed; beyond your declared burst, respond `429`
with a `Retry-After` header and the error envelope. Never 5xx under burst.

## Concurrency

At least 4 jobs processing concurrently; a queued 5th must not fail.

## What we score (published for fairness)

Severity-weighted automated probes against your running service: contract and
lifecycle, auth on all /v1 routes, exact mock findings on crafted diffs,
chunking correctness, SSE incl. replay, caching + idempotency, error taxonomy,
injection inertness, rate limiting, concurrency, the 30 s latency budget, spec
self-declaration accuracy, and that the `llm` path exists and degrades
gracefully. The bar is high by design: a minimal happy-path service (submit +
poll + naive findings) does not pass. Cross-cutting behaviors — chunk
boundaries, dedup, replay, caching — are where the points are.

The automated score is a completeness check, not the hiring decision. The
interview is where you walk us through your architecture, your verification,
and your judgment calls.

## Submission

Send us:
1. Your service **base URL** and **bearer token**.
2. Your **repository URL** (we read it; we never execute it).
3. **SUBMISSION.md** in the repo: architecture (10 lines is fine), provider
   design, how you verified the cross-cutting behaviors, what AI tools you
   used, at least one AI suggestion you rejected and why, and what you'd do
   next with more time.

Good luck — build something you're happy to defend in the room.
