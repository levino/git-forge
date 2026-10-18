# forge-worker

The Cloudflare Worker deployment of git-forge. It serves Git over HTTPS
(smart HTTP protocol v2 for fetch, `receive-pack` for push, dumb HTTP for
protocol v0 clients) and Git LFS straight from an R2 bucket, keeps accounts,
tokens and federation trust in D1, and keeps mirrors current through signed
push notifications, a job queue and a daily Cron Trigger as safety net.

`src/app.ts` is platform-neutral: `createForge({ storage, db, ... })` takes a
core `Storage` and an accounts `Database` and returns `{ fetch, scheduled, runJob }`.
`src/index.ts` only wires the Cloudflare bindings (`R2Storage`, `d1Database`,
`QueueJobs` and the queue consumer)
and parses the vars (`src/config.ts`). The same app runs in Node for the unit
tests and the benchmark.

## Configuration

| Name | Kind | Purpose |
|---|---|---|
| `BUCKET` | R2 binding | Repository data in the bucket layout of `docs/design.md` (`repos/<owner>/<name>/…`). |
| `DB` | D1 binding | Accounts, tokens, repository roles, branch protection, instance trust, audit log (`@git-forge/accounts`). Migrations come from `packages/accounts/migrations` (`migrations_dir`) and are applied with `wrangler d1 migrations apply`. |
| `JOBS` | Queue binding, optional | Background jobs: mirror syncs, notification deliveries, subscription renewals, deep checks (`src/mirror-federation.ts`). One message per invocation (`max_batch_size: 1`), retried with exponential backoff. With `JOBS`, `INSTANCE_KEY` and `PUBLIC_URL` set, push notifications are on. |
| Cron `17 3 * * *` | trigger | Daily safety net: with `JOBS`, enqueues a sync (and a subscription renewal) for every due auto mirror and the periodic deep checks; without `JOBS`, syncs due mirrors inline. |
| `BOOTSTRAP_TOKEN` | secret | Allows exactly one successful `POST /api/bootstrap`, which creates the first instance admin. |
| `INSTANCE_KEY` | secret, optional | Ed25519 private JWK of this instance. Needed to mirror private repositories from other instances; also publishes `/.well-known/openid-configuration` and `/.well-known/jwks.json`. Generate with `pnpm --filter forge-worker instance-key`. |
| `PUBLIC_URL` | var, optional | Base URL of the instance, used as its issuer (when minting) and audience (when verifying instance tokens). Defaults to the origin of the request; scheduled sync with instance tokens needs it set. |
| `MAX_PUSH_BYTES` | var | Largest accepted push request, default 16 MiB. Larger files belong in Git LFS. |
| `MAX_LFS_OBJECT_BYTES` | var | Largest accepted LFS object, default 100 MiB (Cloudflare's request body limit on the Free and Pro plans). Larger objects get a per-object error in the batch API and `413` on `PUT`. |
| `MIRROR_INTERVAL_MINUTES` | var | Minimum time between two scheduled syncs of a mirror, default 30; `wrangler.jsonc` sets 1440 (daily) because notifications carry the real-time updates; `0` syncs on every cron tick. |
| `MIRROR_DEEP_CHECK_DAYS` | var | Every how many days a mirror gets the full re-verification (re-hash every object, recompute every index), default 30, `0` = only on demand. |
| `ALLOW_INSECURE_FEDERATION` | var | `true` lets the instance fetch other instances' JWKS over plain HTTP. Only for local tests. |

Repositories are **private by default**; visibility is set per repository.
There is no global "public read" switch any more.

## Authentication

- **Git and LFS** use personal access tokens (`gfp_…`) as HTTP Basic password
  (any user name) or as `Authorization: Bearer`, e.g.
  `https://git:<token>@forge.example/acme/site.git`. The token's scopes cap the
  access (`repo:read`, `repo:write`, `repo:admin`); the repository role decides
  the rest (`@git-forge/accounts`).
- **Other instances** present a short-lived EdDSA JWT. The core tells the
  authorizer whether a request is Git or LFS, so the token scopes `git:read`
  and `lfs:read` are checked separately.
- **The JSON API** needs a token with `repo:admin`.

## API

| Route | Who | Purpose |
|---|---|---|
| `POST /api/bootstrap` `{login, email?}` | `Bearer <BOOTSTRAP_TOKEN>` | Creates the first instance admin and returns `{login, token}` (a `repo:admin` token without expiry). `409` once an admin exists. |
| `POST /api/admin/users` `{login, email?, admin?}` | instance admin | Creates a user. |
| `POST /api/admin/users/{login}/tokens` `{name?, scopes?, expiresAt?}` | instance admin | Issues a personal access token (shown once). |
| `POST /api/admin/instances` `{issuer, pinnedThumbprint?}` | instance admin | Trusts another instance. |
| `POST /api/repos` `{owner, name, visibility?, defaultBranch?}` | the owner, or an instance admin | Creates a repository in R2 and D1 (`visibility` defaults to `private`). |
| `PATCH /api/repos/{owner}/{name}` `{visibility}` | repository admin | Changes visibility. |
| `PUT /api/repos/{owner}/{name}/collaborators/{login}` `{role}` | repository admin | Sets a collaborator role. |
| `POST /api/repos/{owner}/{name}/instances` `{issuer}` | repository admin | Lets a trusted instance read this repository (Git and LFS). |
| `GET /api/repos/{owner}/{name}/mirrors` | repository admin | Mirror configs and status (last run, alarms, pending LFS objects). |
| `POST /api/repos/{owner}/{name}/mirrors` `{url, remote?, mode?, namespace?, lfs?, lfsUrl?, auth?}` | repository admin | Configures a mirror. `auth: "instance"` presents an instance token to the upstream and, with jobs enabled, subscribes to its push notifications. The first sync is enqueued. |
| `POST /api/repos/{owner}/{name}/mirrors/{remote}/sync` | repository admin | Syncs now; `502` with the error if the sync failed. |
| `POST /api/repos/{owner}/{name}/mirrors/{remote}/verify` | repository admin | Runs the deep check now and stores the result in the mirror status. |
| `POST\|DELETE /api/federation/subscriptions` `{repository, callback}` | trusted instance (instance JWT) | Subscribes to push notifications for a repository it may read; the callback must be below its own issuer URL. |
| `POST /api/federation/notify/{owner}/{name}/{remote}` | trusted upstream (signed body, `application/jwt`) | Push notification. `401` for an untrusted issuer, unknown key, bad signature, wrong audience or expired token; `403` if this mirror does not follow that repository; `200 up-to-date` for a duplicate; `202 queued` otherwise. |
| `POST /api/repos/{owner}/{name}/mirrors/{remote}/detach` | repository admin | Stops syncing. |
| `GET /api/health` | anyone | `{"ok": true}` |

Instance admins count as admins of every repository.

Branch protection rules use the GitHub-style API of `@git-forge/accounts`
(`GET /api/repos/{owner}/{name}/branch-protection`,
`GET|PUT|DELETE /api/repos/{owner}/{name}/branches/{pattern}/protection`) and
are enforced on every push.

## Media and raw URLs

- `GET|HEAD /<owner>/<name>/media/<oid>[/<filename>]` serves an LFS object by
  its SHA-256 oid, immutable and with Range support (authorized as LFS read).
- `GET|HEAD /<owner>/<name>/raw/<ref>/<path>` serves a file from a branch, tag,
  `HEAD` or full commit id; LFS pointers redirect to the media URL (authorized
  as Git read). Details in `docs/design.md` §7.

### Putting a CDN in front (e.g. Bunny)

The media and raw URLs are made for a pull-zone CDN; it fetches from the
Worker on a cache miss, nothing is uploaded.

1. Create a pull zone with the Worker URL (or its custom domain) as origin.
2. Leave caching to the origin headers: media URLs and raw URLs with a full
   commit id are `immutable` for a year, raw URLs on branches and tags are
   cached for 60 seconds. Query strings are not used, so the cache may ignore
   them.
3. For private repositories, create a user for the CDN (`POST
   /api/admin/users`), give it the `read` role on the repositories
   (`PUT /api/repos/{owner}/{name}/collaborators/{login}`), issue it a token
   with the scope `repo:read`, and let the pull zone send it with every origin
   request. In Bunny add an Edge Rule with the action "Set Request Header"
   (applied to origin requests) `Authorization: Bearer <token>`. The token can
   read but cannot push. Whatever the CDN has cached is readable by anyone who
   can reach the pull zone, so protect the pull zone itself (Bunny token
   authentication) unless the content is meant to be public.

Then `https://<zone>.b-cdn.net/acme/site/raw/main/photos/a.jpg` redirects to
`https://<zone>.b-cdn.net/acme/site/media/<oid>/a.jpg`, which the CDN keeps.

## Deploying to Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/levino/git-forge-instance)

New instances are deployed from the
[instance template](../../templates/instance): the button copies it (as
`levino/git-forge-instance`), connects Workers Builds, asks for
`BOOTSTRAP_TOKEN` and creates the R2 bucket and the D1 database from its
`wrangler.jsonc`. The template deploys a pinned, checksummed release bundle of
this Worker and applies the D1 migrations before every upload
(`docs/design.md` §15). A button pointing at this directory would not work:
Cloudflare requires a subdirectory to be self-contained, and this Worker
builds from the workspace packages.

A Workers **Paid** plan is required for an instance that receives pushes:
the Free plan allows 10 ms of CPU per request, which is not enough to index
even a small push (see the measurements below), and `limits.cpu_ms` cannot be
set on it. A pure mirror can follow small pushes on the Free plan once it has
been seeded (see "A pure mirror on the Workers Free plan").

From a checkout of this repository (for development instances):

```sh
pnpm install
cd apps/forge-worker
npx wrangler login
openssl rand -base64 32 | npx wrangler secret put BOOTSTRAP_TOKEN
npx wrangler deploy
npx wrangler d1 migrations apply DB --remote
```

The first `wrangler deploy` creates the bucket and the database from the
binding names; no IDs need to be filled in. Later deployments apply new
migrations first (`wrangler d1 migrations apply DB --remote`, then
`wrangler deploy`). The Worker never migrates the database itself.

### First admin

```sh
curl -X POST https://git-forge.<account>.workers.dev/api/bootstrap \
  -H "Authorization: Bearer $BOOTSTRAP_TOKEN" -H 'Content-Type: application/json' \
  -d '{"login":"alice"}'
# {"login":"alice","token":"gfp_…"}
```

Keep the returned token; it is shown once. Afterwards the bootstrap token is
useless and may be deleted (`npx wrangler secret delete BOOTSTRAP_TOKEN`).

```sh
curl -X POST https://git-forge.<account>.workers.dev/api/repos \
  -H "Authorization: Bearer $TOKEN" -d '{"owner":"alice","name":"site"}'
git push https://git:$TOKEN@git-forge.<account>.workers.dev/alice/site.git main
```

### Federation

To mirror private repositories of other instances, give the instance a key and
its public URL:

```sh
pnpm --filter forge-worker instance-key | npx wrangler secret put INSTANCE_KEY
npx wrangler queues create git-forge-jobs
npx wrangler deploy --var PUBLIC_URL:https://git-forge.<account>.workers.dev
```

(or set `PUBLIC_URL` under `vars`). On the upstream an instance admin trusts
the mirror's URL (`POST /api/admin/instances`), and a repository admin grants
it the repository (`POST /api/repos/{owner}/{name}/instances`). The mirror then
configures `POST /api/repos/{owner}/{name}/mirrors` with
`{"url": "https://upstream.example/owner/name.git", "auth": "instance"}`.
Upstream refs land under `refs/upstream/origin/*`. To mirror a mirror, use
`"namespace": "upstream/origin/"`. For push notifications the mirror must
also trust the upstream (`POST /api/admin/instances` on the mirror), because
it verifies the upstream's signature; the subscription itself is made by the
mirror when the mirror is configured and renewed by the daily cron. After a
push the upstream enqueues one notification per subscriber, the mirror
enqueues a copy-only sync (`docs/design.md` §4, §7), and a mirror whose refs
moved notifies its own subscribers, so chains propagate without cron.

To use your own domain, add a `routes` entry with `custom_domain: true` to
`wrangler.jsonc` or attach the domain in the dashboard.

## Several instances: `alpha`, `beta`, `gamma`

`wrangler.jsonc` defines three environments, each with its own Worker name,
R2 bucket and D1 database (`git-forge-alpha`, …). Every Cloudflare resource
comes from the config, nothing is created in the dashboard: buckets and
databases have names but no IDs, so the first `wrangler deploy` provisions
them; migrations come from `migrations_dir`; cron, vars and the required
secret (`secrets.required`) are declared as well. An environment goes from
nothing to running with:

```sh
npx wrangler deploy --env alpha
npx wrangler d1 migrations apply DB --env alpha --remote
npx wrangler secret put BOOTSTRAP_TOKEN --env alpha
```

Later deployments apply migrations first, then deploy. For federation each
environment also needs `INSTANCE_KEY` (secret) and `PUBLIC_URL` (var). Locally:

```sh
npx wrangler d1 migrations apply DB --env beta --local
npx wrangler dev --env beta --port 8788
```

## Local development

```sh
cp .dev.vars.example .dev.vars
npx wrangler d1 migrations apply DB --local
pnpm --filter forge-worker dev
```

`wrangler dev` runs the Worker in workerd with a local R2 bucket and D1
database (Miniflare), persisted under `.wrangler/`. `.dev.vars` is gitignored.

## Tests

- `pnpm --filter forge-worker test` runs the unit tests and then the
  end-to-end suites (about 25 seconds, part of the root `pnpm test`). Each
  `wrangler dev` start applies the D1 migrations with
  `wrangler d1 migrations apply --local` first, as a deployment does.
- Unit tests (`test/unit`) run the app in Node with `MemoryStorage` and
  `node:sqlite`: settings, media/raw authorization, branch protection API, bootstrap, admin API, PAT authorization, private
  defaults, visibility and collaborators, the LFS size limit, federation and
  scheduled sync between two in-process instances over real HTTP, and the
  shape of the wrangler environments.
- `test/e2e/forge.e2e.test.ts` starts `wrangler dev` with a fresh local R2
  bucket and D1 database, bootstraps an admin, creates repositories, pushes a
  generated history of 120 commits with the real `git` client, clones it with
  protocol v2 and with `git -c protocol.version=0` (dumb HTTP), checks that
  repositories are private by default, pushes incrementally, force-pushes and
  checks the previous tip under `refs/archive/`, and fires the Cron Trigger
  through `/__scheduled`.
- `test/e2e/federation.e2e.test.ts` starts the `alpha`, `beta` and `gamma`
  environments as three `wrangler dev` processes with their own keys. It
  pushes a private repository with Git LFS objects to alpha with the real
  `git` and `git-lfs`; beta mirrors it from alpha, first failing with `401`,
  then succeeding once alpha trusts beta and grants the repository; gamma
  mirrors beta's `refs/upstream/origin/*` and may not read alpha directly. A
  force push on alpha must be archived on alpha, beta and gamma, raise a
  `history-rewritten` alarm on both mirrors, and bring its new LFS object down
  the chain. Those syncs are started by the Cron Trigger (which now
  enqueues them on the local Queue). Finally beta and gamma trust their
  upstreams, and a new push to alpha must reach beta and gamma through push
  notifications and the job queues alone, without any cron tick.
- `test/e2e/notify.e2e.test.ts` runs alpha → beta → gamma as three
  `createForge` instances in one Node process (own HTTP servers, SQLite,
  in-memory job queue, real keys): mirrors subscribe at their upstream; a push
  with an LFS object to alpha reaches gamma through notifications alone (the
  scheduled handler is never called; the first delivery is made to fail to
  exercise the retry); packs are byte-identical on all three; duplicate
  notifications are no-ops; notifications from untrusted issuers, with
  foreign keys, for other audiences or about other repositories are
  rejected; subscriptions from untrusted instances or with foreign callbacks
  are refused; a force push is archived with an alarm on both mirrors; the
  deep check passes; and a push still succeeds when the job queue is down.
- `test/e2e/media.e2e.test.ts` starts an instance, issues a `repo:read`
  token, uploads a JPEG to a private repository with the real `git lfs push`
  and reads it back through the media and raw URLs (headers, Range, HEAD,
  `304`, redirect).
- `pnpm --filter forge-worker bench` measures CPU time and memory per
  operation (below); `pnpm --filter forge-worker bench:mirror` measures a pure
  mirror per invocation (further below).

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
child process and a mirror in the measuring process (`createForge` with
SQLite, the in-memory job queue and an in-memory bucket that, like R2, spends
no JavaScript CPU on ETags). It pushes generated histories to the upstream
with the real `git` client and records, for every invocation on the mirror,
process CPU time, storage operations and outbound fetches. Each push leads to
one notification request, one copy-only sync job and one delivery job to a
subscriber of the mirror. The "replay" rows repeat the notification
handling, the sync job and the delivery in process against a snapshot of the
mirror's bucket and the recorded upstream responses. They exclude Node's
JavaScript HTTP client and server (workerd's `fetch` is native) and SQLite
(D1 is remote I/O, not CPU) and are the better estimate for the Worker; the
live rows are upper bounds. Median and range of three runs on the
development container, Node 22.22:

| scenario | invocation | CPU ms, median | range | storage ops | fetches |
|---|---|---|---|---|---|
| small repo, initial push (120 commits, 1047 objects, 0.9 MiB pack) | notification request | 6.8 | 6.6–7.1 | 3 | 2 (JWKS, cold) |
| | sync job | 33.7 | 31.7–37.0 | 23 | 5 |
| | delivery job | 3.6 | 3.2–3.9 | 1 | 1 |
| | replay: notification handler | 1.7 | 1.6–1.8 | | |
| | replay: copy-only sync job | 21.8 | 20.1–27.1 | | 5 |
| | replay: delivery job | 0.9 | 0.8–1.0 | | 1 |
| small repo, incremental push (1 commit, 2 files), 3 pushes | notification request | 4.5–4.6 | 4.1–6.1 | 3 | 0 |
| | sync job | 8.7–14.0 | 7.9–16.8 | 24–26 | 5 |
| | delivery job | 1.7–2.0 | 1.5–6.2 | 1 | 1 |
| | replay: notification handler | 1.4–2.1 | 1.3–2.2 | | |
| | replay: copy-only sync job | 4.6–5.4 | 3.6–5.8 | | 5 |
| | replay: delivery job | 0.6–0.7 | 0.6–0.7 | | 1 |
| medium repo, initial push (500 commits, 4382 objects, 14.1 MiB pack) | notification request | 3.6 | 3.5–3.6 | 3 | 0 |
| | sync job | 210.0 | 196.0–237.3 | 22 | 5 |
| | replay: copy-only sync job | 156.9 | 138.0–165.3 | | 5 |
| medium repo, incremental push (1 commit, 2 files), 3 pushes | notification request | 6.4–10.0 | 6.3–12.9 | 3 | 0 |
| | sync job | 8.9–13.3 | 8.1–17.1 | 23–25 | 5 |
| | replay: notification handler | 1.3–1.5 | 1.2–2.0 | | |
| | replay: copy-only sync job | 4.1–5.6 | 3.3–6.1 | | 5 |
| | replay: delivery job | 0.6–3.1 | 0.5–3.5 | | 1 |
| for comparison: re-indexing sync (fetch strategy, protocol v2) into an empty mirror | small / medium | 195 / 858 | | | |
| deep check | small / medium | 606 / 2 624 | | | |
| hashing in JavaScript (`@noble/hashes`) | SHA-1 / SHA-256 per MiB | 6.3 / 7.7 | 6.2–10.4 | | |
| hashing natively (WebCrypto) | SHA-1 / SHA-256 per MiB | 1.8 / 1.3 | 1.1–1.8 | | |

Process CPU time includes V8's garbage-collector threads, and the container
is noisy (single values vary by up to ±50 %); read these as estimates.

**Does a pure mirror fit the Free plan?** Workers Free allows 10 ms CPU per
invocation, 50 subrequests per invocation (calls to R2, KV and D1 count),
100 000 requests per day and five Cron Triggers per account; Queues are
included with 10 000 operations per day (about three per message) and
Workflows with 10 ms CPU per step (sources in `docs/design.md` §12).

- **Yes for the steady state:** a small push costs the mirror about 1.5 ms
  for the notification, 5 ms for the copy-only sync and under 1 ms per
  delivery to its own subscribers, each in its own invocation, with about 30
  subrequests per sync. Idle, the mirror runs one cron invocation per day.
- **No for bulk data:** the initial copy of a repository, pushes with more
  than about 0.8 MiB of new pack data and LFS objects above about 1 MiB
  exceed 10 ms, because every byte is hashed in JavaScript (SHA-1 for the
  pack trailer, SHA-256 for LFS). The deep check and the re-indexing sync
  need Workers Paid (or a Node instance).
- **Nearly there:** native streaming hashes (`crypto.DigestStream`), one job
  per pack and per LFS object, and ranged object reads would raise the limit
  to packs of ~3 MiB and LFS objects of ~5 MiB per invocation; seeding a
  mirror once on a larger runtime covers the rest. The list of proposed
  changes is in `docs/design.md` §12. A Free-plan deployment must drop
  `limits.cpu_ms` from `wrangler.jsonc`.

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
- **D1** holds accounts, tokens, trust and the audit log: a few row reads
  per Git request, well within the free allowance for small instances.
- **Queues:** a notification, a sync and a delivery are three messages per
  push and mirror; idle instances send none.
