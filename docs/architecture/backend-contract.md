# Backend implementation contract

Implementation in progress. Node 24, native SQLite/FTS5, ESM. Related FR-001–014,
NFR-001–012. New code lives in `backend/`; the legacy server remains available
for rollback and is not imported into the new service.

## Ownership and wire format

Core owns store/auth/crypto; sources owns outbound reads/discovery/adapters;
deployment owns deployment scripts, workflow and runbook; integration owns HTTP,
chat, worker, root CI and public API documentation. No shared browser or secret
state. Every private operation accepts the verified Telegram user ID (string).

`AppError(code, status, message)` is the shared error type. Public errors contain
only stable codes. IDs are opaque strings. Times are ISO UTC strings, except
Telegram auth timestamps and job leases (milliseconds). Store methods are
synchronous. Executors and network methods are asynchronous.

## Store (`backend/src/store.mjs`)

`createStore({dbPath, masterKey, now = Date.now})`; masterKey is a 32-byte Buffer.
Methods return public camelCase records without secret ciphertext:

- `ensureUser({id, displayName})`, `getUser(userId)`
- `createSpace(userId, {universityId, name})`, `listSpaces(userId)`,
  `getSpace(userId, spaceId)`, `deleteSpace(userId, spaceId)`
- `createConnection(userId, spaceId, {sourceUrl, kind, label})`,
  `listConnections(userId, spaceId)`, `getConnection(userId, connectionId)`,
  `updateConnection(userId, connectionId, {status, errorCode, adapterId})`,
  `deleteConnection(userId, connectionId)`
- `setSecret(userId, connectionId, value)`, `readSecret(userId, connectionId)`
  are executor-only; no route exposes them. Secret includes bound `origin`.
- `putSnapshot(userId, connectionId, {kind, items, fetchedAt, complete})`,
  `listSnapshots(userId, spaceId, {kind} = {})`; failed/incomplete writes preserve
  the last complete snapshot. Kinds: courses, schedule, deadlines.
- `putDocument(userId, spaceId, {id, connectionId, url, title, text, fetchedAt})`,
  `searchDocuments(userId, spaceId, query, {limit} = {})`,
  `listDocuments(userId, spaceId, {limit} = {})`
- `appendMessage(userId, spaceId, {role, text, sources = []})`,
  `listMessages(userId, spaceId, {limit} = {})`
- `enqueueJob(userId, connectionId, {type, payload = {}, dedupeKey})`,
  `getJob(userId, jobId)`, `claimJob(workerId, {leaseMs} = {})`,
  `finishJob(jobId, claimToken, {status, errorCode, result})`.
  Claims return job with `claimToken`; statuses queued/running/succeeded/failed.
  Retries after expired leases are fenced; disconnect cancels jobs.
- `putAdapter({id, origin, version, recipe, capabilities})`, `getAdapter(id)`,
  `findAdapter(origin)`; shared metadata contains no personal observations.
- `close()`.

Records include `id`, private records include `userId`, `spaceId`; connection
includes `sourceUrl`, `kind`, `status`, `adapterId`. Snapshot includes
`connectionId`, `kind`, `items`, `fetchedAt`; document includes URL/provenance.
Cross-user/nonexistent IDs return the same 404 code, including writes and jobs.

## Authentication (`backend/src/auth.mjs`)

`verifyTelegramInitData(raw, botToken, {now = Date.now, maxAgeSeconds = 3600})`
returns `{id, displayName}`; validates HMAC, timestamp/future skew and user ID;
rejects duplicate fields. No development identity fallback on protected routes.

## Source executor (`backend/src/sources/index.mjs`)

`createSourceService({store, request, proposeRecipe, now = Date.now})` returns
`discover({userId, connectionId})` and `sync({userId, connectionId})`.
Default `request` is the production SSRF-safe HTTP transport. Tests inject a
fixture transport. The optional proposer receives sanitized public observations
only and returns a declarative recipe; deterministic validation/execution remains
mandatory. Methods return `{status, capabilities, ...}` and persist results.
Unknown universities start discovery immediately, returning action-required or
unsupported outcomes honestly when no readable data exists. User credentials
never enter model prompts, adapter records or generic fetch headers.

## HTTP integration

`/api/v1` is the new contract. Telegram init data uses `x-telegram-init-data`.
Resource hierarchy: `/spaces`, `/spaces/:id/connections`, `/connections/:id/auth`,
`/connections/:id/sync`, `/connections/:id/discover`, `/jobs/:id`,
`/spaces/:id/{schedule,deadlines,courses,documents,chat,faq}`.
Auth operations may accept a source token/password over same-origin HTTPS and
encrypt immediately, but official OAuth redirects require registered clients;
a redirect alone cannot transfer university cookies. Unsupported SSO explicitly
returns user_action_required. No route executes generated code or arbitrary curl.
