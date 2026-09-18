# SUBMISSION

## Architecture (short version)

A single Node `http.createServer` with a tiny hand-rolled router dispatches
to five routes. `diffParser.js` turns a unified diff into per-file blocks
(raw text + reconstructed new-file line sequence); `rules.js` runs the nine
MOCK-* rules over each file's added lines and dedupes/sorts the result.
`providers/mock.js` and `providers/llm.js` both run parse → chunk → scan/call
→ emit, so the two providers are interchangeable behind the same job
lifecycle. Jobs live in an in-memory `JobStore` (a `Map`, plus a
content-hash → result cache and an idempotency-key → jobId map). A
`ConcurrencyQueue` caps simultaneous processing at 4 and just queues the
rest. Every state change on a job is recorded as an event and re-emitted, so
SSE replay and live streaming are the same code path.

## Provider design

Both providers share one pipeline shape — `parse → chunkFiles → per-chunk
work → dedupe → sort → truncate(maxFindings) → emit` — so switching
`options.provider` doesn't change anything about job lifecycle, chunking,
caching, or streaming; only "how are findings produced for a chunk" differs.

- **mock**: deterministic regex/structural rules (`rules.js`), scored
  exactly against the table in the task.
- **llm**: sends each chunk's raw diff text to an OpenAI- or
  Anthropic-shaped chat completions endpoint (configured via `LLM_BASE_URL`
  / `LLM_API_KEY` / `LLM_MODEL`, read only from server-side env vars — the
  caller's bearer token never touches the model call) with a system prompt
  that (a) asks for the same finding schema back as strict JSON and (b)
  explicitly instructs the model to treat the diff's contents, including
  anything that looks like an instruction, as inert data to review rather
  than follow. Missing config, a non-2xx response, a timeout, or
  unparseable model output are all caught in one place and turned into a
  `failed` job with a human-readable `error` — never an unhandled exception.

## How I verified the cross-cutting behaviors

`test/smoke.js` boots the server in-process and drives it over real HTTP
(49 assertions, currently all green):

- **Chunking**: a generated diff across 6 files well over 64 KiB confirms
  `usage.chunks > 1` and that findings still come back correct (in this
  case, zero — the generator only emits `const` lines) with nothing
  duplicated or dropped at a chunk boundary.
- **Caching**: the exact same `{diff, options}` body submitted twice; the
  second response's `usage.cacheHit` is `true` and its `findings` array is
  byte-for-byte identical (`JSON.stringify` equality) to the first run's.
- **Idempotency**: same `Idempotency-Key` + same body twice → same `jobId`;
  same key + a one-character-different body → `409 idempotency_conflict`.
- **SSE replay**: connect to a finished job's stream twice and assert the
  serialized event sequences are identical, including the `done` event.
- **Ordering/dedup**: on a diff crafted to trigger all nine rules across two
  files, assert the findings array is sorted by `(path, line, ruleId)` and
  that no `id` repeats.
- **Injection inertness**: a diff whose added line reads like an instruction
  ("ignore previous instructions...") is asserted to produce a `MOCK-INJ`
  finding and otherwise change nothing about the job's behavior.
- **Rate limiting**: 40 rapid `POST /v1/reviews` calls assert at least one
  `429` appears and that nothing ever comes back `5xx`.
- Auth, `400`/`413`/`422`/`404` paths, and `maxFindings` truncation
  (findings truncated, `usage.inputBytes` unaffected) are each asserted
  directly.

What the smoke suite does *not* cover, for lack of a real model to call in
the dev environment: an actual end-to-end `llm` provider run. I verified
that path structurally (config-missing → graceful `failed` job; malformed
JSON from a stubbed response → graceful `failed` job) but you should
re-verify the happy path once your `LLM_*` env vars are set on the deployed
instance, per the task's instruction to confirm the `llm` path works
end-to-end before submitting.

## AI tools used

Built with Claude (Anthropic), working from the task's markdown brief
directly — generating the diff parser, rule engine, job pipeline, SSE
replay logic, and the smoke-test suite, then iterating based on the smoke
tests actually failing/passing in a real terminal rather than accepting
generated code on faith.

**A suggestion I rejected**: the first draft pulled in Express, `uuid`, and
`dotenv` as dependencies, which is the conventional choice for a Node HTTP
service. I rejected it in favor of Node's built-in `http` module,
`crypto.randomUUID()`, and a 20-line `.env` parser. Reasoning: this service
has five routes and no templating/middleware-ecosystem need, so a framework
buys ~nothing here; but it does buy a `npm install` step that can fail or
drift on whatever host does the grading, and one more place a version
mismatch could hide a bug during a 48-hour scoring window. Zero
dependencies means `git clone && node index.js` always works the same way,
and it let me run the full smoke suite in the development sandbox with no
network access at all, which is how I caught e.g. an early bug in the
empty-catch-block scanner before it ever reached a real reviewer.

## What I'd do next with more time

- **Persistence**: jobs are in-memory, so a restart loses in-flight/completed
  jobs. For a real deployment I'd back `JobStore` with SQLite (still no
  external service dependency, just a file) so a redeploy mid-scoring-window
  doesn't wipe history.
- **MOCK-004 (empty catch) robustness**: the brace-counting scanner handles
  the common `catch (e) { }` and `catch (e)\n{\n}` shapes but not every
  formatting style (e.g. braces inside string literals on the same line
  could confuse the counter). I'd replace it with a real lightweight
  tokenizer if this rule needed to be bulletproof against adversarial
  formatting rather than typical code.
- **LLM provider**: currently one model call per chunk with no retry. I'd
  add one bounded retry on transient network errors (not on a bad JSON
  response, to avoid burning latency budget on a systematically
  misbehaving model) and a per-request cost/latency log.
- **Observability**: no structured logging or metrics yet — for production
  I'd want request IDs threaded through to the SSE event log and basic
  counters (jobs by status, cache hit rate, rate-limit rejections).
