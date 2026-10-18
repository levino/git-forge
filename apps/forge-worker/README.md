# forge-worker

The Cloudflare Worker deployment of git-forge. It serves Git over HTTPS
(smart HTTP protocol v2 for fetch, `receive-pack` for push, dumb HTTP for
protocol v0 clients) straight from an R2 bucket, using `handleGitRequest` from
`@git-forge/core` and `R2Storage` from `@git-forge/cloudflare`.

## What is deployed

| Piece | Purpose |
|---|---|
| `BUCKET` (R2) | All repository data, in the bucket layout described in `docs/design.md` (`repos/<owner>/<name>/…`). |
| `DB` (D1) | Federation tables of the accounts package: trusted instances, mirror subscriptions, local mirrors. Migrations are applied on the first request of an isolate. |
| `JOBS` (Queue `git-forge-jobs`) | Background jobs: mirror syncs, notification deliveries, subscription renewals, deep checks. One message per invocation, retried with exponential backoff. |
| Cron Trigger `17 3 * * *` | Daily safety net: re-syncs auto mirrors whose last run is older than `MIRROR_SAFETY_SYNC_HOURS`, renews their subscriptions and schedules deep checks. |
| `ADMIN_TOKEN` (secret) | Protects `POST /api/admin/repos` and, until accounts exist, every push. |
| `READ_TOKEN` (secret, optional) | Read-only token: clones, LFS downloads, media and raw URLs, but no pushes. Meant for a CDN pulling a private instance. |
| `PUBLIC_READ` (var) | `true` (default): anyone may read. `false`: reads need the read or admin token. |
| `MAX_PUSH_BYTES` (var) | Largest accepted push request, default 16 MiB. Larger files belong in Git LFS. |
| `PUBLIC_URL` (var) | Base URL of this instance, its federation issuer. Federation and mirrors are enabled when `PUBLIC_URL`, `INSTANCE_KEY` and `JOBS` are present. |
| `INSTANCE_KEY` (secret) | Ed25519 private JWK of this instance (`pnpm --filter forge-worker instance-key`). Signs instance tokens and mirror notifications; the public key is served at `/.well-known/jwks.json`. |
| `ALLOW_INSECURE_FEDERATION` (var) | `true` lets the JWKS cache fetch plain-HTTP issuers. Only for local tests. |
| `MIRROR_SAFETY_SYNC_HOURS` (var) | Interval of the safety-net sync, default 24. Push notifications make mirrors current within seconds; the safety net only catches lost notifications. |
| `MIRROR_DEEP_CHECK_DAYS` (var) | Every how many days a mirror gets the full re-verification, default 30, `0` = only on demand. |

### Routes

- `POST /api/admin/repos` with `Authorization: Bearer <ADMIN_TOKEN>` and a JSON
  body `{"owner": "acme", "name": "site", "defaultBranch": "main"}` creates a
  repository. Answers `201` with the clone URL, `409` if it exists, `400` for
  invalid names, `401` for a wrong token and `503` if no token is configured.
- `GET /api/health` answers `{"ok": true}`.
- `/<owner>/<name>.git/…` is Git and Git LFS. Push with the admin token as the
  HTTP Basic password (any user name), e.g.
  `https://git:<token>@forge.example/acme/site.git` or via a credential helper.
- `GET|HEAD /<owner>/<name>/media/<oid>[/<filename>]` serves an LFS object by
  its SHA-256 oid, immutable and with Range support.
- `GET|HEAD /<owner>/<name>/raw/<ref>/<path>` serves a file from a branch, tag,
  `HEAD` or full commit id; LFS pointers redirect to the media URL. Details in
  `docs/design.md` §7.

### Federation and mirrors

With federation enabled (see `PUBLIC_URL` above) the Worker also serves:

- `GET /.well-known/openid-configuration` and `GET /.well-known/jwks.json`.
- `POST|DELETE /api/federation/subscriptions` — a trusted instance
  subscribes to push notifications for a repository (instance JWT, body
  `{"repository": "owner/name", "callback": "<url below its issuer>"}`).
- `POST /api/federation/notify/<owner>/<name>/<remote>` — receives a signed
  notification (`Content-Type: application/jwt`). `401` for untrusted
  issuers, bad signatures, wrong audience or expired tokens; `403` if this
  mirror does not follow the notifying repository; `200 up-to-date` for a
  duplicate; `202 queued` otherwise.
- Admin routes (`Authorization: Bearer <ADMIN_TOKEN>`):
  - `POST /api/admin/instances` `{"issuer": "...", "pinnedThumbprint"?: "..."}`
    trusts another instance (both directions are needed: the upstream trusts
    the mirror to accept its subscription, the mirror trusts the upstream to
    accept its notifications).
  - `POST /api/repos/<owner>/<name>/mirrors` `{"url": "<upstream>/<o>/<n>.git", "remote"?, "namespace"?, "lfs"?, "lfsUrl"?}`
    configures a mirror, subscribes at the upstream and enqueues the first
    sync. A mirror of a mirror uses `"namespace": "upstream/origin/"`.
  - `GET /api/repos/<owner>/<name>/mirrors` lists mirrors with their status
    (last run, alarms, last deep check).
  - `POST /api/repos/<owner>/<name>/mirrors/<remote>/sync` runs a copy-only
    sync now; `…/verify` runs the deep check now.

After a successful push the Worker enqueues one notification per
subscriber; it does not send anything inside the push request. Mirrors copy
the upstream's packs as stored (copy-only sync, `docs/design.md` §7) and, if
refs moved, notify their own subscribers, so chains propagate without cron.

### Putting a CDN in front (e.g. Bunny)

The media and raw URLs are made for a pull-zone CDN; it fetches from the
Worker on a cache miss, nothing is uploaded.

1. Create a pull zone with the Worker URL (or its custom domain) as origin.
2. Leave caching to the origin headers: media URLs and raw URLs with a full
   commit id are `immutable` for a year, raw URLs on branches and tags are
   cached for 60 seconds. Query strings are not used, so the cache may ignore
   them.
3. For a private instance (`PUBLIC_READ=false`), create a read token and let
   the pull zone send it with every origin request:

   ```sh
   openssl rand -base64 32 | npx wrangler secret put READ_TOKEN
   ```

   In Bunny add an Edge Rule with the action "Set Request Header" (applied to
   origin requests) `Authorization: Bearer <READ_TOKEN>`. The token can read
   every repository but cannot push. Whatever the CDN has cached is readable
   by anyone who can reach the pull zone, so protect the pull zone itself
   (Bunny token authentication) unless the content is meant to be public.

Then `https://<zone>.b-cdn.net/acme/site/raw/main/photos/a.jpg` redirects to
`https://<zone>.b-cdn.net/acme/site/media/<oid>/a.jpg`, which the CDN keeps.

## Deploying to Cloudflare

A Workers **Paid** plan is required for an instance that receives pushes:
the Free plan allows 10 ms of CPU per request, which is not enough to index
even a small push (see the measurements below), and `limits.cpu_ms` cannot
be set on it. A pure mirror can follow small pushes on the Free plan once
it has been seeded (see "A pure mirror on the Workers Free plan").

```sh
pnpm install
cd apps/forge-worker
npx wrangler login
npx wrangler r2 bucket create git-forge
npx wrangler d1 create git-forge
```

For federation and mirrors also create the job queue and the instance key:

```sh
npx wrangler queues create git-forge-jobs
pnpm --filter forge-worker instance-key | npx wrangler secret put INSTANCE_KEY
```

and set `PUBLIC_URL` in `vars`.

Put the `database_id` printed by `d1 create` into `wrangler.jsonc` (the
committed value is an all-zero placeholder). If you pick other bucket or
database names, change `bucket_name` / `database_name` as well.

```sh
openssl rand -base64 32 | npx wrangler secret put ADMIN_TOKEN
npx wrangler deploy
```

Create a repository and push:

```sh
curl -X POST https://git-forge.<account>.workers.dev/api/admin/repos \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"owner":"acme","name":"site"}'
git push https://git:$ADMIN_TOKEN@git-forge.<account>.workers.dev/acme/site.git main
git clone https://git-forge.<account>.workers.dev/acme/site.git
```

To use your own domain, add a `routes` entry with `custom_domain: true` to
`wrangler.jsonc` or attach the domain in the dashboard.

## Local development

```sh
cp .dev.vars.example .dev.vars
pnpm --filter forge-worker dev
```

`wrangler dev` runs the Worker in workerd with a local R2 bucket and D1
database (Miniflare), persisted under `.wrangler/`. `.dev.vars` is gitignored.

## Tests

- `pnpm --filter forge-worker test` runs the unit tests of the request
  handling and then the end-to-end suite.
- `pnpm --filter forge-worker test:e2e` runs only the end-to-end suite: it
  starts `wrangler dev` on a free port with a fresh local R2 bucket, creates a
  repository through the admin endpoint, pushes a generated history of 120
  commits with the real `git` client, clones it with protocol v2 and with
  `git -c protocol.version=0` (dumb HTTP), pushes incrementally, force-pushes
  and checks that the previous tip is kept under `refs/archive/`, and fires the
  Cron Trigger through `/__scheduled`. A second suite starts a private
  instance (`PUBLIC_READ=false` with a `READ_TOKEN`), uploads a JPEG with the
  real `git lfs push` and reads it back through the media and raw URLs
  (headers, Range, HEAD, `304`, redirect). Together they take about 20 seconds
  and are part of the root `pnpm test`.
- `test/e2e/notify.e2e.test.ts` (part of `test:e2e`) runs three instances
  alpha → beta → gamma in one Node process with the same request handler,
  SQLite and the in-memory job queue: mirrors subscribe at their upstream, a
  push of a commit with an LFS object to alpha reaches gamma through
  notifications alone (no scheduled handler is called, and the first
  delivery is made to fail to exercise the retry), packs are byte-identical
  on all three, duplicate notifications are no-ops, notifications from
  untrusted issuers, with foreign keys, for other audiences or about other
  repositories are rejected, subscriptions from untrusted instances or with
  foreign callbacks are refused, and a force push is archived with an alarm
  on both mirrors.
- `pnpm --filter forge-worker bench` measures CPU time and memory per
  operation (below); `pnpm --filter forge-worker bench:mirror` measures a
  pure mirror per invocation (further below).

The R2 adapter itself is tested inside workerd in `packages/cloudflare`.

## CPU time and memory

`pnpm --filter forge-worker bench` runs the same request handler in Node.js
(the same V8 engine as workerd) with in-memory storage, drives it with the real
`git` client and records process CPU time per operation. Process CPU time
includes V8's garbage-collector threads, so these are upper bounds; the Worker
also spends no CPU time while waiting for R2. Measured on the development
container (Node 22.22, git 2.43):

| operation | requests | CPU total (ms) | CPU max per request (ms) | wall (ms) | peak JS memory (MiB) |
|---|---|---|---|---|---|
| push small (120 commits, 1047 objects, 0.9 MiB pack) | 3 | 274 | 268 | 213 | 11 |
| clone v2 small | 3 | 1170 | 1164 | 791 | 21 |
| clone dumb small | 8 | 10 | 3 | 92 | 4 |
| push medium (500 commits, 4382 objects, 14.1 MiB pack) | 4 | 1590 | 1581 | 1266 | 59 |
| clone v2 medium | 3 | 6002 | 5981 | 4742 | 123 |
| clone dumb medium | 8 | 32 | 28 | 377 | 14 |
| push large (600 commits, 5272 objects, 32.0 MiB pack) | 4 | 2734 | 2728 | 2259 | 104 |
| clone v2 large | 3 | 10110 | 10031 | 8556 | 64 |
| clone dumb large | 8 | 100 | 97 | 774 | 64 |

The peak memory column samples the JS heap plus array buffers every 5 ms, so
short peaks can be missed, and it includes the stored data of the in-memory
storage.

Conclusions for the configuration:

- **Push** costs roughly 0.1–0.3 s of CPU per MiB of pack (inflating, hashing
  and indexing every object). This fits easily into the default 30 s.
- **Clone over protocol v2** is the expensive path: the core currently builds
  a fresh pack in memory for every fetch, about 0.3–0.4 s of CPU per MiB of
  repository. `wrangler.jsonc` therefore raises `limits.cpu_ms` to 60 000
  (the maximum is 300 000) to leave headroom as repositories grow.
- **Clone over dumb HTTP** only streams stored packs from R2 and costs almost
  no CPU. For large public repositories it is the cheap path, and it could
  also be served directly from a public R2 bucket.
- **Memory** is the tighter limit: a Worker isolate has 128 MB. The core
  buffers a whole push request and, for protocol v2 fetches, the whole
  response pack. That is why `MAX_PUSH_BYTES` defaults to 16 MiB, and why
  protocol v2 clones of repositories beyond roughly 15 MiB of packs may run
  out of memory until the core streams pack generation. CPU time for a real
  request is visible in Workers Logs (`observability` is enabled) and with
  `npx wrangler tail`.

## A pure mirror on the Workers Free plan

`pnpm --filter forge-worker bench:mirror` runs an upstream instance in a
child process and a mirror in the measuring process (same request handler,
SQLite, in-memory job queue, an in-memory bucket that costs no JavaScript CPU
for ETags, like R2). It pushes generated histories to the upstream with the
real `git` client and records, for every invocation on the mirror, process
CPU time, wall time, storage operations and outbound fetches. Each push
leads to one notification request, one copy-only sync job and one delivery
job to a subscriber of the mirror. A second set of rows ("replay") repeats
the notification handling, the sync and the delivery in process against a
snapshot of the mirror's bucket and the recorded upstream responses; these
exclude Node's JavaScript HTTP client and server (workerd's `fetch` is
native) and SQLite (D1 is remote I/O, not CPU), and are the better estimate
for the Worker. Median (and range) of three runs on the development
container, Node 22.22:

| scenario | invocation | CPU ms, median | range | storage ops | fetches |
|---|---|---|---|---|---|
| small repo, initial push (120 commits, 1047 objects, 0.9 MiB pack) | notification request | 10.6 | 9.6–10.9 | 3 | 2 (JWKS, cold) |
| | sync job | 38.7 | 32.0–45.0 | 23 | 5 |
| | delivery job | 3.8 | 3.4–4.6 | 1 | 1 |
| | replay: notification handler | 2.0 | 1.8–2.0 | | |
| | replay: copy-only sync | 21.8 | 19.2–26.6 | | 5 |
| | replay: delivery | 1.0 | 1.0–1.6 | | 1 |
| small repo, incremental push (1 commit, 2 files), 3 pushes | notification request | 5.6–7.1 | 4.3–7.9 | 3 | 0 |
| | sync job | 11.0–14.5 | 9.8–14.7 | 24–26 | 5 |
| | delivery job | 2.1–2.8 | 2.0–4.9 | 1 | 1 |
| | replay: notification handler | 1.6–2.8 | 1.6–5.5 | | |
| | replay: copy-only sync | 4.6–5.4 | 4.3–8.8 | | 5 |
| | replay: delivery | 0.7–0.8 | 0.7–4.0 | | 1 |
| medium repo, initial push (500 commits, 4382 objects, 14.1 MiB pack) | notification request | 3.8 | 3.8–4.0 | 3 | 0 |
| | sync job | 230.7 | 207.8–295.9 | 22 | 5 |
| | replay: copy-only sync | 156.0 | 150.8–157.6 | | 5 |
| medium repo, incremental push (1 commit, 2 files), 3 pushes | notification request | 6.2–6.8 | 5.6–8.6 | 3 | 0 |
| | sync job | 8.1–9.4 | 8.0–10.4 | 23–25 | 5 |
| | replay: notification handler | 1.4–2.4 | 1.4–2.5 | | |
| | replay: copy-only sync | 4.3–4.7 | 3.5–6.3 | | 5 |
| | replay: delivery | 0.7–2.0 | 0.7–2.8 | | 1 |
| for comparison: re-indexing sync (fetch strategy, protocol v2) | small / medium | 207 / 874 | | | |
| deep check | small / medium | 656 / 2 668 | | | |
| hashing in JavaScript (`@noble/hashes`) | SHA-1 / SHA-256 per MiB | 6.2 / 7.3 | 5.1–13.3 | | |
| hashing natively (WebCrypto) | SHA-1 / SHA-256 per MiB | 1.8 / 1.2 | 1.0–2.0 | | |

Process CPU time includes V8's garbage-collector threads, and the container
is noisy (single runs vary by up to ±50 %), so read these as estimates.

**Does a pure mirror fit the Free plan?** Workers Free allows 10 ms CPU per
invocation, 50 subrequests per invocation (R2, KV and D1 calls count),
100 000 requests per day and five Cron Triggers; Queues are included with
10 000 operations per day (about three per message) and Workflows with
10 ms CPU per step (sources and details in `docs/design.md` §12).

- **Yes for the steady state:** a small push costs the mirror about 2 ms
  for the notification, 5 ms for the copy-only sync and 1 ms per delivery
  to its own subscribers, each in its own invocation (`max_batch_size: 1`),
  with about 30 subrequests per sync. Idle, the mirror runs one cron
  invocation per day.
- **No for bulk data:** the initial copy of a repository, pushes with more
  than about 0.8 MiB of new pack data and LFS objects above about 1 MiB
  exceed 10 ms, because every byte is hashed in JavaScript (SHA-1 for the
  pack trailer, SHA-256 for LFS). The deep check and the re-indexing sync
  need Workers Paid (or a Node/Pi instance).
- **Nearly there:** native streaming hashes (`crypto.DigestStream`), one job
  per pack and per LFS object, and ranged object reads would raise the
  per-invocation limit to packs of ~3 MiB and LFS objects of ~5 MiB; seeding
  a mirror once on a larger runtime covers the rest. The full list is in
  `docs/design.md` §12. A Free-plan deployment must drop `limits.cpu_ms`
  from `wrangler.jsonc`.

## Cost notes

Prices as published by Cloudflare at the time of writing; check the current
Workers and R2 pricing pages before relying on them.

- **Workers Paid:** 5 USD per month, including 10 million requests and
  30 million CPU milliseconds; beyond that 0.30 USD per million requests and
  0.02 USD per million CPU milliseconds. With the measurements above, the
  included CPU time covers about 100 000 pushes of a 1 MiB pack or about
  5 000 protocol v2 clones of a 14 MiB repository per month; a 14 MiB clone
  beyond the allowance costs about 0.0001 USD.
- **R2:** 0.015 USD per GB-month after 10 GB free, 4.50 USD per million
  Class A operations (writes, lists) after 1 million free, 0.36 USD per
  million Class B operations (reads) after 10 million free, and no egress
  fees. A push performs about six writes (pack, index, pack list, refs, server
  info) and a few reads; a clone a handful of reads. For a 100 GB archive
  storage dominates: about 1.35 USD per month.
- **D1** holds only the federation tables and stays within its free allowance.
- **Queues:** a notification, a sync and a delivery are three messages per
  push and mirror, far below the 10 000 free operations per day.
