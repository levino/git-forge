# forge-worker

The Cloudflare Worker deployment of git-forge. It serves Git over HTTPS
(smart HTTP protocol v2 for fetch, `receive-pack` for push, dumb HTTP for
protocol v0 clients) straight from an R2 bucket, using `handleGitRequest` from
`@git-forge/core` and `R2Storage` from `@git-forge/cloudflare`.

## What is deployed

| Piece | Purpose |
|---|---|
| `BUCKET` (R2) | All repository data, in the bucket layout described in `docs/design.md` (`repos/<owner>/<name>/…`). |
| `DB` (D1) | Placeholder for the accounts package. Not used yet. |
| Cron Trigger `*/30 * * * *` | Stub for mirror sync; currently only logs. |
| `ADMIN_TOKEN` (secret) | Protects `POST /api/admin/repos` and, until accounts exist, every push. |
| `PUBLIC_READ` (var) | `true` (default): anyone may clone. `false`: clones need the admin token too. |
| `MAX_PUSH_BYTES` (var, optional) | Largest accepted push request. Unset by default: pushes are streamed, so only the platform's request body limit applies (see below). |
| `PACKFILE_URI_BASE` (var, optional) | Base URL for `packfile-uris` (e.g. a CDN in front of the forge). Defaults to the forge's own origin. Only offered when `PUBLIC_READ` is `true`. |
| `COMPACT_MAX_BYTES` (var, optional) | Largest compaction run after a push via `waitUntil`, default 128 MiB. |

### Routes

- `POST /api/admin/repos` with `Authorization: Bearer <ADMIN_TOKEN>` and a JSON
  body `{"owner": "acme", "name": "site", "defaultBranch": "main"}` creates a
  repository. Answers `201` with the clone URL, `409` if it exists, `400` for
  invalid names, `401` for a wrong token and `503` if no token is configured.
- `GET /api/health` answers `{"ok": true}`.
- `/<owner>/<name>.git/…` is Git. Push with the admin token as the HTTP Basic
  password (any user name), e.g. `https://git:<token>@forge.example/acme/site.git`
  or via a credential helper.

## Deploying to Cloudflare

A Workers **Paid** plan is required: the Free plan allows 10 ms of CPU per
request, which is not enough to index even a small push (see the measurements
below), and `limits.cpu_ms` cannot be set on it.

```sh
pnpm install
cd apps/forge-worker
npx wrangler login
npx wrangler r2 bucket create git-forge
npx wrangler d1 create git-forge
```

Put the `database_id` printed by `d1 create` into `wrangler.jsonc` (the
committed value is an all-zero placeholder). If you pick other bucket or
database names, change `bucket_name` / `database_name` as well.

Pushes larger than one staging chunk (4 MiB) are staged under `tmp/` while
they are indexed (see `docs/design.md` §6). The forge never deletes anything,
so let the bucket expire the staging prefix:

```sh
npx wrangler r2 bucket lifecycle add git-forge expire-staging tmp/ --expire-days 1
```

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
  and checks that the previous tip is kept under `refs/archive/`, pushes a
  12 MiB pack that is staged in R2 while it is indexed, checks that pushes
  trigger compaction through `waitUntil`, clones with `packfile-uris`, and
  fires the Cron Trigger through `/__scheduled`. It takes about 30 seconds and
  is part of the root `pnpm test`.
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
| push small (120 commits, 1047 objects, 0.9 MiB pack) | 3 | 505 | 495 | 319 | 12 |
| clone v2 small | 3 | 47 | 34 | 101 | 0 |
| clone v2 with packfile-uris small | 4 | 27 | 11 | 135 | 3 |
| clone dumb small | 8 | 16 | 3 | 95 | 1 |
| push incremental small (20 commits) | 3 | 292 | 288 | 192 | 12 |
| fetch incremental small | 3 | 170 | 159 | 169 | 5 |
| clone v2 small (2 packs) | 3 | 111 | 96 | 136 | 6 |
| compact small (2 packs into 1) | 0 | 229 | 229 | 190 | 8 |
| push medium (500 commits, 4382 objects, 14.1 MiB pack) | 4 | 2004 | 1994 | 1267 | 49 |
| clone v2 medium | 3 | 138 | 122 | 408 | 0 |
| clone v2 with packfile-uris medium | 4 | 53 | 33 | 366 | 17 |
| clone dumb medium | 8 | 35 | 26 | 400 | 15 |
| push incremental medium (20 commits) | 3 | 312 | 309 | 164 | 15 |
| fetch incremental medium | 3 | 364 | 357 | 353 | 11 |
| clone v2 medium (2 packs) | 3 | 411 | 403 | 420 | 19 |
| compact medium (2 packs into 1) | 0 | 966 | 966 | 732 | 26 |
| push large (600 commits, 5272 objects, 32.0 MiB pack) | 4 | 2367 | 2359 | 1686 | 45 |
| clone v2 large | 3 | 334 | 316 | 942 | 0 |
| clone v2 with packfile-uris large | 4 | 124 | 103 | 817 | 30 |
| clone dumb large | 8 | 133 | 125 | 692 | 18 |
| push incremental large (20 commits) | 3 | 342 | 338 | 173 | 15 |
| fetch incremental large | 3 | 357 | 347 | 323 | 10 |
| clone v2 large (2 packs) | 3 | 760 | 751 | 867 | 16 |
| compact large (2 packs into 1) | 0 | 1240 | 1240 | 949 | 24 |
| push xl (400 commits, 1680 objects, 200.6 MiB pack) | 4 | 9158 | 9138 | 7894 | 37 |
| clone v2 xl | 3 | 1353 | 1334 | 4544 | 25 |
| clone v2 with packfile-uris xl | 4 | 697 | 671 | 4290 | 30 |
| clone dumb xl | 8 | 796 | 774 | 3350 | 31 |
| push incremental xl (20 commits) | 3 | 184 | 176 | 136 | 9 |
| fetch incremental xl | 3 | 149 | 142 | 957 | 7 |
| clone v2 xl (2 packs) | 3 | 2999 | 2990 | 4427 | 34 |
| compact xl (2 packs into 1) | 0 | 2731 | 2731 | 2254 | 34 |
| push xxl (1000 commits, 4200 objects, 1025.6 MiB pack) | 4 | 48324 | 48297 | 42807 | 38 |
| clone v2 xxl | 3 | 5275 | 5258 | 29608 | 23 |
| clone v2 with packfile-uris xxl | 4 | 2824 | 2795 | 19495 | 34 |
| clone dumb xxl | 8 | 2646 | 2627 | 19413 | 33 |
| push incremental xxl (20 commits) | 3 | 210 | 202 | 146 | 7 |
| fetch incremental xxl | 3 | 256 | 247 | 684 | 0 |
| clone v2 xxl (2 packs) | 3 | 13939 | 13930 | 27175 | 37 |
| compact xxl (2 packs into 1) | 0 | 14198 | 14198 | 12964 | 36 |

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
  one pack (about 5 ms of CPU per MiB, mostly for the side-band framing), and
  concatenates several packs with a recomputed header and trailer otherwise
  (about 14 ms per MiB, dominated by SHA-1). Compaction after each push keeps
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

### Request body limits

The Worker no longer caps pushes itself (`MAX_PUSH_BYTES` is optional), so the
limit is Cloudflare's request body size for the zone's plan: 100 MB on Free
and Pro, 200 MB on Business and 500 MB by default on Enterprise (check the
current Workers limits). A push larger than that fails with HTTP 413 before it
reaches the Worker. Ways around it:

- **Git LFS for large files.** LFS objects go straight to the bucket through
  presigned URLs and never pass through the Worker.
- **Chunked initial pushes.** Push a long history in slices, oldest first,
  e.g. `git push origin <commit>:refs/heads/main` for every few hundred
  commits; each push only carries the objects the forge does not have yet.
- **Server-side import via a mirror.** A mirror sync fetches the upstream
  pack with the same streaming indexer, so its size is bounded only by CPU
  time, not by a request body limit; detach the mirror afterwards to continue
  with the repository as the primary.

Every staging chunk is one R2 write and is read back once when the final pack
is written, so a 500 MB push performs a few hundred R2 operations.

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
- **D1** is unused for now and stays within its free allowance.
