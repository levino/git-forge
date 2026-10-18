# forge-worker

The Cloudflare Worker deployment of git-forge. It serves Git over HTTPS
(smart HTTP protocol v2 for fetch, `receive-pack` for push, dumb HTTP for
protocol v0 clients) and Git LFS straight from an R2 bucket, keeps accounts,
tokens and federation trust in D1, and syncs mirrors from a Cron Trigger.

`src/app.ts` is platform-neutral: `createForge({ storage, db, ... })` takes a
core `Storage` and an accounts `Database` and returns `{ fetch, scheduled }`.
`src/index.ts` only wires the Cloudflare bindings (`R2Storage`, `d1Database`)
and parses the vars (`src/config.ts`). The same app runs in Node for the unit
tests and the benchmark.

## Configuration

| Name | Kind | Purpose |
|---|---|---|
| `BUCKET` | R2 binding | Repository data in the bucket layout of `docs/design.md` (`repos/<owner>/<name>/…`). |
| `DB` | D1 binding | Accounts, tokens, repository roles, branch protection, instance trust, audit log (`@git-forge/accounts`). Migrations come from `packages/accounts/migrations` (`migrations_dir`) and are applied with `wrangler d1 migrations apply`. |
| Cron `*/30 * * * *` | trigger | Syncs every due mirror with `mode: "auto"`. |
| `IMPORTS` | Queue binding, optional | Queue `git-forge-imports` (`git-forge-<env>-imports` per environment), produced and consumed by this Worker. Each message is one step of a server-side import in its own invocation. Without it the import endpoint answers `503`. |
| `BOOTSTRAP_TOKEN` | secret | Allows exactly one successful `POST /api/bootstrap`, which creates the first instance admin. |
| `INSTANCE_KEY` | secret, optional | Ed25519 private JWK of this instance. Needed to mirror private repositories from other instances; also publishes `/.well-known/openid-configuration` and `/.well-known/jwks.json`. Generate with `pnpm --filter forge-worker instance-key`. |
| `PUBLIC_URL` | var, optional | Base URL of the instance, used as its issuer (when minting) and audience (when verifying instance tokens). Defaults to the origin of the request; scheduled sync with instance tokens needs it set. |
| `MAX_PUSH_BYTES` | var, optional | Largest accepted push request. Unset by default: pushes are streamed, so only Cloudflare's request body limit applies (see Large pushes). |
| `PACKFILE_URI_BASE` | var, optional | Base URL for `packfile-uris` (e.g. a CDN in front of the forge). Defaults to the origin of the request. Pack URIs are only offered for repositories anyone may read. |
| `COMPACT_MAX_BYTES` | var, optional | Largest pack compaction run after a push through `waitUntil`, default 128 MiB; `0` disables it. |
| `MAX_LFS_OBJECT_BYTES` | var | Largest accepted LFS object, default 100 MiB (Cloudflare's request body limit on the Free and Pro plans). Larger objects get a per-object error in the batch API and `413` on `PUT`. |
| `MIRROR_INTERVAL_MINUTES` | var | Minimum time between two automatic syncs of a mirror, default 30; `0` syncs on every cron tick. |
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
| `POST /api/repos/{owner}/{name}/mirrors` `{url, remote?, mode?, namespace?, lfs?, lfsUrl?, auth?}` | repository admin | Configures a mirror. `auth: "instance"` presents an instance token to the upstream. |
| `POST /api/repos/{owner}/{name}/mirrors/{remote}/sync` | repository admin | Syncs now; `502` with the error if the sync failed. |
| `POST /api/repos/{owner}/{name}/mirrors/{remote}/detach` | repository admin | Stops syncing. |
| `POST /api/repos/{owner}/{name}/import` `{url, token?, username?, lfs?, lfsUrl?, commitsPerStep?, visibility?, defaultBranch?}` | repository admin or instance admin; for a new repository the owner or an instance admin | Imports from a Git URL (smart HTTP v2 or dumb HTTP) without a request body limit, creating the repository first if needed (as `POST /api/repos`). `token` is sent as HTTP Basic password with `username` (default `git`), travels only in the queue messages and is never stored. Refs land in `refs/heads/*` and `refs/tags/*`; rewritten refs are archived, local refs missing upstream are kept. `202` with the state and a `Location`, `409` while an import runs. |
| `GET /api/repos/{owner}/{name}/import` | repository admin | Import state: `phase` (`discover`, `graph`, `fetch`, `lfs`, `refs`, `done`, `failed`), progress, ref updates, missing LFS objects, last error. Starting a failed import again with the same URL resumes it. |
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

A Workers **Paid** plan is required: the Free plan allows 10 ms of CPU per
request, which is not enough to index even a small push (see the measurements
below), and `limits.cpu_ms` cannot be set on it.

From a checkout of this repository (for development instances):

```sh
pnpm install
cd apps/forge-worker
npx wrangler login
openssl rand -base64 32 | npx wrangler secret put BOOTSTRAP_TOKEN
npx wrangler deploy
npx wrangler d1 migrations apply DB --remote
```

Pushes larger than one staging chunk (4 MiB) are staged under `tmp/` while
they are indexed (`docs/design.md` §6). The forge never deletes anything, so
let the bucket expire that prefix:

```sh
npx wrangler r2 bucket lifecycle add git-forge expire-staging tmp/ --expire-days 1
```

The first `wrangler deploy` creates the bucket, the database and the import
queue from the binding names; no IDs need to be filled in. Later deployments apply new
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
npx wrangler deploy --var PUBLIC_URL:https://git-forge.<account>.workers.dev
```

(or set `PUBLIC_URL` under `vars`). On the upstream an instance admin trusts
the mirror's URL (`POST /api/admin/instances`), and a repository admin grants
it the repository (`POST /api/repos/{owner}/{name}/instances`). The mirror then
configures `POST /api/repos/{owner}/{name}/mirrors` with
`{"url": "https://upstream.example/owner/name.git", "auth": "instance"}`.
Upstream refs land under `refs/upstream/origin/*`. To mirror a mirror, use
`"namespace": "upstream/origin/"`.

To use your own domain, add a `routes` entry with `custom_domain: true` to
`wrangler.jsonc` or attach the domain in the dashboard.

## Several instances: `alpha`, `beta`, `gamma`

`wrangler.jsonc` defines three environments, each with its own Worker name,
R2 bucket and D1 database (`git-forge-alpha`, …). Every Cloudflare resource
comes from the config, nothing is created in the dashboard: buckets and
databases have names but no IDs and queues are declared by name, so the
first `wrangler deploy` provisions them; migrations come from `migrations_dir`; cron, vars and the required
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

## Large pushes

The Worker no longer caps pushes itself (`MAX_PUSH_BYTES` is optional), so the
limit is Cloudflare's request body size for the zone's plan: 100 MB on Free
and Pro, 200 MB on Business and 500 MB by default on Enterprise (check the
current Workers limits). A push larger than that fails with HTTP 413 before it
reaches the Worker. Ways around it:

- **Git LFS for large files.** LFS objects go straight to the bucket through
  presigned URLs and never pass through the Worker.
- **Chunked pushes.** `git forge push` from `packages/cli` splits a push into
  several pushes below a budget: `git forge push --max-bytes 90MiB <url> main`.
  Each push only carries the objects the forge does not have yet.
- **Server-side import.** Import the repository from where it already lives
  with `POST /api/repos/{owner}/{name}/import`. Each step runs as one queue
  message with its own CPU budget (`limits.cpu_ms`), fetches about
  `commitsPerStep` commits and at most 32 MiB of pack, and streams it into the
  same indexer as a push (`docs/design.md` §7, Import). Mirrors fetch the same
  way.

Every staging chunk is one R2 write and is read back once when the final pack
is written, so a 500 MB push performs a few hundred R2 operations.

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
  defaults, visibility and collaborators, the LFS size limit, the import
  endpoint's authorization and validation, federation and
  scheduled sync between two in-process instances over real HTTP, and the
  shape of the wrangler environments.
- `test/e2e/forge.e2e.test.ts` starts `wrangler dev` with a fresh local R2
  bucket and D1 database, bootstraps an admin, creates repositories, pushes a
  generated history of 120 commits with the real `git` client, clones it with
  protocol v2 and with `git -c protocol.version=0` (dumb HTTP), checks that
  repositories are private by default, pushes incrementally, force-pushes and
  checks the previous tip under `refs/archive/`, imports the generated
  repository from a local token-protected `git http-backend` server stepped
  through the local queue, pushes a 12 MiB pack that is staged in R2 while it
  is indexed, checks that pushes trigger compaction through `waitUntil` and
  clones with `packfile-uris`, pushes 24 MiB with `git forge push` against a
  16 MiB `MAX_PUSH_BYTES` (standing in for the platform limit), and fires the
  Cron Trigger through `/__scheduled`.
- `test/e2e/federation.e2e.test.ts` starts the `alpha`, `beta` and `gamma`
  environments as three `wrangler dev` processes with their own keys. It
  pushes a private repository with Git LFS objects to alpha with the real
  `git` and `git-lfs`; beta mirrors it from alpha, first failing with `401`,
  then succeeding once alpha trusts beta and grants the repository; gamma
  mirrors beta's `refs/upstream/origin/*` and may not read alpha directly. A
  force push on alpha must be archived on alpha, beta and gamma, raise a
  `history-rewritten` alarm on both mirrors, and bring its new LFS object down
  the chain. All syncs on beta and gamma run from the Cron Trigger.
- `test/e2e/media.e2e.test.ts` starts an instance, issues a `repo:read`
  token, uploads a JPEG to a private repository with the real `git lfs push`
  and reads it back through the media and raw URLs (headers, Range, HEAD,
  `304`, redirect).
- `pnpm --filter forge-worker bench` measures CPU time and memory per
  operation (below).

The R2 adapter itself is tested inside workerd in `packages/cloudflare`.

## CPU time and memory

`pnpm --filter forge-worker bench [small medium large xl xxl]` runs the same
request handler in Node.js (the same V8 engine as workerd) with `FsStorage`
from `@git-forge/node` (so stored data does not count as memory), drives it
with the real `git` client and records process CPU time per operation. Process
CPU time includes V8's garbage-collector threads and the file system calls of
`FsStorage`, so these are upper bounds; the Worker also spends no CPU time
while waiting for R2. Measured on the development container (Node 22.22,
git 2.43, 4 vCPUs) with the default budgets (16 MiB object cache, 4 MiB
staging chunks):

| operation | requests | CPU total (ms) | CPU max per request (ms) | wall (ms) | peak JS memory (MiB) |
|---|---|---|---|---|---|
| push small (120 commits, 1047 objects, 0.9 MiB pack) | 3 | 451 | 441 | 259 | 17 |
| clone v2 small | 3 | 49 | 36 | 89 | 0 |
| clone v2 with packfile-uris small | 4 | 19 | 7 | 98 | 3 |
| clone dumb small | 8 | 16 | 3 | 87 | 2 |
| push incremental small (20 commits) | 3 | 245 | 240 | 159 | 7 |
| fetch incremental small | 3 | 156 | 142 | 134 | 5 |
| clone v2 small (2 packs) | 3 | 63 | 54 | 94 | 6 |
| compact small (2 packs into 1) | 0 | 172 | 172 | 131 | 8 |
| push medium (500 commits, 4382 objects, 14.1 MiB pack) | 4 | 1418 | 1411 | 873 | 37 |
| clone v2 medium | 3 | 132 | 119 | 413 | 0 |
| clone v2 with packfile-uris medium | 4 | 47 | 29 | 340 | 14 |
| clone dumb medium | 8 | 73 | 63 | 346 | 10 |
| push incremental medium (20 commits) | 3 | 320 | 315 | 169 | 11 |
| fetch incremental medium | 3 | 274 | 260 | 255 | 10 |
| clone v2 medium (2 packs) | 3 | 356 | 350 | 443 | 18 |
| compact medium (2 packs into 1) | 0 | 751 | 751 | 515 | 24 |
| push large (600 commits, 5272 objects, 32.0 MiB pack) | 4 | 2290 | 2279 | 1589 | 44 |
| clone v2 large | 3 | 309 | 293 | 778 | 0 |
| clone v2 with packfile-uris large | 4 | 120 | 102 | 671 | 20 |
| clone dumb large | 8 | 107 | 96 | 740 | 23 |
| push incremental large (20 commits) | 3 | 327 | 323 | 187 | 13 |
| fetch incremental large | 3 | 327 | 319 | 326 | 11 |
| clone v2 large (2 packs) | 3 | 729 | 718 | 799 | 22 |
| compact large (2 packs into 1) | 0 | 1131 | 1131 | 849 | 22 |
| push xl (400 commits, 1680 objects, 200.6 MiB pack) | 4 | 9154 | 9145 | 7469 | 37 |
| clone v2 xl | 3 | 1483 | 1473 | 3524 | 26 |
| clone v2 with packfile-uris xl | 4 | 720 | 702 | 3052 | 31 |
| clone dumb xl | 8 | 719 | 707 | 3079 | 32 |
| push incremental xl (20 commits) | 3 | 218 | 213 | 123 | 11 |
| fetch incremental xl | 3 | 177 | 168 | 841 | 17 |
| clone v2 xl (2 packs) | 3 | 3140 | 3131 | 3659 | 29 |
| compact xl (2 packs into 1) | 0 | 3278 | 3278 | 2702 | 36 |
| push xxl (1000 commits, 4200 objects, 1025.6 MiB pack) | 4 | 50048 | 50022 | 44300 | 38 |
| clone v2 xxl | 3 | 5943 | 5922 | 26543 | 24 |
| clone v2 with packfile-uris xxl | 4 | 2698 | 2672 | 20113 | 33 |
| clone dumb xxl | 8 | 2792 | 2766 | 21155 | 34 |
| push incremental xxl (20 commits) | 3 | 193 | 185 | 137 | 6 |
| fetch incremental xxl | 3 | 211 | 200 | 472 | 0 |
| clone v2 xxl (2 packs) | 3 | 13188 | 13181 | 24937 | 38 |
| compact xxl (2 packs into 1) | 0 | 14425 | 14425 | 12918 | 35 |

`small`, `medium` and `large` are text-heavy histories with some binary
files; `xl` and `xxl` mostly consist of incompressible 5 and 10 MiB blobs. The
"incremental" rows push 20 more commits and pull them into an existing clone;
"2 packs" clones before compaction, "compact" then merges both packs. The
peak memory column samples the JS heap plus array buffers every 5 ms without
forcing garbage collection, so it includes garbage that V8 has not collected
yet and short peaks can be missed. `packages/node/test/streaming-memory.test.ts`
checks the bound with a 64 MiB push under a 4 MiB budget and a 96 MiB heap
limit.

Before the streaming core (same container, measured with in-memory storage
whose data counted as memory), a 32 MiB push cost 2.7 s of CPU and a protocol
v2 clone of it 10.1 s; the core buffered whole requests and response packs,
pushes were capped at 16 MiB and clones beyond about 15 MiB risked running out
of memory.

Conclusions for the configuration:

- **Memory no longer grows with the pack.** A push keeps a byte-budgeted
  object cache (16 MiB), one staging chunk (4 MiB) and about 60–100 bytes of
  metadata per object (id, offset, CRC, type, delta base, hash table slots)
  — the same order as the `.idx` file itself. Peaks stayed below 50 MiB for
  every size up to 1 GiB. The 128 MB isolate therefore limits a single push
  to roughly half a million objects, not to a number of bytes. Objects that
  are delta bases are materialized whole, so a single huge, delta-compressed
  file can still need a few times its own size; such objects are limited to
  64 MiB and large files belong in LFS anyway.
- **Push** costs about 45–75 ms of CPU per MiB for large packs (inflating,
  hashing and CRC-ing every object, writing staging chunks and the final
  pack) and up to 0.15 s per MiB for packs of many small text objects, whose
  inflated size is several times the pack size. A 1 GiB pack needs about 50 s
  of CPU, well within the maximum `limits.cpu_ms` of 300 000; `wrangler.jsonc`
  sets 60 000, which covers about 1 GiB of incompressible or 400 MiB of
  text-heavy pack. Raise it if you expect larger initial pushes.
- **Clone over protocol v2** streams the stored pack verbatim when there is
  one pack (about 6 ms of CPU per MiB, mostly for the side-band framing), and
  concatenates several packs with a recomputed header and trailer otherwise
  (about 13–16 ms per MiB, dominated by SHA-1). Compaction after each push keeps
  the number of packs logarithmic in the number of pushes. With
  `packfile-uris` (clients that set `fetch.uriProtocols`, e.g.
  `git -c fetch.uriProtocols=https clone …`) the client downloads the stored
  packs directly; behind a CDN (`PACKFILE_URI_BASE`) those downloads cost the
  Worker nothing.
- **Incremental fetches** walk the commits the client has, the new commits and
  the trees of the boundary commits, then copy stored entries (including
  deltas, sent as thin-pack deltas when the client has the base) instead of
  recompressing them.
- **Clone over dumb HTTP** remains the cheapest path for public repositories
  and could also be served directly from a public R2 bucket.

## Cost notes

Prices as published by Cloudflare at the time of writing; check the current
Workers and R2 pricing pages before relying on them.

- **Workers Paid:** 5 USD per month, including 10 million requests and
  30 million CPU milliseconds; beyond that 0.30 USD per million requests and
  0.02 USD per million CPU milliseconds. With the measurements above, the
  included CPU time covers about 60 000 pushes of a 1 MiB pack or about
  20 000 protocol v2 clones of a 200 MiB repository per month.
- **R2:** 0.015 USD per GB-month after 10 GB free, 4.50 USD per million
  Class A operations (writes, lists) after 1 million free, 0.36 USD per
  million Class B operations (reads) after 10 million free, and no egress
  fees. A push performs about six writes (pack, index, pack list, refs, server
  info) plus one write and one read per 4 MiB staging chunk, and a few reads;
  a clone a handful of reads. For a 100 GB archive
  storage dominates: about 1.35 USD per month.
- **D1** holds accounts, tokens, trust and the audit log: a few row reads
  per Git request, well within the free allowance for small instances.
