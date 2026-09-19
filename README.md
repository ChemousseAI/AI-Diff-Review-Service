# AI Diff Review Service

[![Node](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](#why-zero-dependencies)
[![Tests](https://img.shields.io/badge/smoke%20tests-49%2F49%20passing-success)](#tests)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

An async HTTP service that reviews unified diffs and returns structured,
line-level findings — the kind of small production component this was
built to demonstrate. Clients `POST` a diff, the service reviews it in the
background, and clients poll or stream the results.

Implements the full contract in [`CANDIDATE-TASK.md`](./CANDIDATE-TASK.md).
Architecture and design decisions are written up in
[`SUBMISSION.md`](./SUBMISSION.md).

## Contents

- [Quick start](#quick-start)
- [API](#api)
- [Review providers](#review-providers)
- [Mock rules](#mock-rules)
- [Tests](#tests)
- [Architecture](#architecture)
- [Configuration](#configuration)
- [Deploying](#deploying)
- [Why zero dependencies](#why-zero-dependencies)

## Quick start

```bash
git clone <this-repo-url>
cd diff-review-service
cp .env.example .env
# edit .env: set AUTH_TOKEN to a long random string
node index.js
# -> AI diff review service listening on :3000
```

No `npm install` required — see [why zero dependencies](#why-zero-dependencies).

```bash
curl -s localhost:3000/health
curl -s localhost:3000/spec

curl -s -X POST localhost:3000/v1/reviews \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"diff": "--- a/x.ts\n+++ b/x.ts\n@@ -1,1 +1,2 @@\n old\n+console.log(1);\n"}'
# -> {"jobId":"...","status":"queued"}

curl -s localhost:3000/v1/reviews/<jobId> -H "Authorization: Bearer $AUTH_TOKEN"
curl -N localhost:3000/v1/reviews/<jobId>/stream -H "Authorization: Bearer $AUTH_TOKEN"
```

## API

All `/v1/*` routes require `Authorization: Bearer <AUTH_TOKEN>`. `/health`
and `/spec` are public.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | liveness + version + uptime |
| `GET` | `/spec` | machine-readable self-declaration of providers/limits |
| `POST` | `/v1/reviews` | submit a diff for review, returns `202 {jobId, status}` |
| `GET` | `/v1/reviews/{jobId}` | poll job status + findings + usage |
| `GET` | `/v1/reviews/{jobId}/stream` | Server-Sent Events: `status`, `finding`, `done` |

`POST /v1/reviews` body:

```json
{
  "diff": "<unified diff, required>",
  "options": {
    "provider": "mock",
    "maxFindings": 100
  }
}
```

Supports `Idempotency-Key` (same key + identical body → same `jobId`; same
key + different body → `409`) and automatic caching (identical `{diff,
options}` resubmitted → `usage.cacheHit: true`, no rework, identical
findings). Errors use a consistent envelope: `{"error": {"code", "message"}}`.

## Review providers

Both providers run the same pipeline — parse → chunk → scan/call → dedupe →
sort → truncate → emit — so only "how findings get produced" differs:

- **`mock`** — deterministic rule engine, no external calls, what the
  scoring probes exercise.
- **`llm`** — sends each diff chunk to a real model (any OpenAI- or
  Anthropic-shaped chat-completions endpoint you configure). Missing
  config, network failure, or malformed model output all degrade to a
  `failed` job with a clear error — never a crash.

## Mock rules

| Rule | Severity | Category | Trigger |
|---|---|---|---|
| `MOCK-001` | critical | security | `eval(` |
| `MOCK-002` | critical | security | hardcoded API key / secret / token |
| `MOCK-003` | high | security | SQL keyword inside a `+`-concatenated string |
| `MOCK-004` | high | correctness | empty `catch` block |
| `MOCK-005` | medium | correctness | `== null` / `!= null` |
| `MOCK-006` | medium | performance | `JSON.parse(JSON.stringify(` |
| `MOCK-007` | low | style | `console.log(` |
| `MOCK-008` | low | style | `TODO` / `FIXME` |
| `MOCK-INJ` | critical | security | prompt-injection-shaped text (reported, never obeyed) |

Findings are ordered by `path`, then `line`, then `ruleId`, and deduplicated
by `id`.

## Tests

```bash
AUTH_TOKEN=test-token PORT=4123 node test/smoke.js
```

A self-contained smoke suite (no test framework dependency) that boots the
server in-process and drives it over real HTTP: auth, validation, rule
correctness, ordering/dedup, `maxFindings` truncation, chunking, caching,
idempotency, SSE replay, and rate limiting. **49/49 passing.**

## Architecture

```
index.js                   HTTP server + router + request handling
lib/diffParser.js          unified diff -> per-file blocks -> added/context lines
lib/rules.js                MOCK-001..008, MOCK-INJ rule engine, sort/dedup
lib/providers/mock.js       orchestrates parse -> chunk -> scan -> emit for the mock path
lib/providers/llm.js        same pipeline, findings come from a real model call
lib/jobStore.js             in-memory jobs, content-hash cache, idempotency map
lib/queue.js                concurrency-limited (4) task scheduler
lib/rateLimit.js            sliding-window rate limiter (30/min, POST only)
lib/sse.js                  SSE writer with full event replay
lib/errors.js               error envelope helper
lib/loadEnv.js              minimal .env loader (no dotenv dependency)
test/smoke.js               end-to-end contract test suite
```

Storage is in-memory (`Map`s in `jobStore.js`) — a deliberate single-instance
tradeoff. See "What I'd do next" in [`SUBMISSION.md`](./SUBMISSION.md).

## Configuration

| Var | Required | Purpose |
|---|---|---|
| `PORT` | no (default `3000`) | listen port |
| `AUTH_TOKEN` | **yes** | bearer token required on all `/v1/*` routes |
| `LLM_API_KEY` | only for `llm` provider | credential for your model host |
| `LLM_BASE_URL` | only for `llm` provider | a chat-completions endpoint (OpenAI- or Anthropic-shaped response both supported) |
| `LLM_MODEL` | only for `llm` provider | model name/id to request |

If the three `LLM_*` vars aren't all set, any request with
`options.provider: "llm"` fails gracefully: the job transitions to `failed`
with a clear `error` message, and the process never crashes.

## Deploying

Any of these work equally well; pick whichever you're fastest with.

- **Render** — this repo includes `render.yaml`. Push to GitHub, "New Web
  Service" → connect the repo → it picks up the blueprint. Set `AUTH_TOKEN`
  (and `LLM_*` if wiring up a real model) in the dashboard's env vars.
- **Fly.io / Railway** — `Dockerfile` is included; both platforms build and
  run it directly.
- **Your own machine + a tunnel** — `node index.js` locally, then
  `cloudflared tunnel --url http://localhost:3000` or `ngrok http 3000`.

Verify `/health` and `/spec` are reachable at the public URL before
submitting, and that `Authorization: Bearer <token>` on a `/v1/*` route
works from *outside* your network, not just `localhost`.

## Why zero dependencies

Built on Node's `http` module, `crypto.randomUUID()`, and a 20-line `.env`
parser instead of Express/`uuid`/`dotenv`. Five routes and no
templating/middleware-ecosystem need means a framework buys ~nothing here,
but it does buy an `npm install` step that can fail or drift on whatever
host does the grading. `git clone && node index.js` always behaves the
same way. More on this tradeoff in [`SUBMISSION.md`](./SUBMISSION.md).

## License

MIT — see [`LICENSE`](./LICENSE).
