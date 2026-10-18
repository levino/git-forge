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
| `IMPORTS` (Queue `git-forge-imports`) | Drives server-side imports: each message is one import step in its own invocation (producer and consumer are this Worker). |
| `ADMIN_TOKEN` (secret) | Protects `POST /api/admin/repos` and, until accounts exist, every push. |
| `READ_TOKEN` (secret, optional) | Read-only token: clones, LFS downloads, media and raw URLs, but no pushes. Meant for a CDN pulling a private instance. |
| `PUBLIC_READ` (var) | `true` (default): anyone may read. `false`: reads need the read or admin token. |
| `MAX_PUSH_BYTES` (var) | Largest accepted push request, default 16 MiB. Larger files belong in Git LFS. |

### Routes

- `POST /api/admin/repos` with `Authorization: Bearer <ADMIN_TOKEN>` and a JSON
  body `{"owner": "acme", "name": "site", "defaultBranch": "main"}` creates a
  repository. Answers `201` with the clone URL, `409` if it exists, `400` for
  invalid names, `401` for a wrong token and `503` if no token is configured.
- `POST /api/admin/repos/<owner>/<name>/import` with the admin token and a
  JSON body `{"url": "https://github.com/acme/site.git", "token": "…"}`
  creates the repository if needed and imports it from the URL (smart HTTP v2
  or dumb HTTP). Optional fields: `username` (default `git`, sent with
  `token` as HTTP Basic), `lfs` (default `true`), `lfsUrl`, `commitsPerStep`
  (default 500), `defaultBranch` for a new repository. Answers `202` with the
  import state and a `Location` to poll, `409` while an import of that
  repository runs, `400` for invalid input (also for credentials inside the
  URL) and `503` without the `IMPORTS` queue. The token is never stored in the
  bucket; it travels with the queue messages. A repository that already has
  content is updated: refs move to the upstream values (rewrites are archived
  under `refs/archive/`), local refs that upstream lacks are kept.
- `GET /api/admin/repos/<owner>/<name>/import` returns the import state
  (`phase`: `discover`, `graph`, `fetch`, `lfs`, `refs`, `done` or `failed`,
  plus progress, ref updates, missing LFS objects and the last error).
  Starting a failed import again with the same URL resumes it.
- `GET /api/health` answers `{"ok": true}`.
- `/<owner>/<name>.git/…` is Git and Git LFS. Push with the admin token as the
  HTTP Basic password (any user name), e.g.
  `https://git:<token>@forge.example/acme/site.git` or via a credential helper.
- `GET|HEAD /<owner>/<name>/media/<oid>[/<filename>]` serves an LFS object by
  its SHA-256 oid, immutable and with Range support.
- `GET|HEAD /<owner>/<name>/raw/<ref>/<path>` serves a file from a branch, tag,
  `HEAD` or full commit id; LFS pointers redirect to the media URL. Details in
  `docs/design.md` §7.

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

A Workers **Paid** plan is required: the Free plan allows 10 ms of CPU per
request, which is not enough to index even a small push (see the measurements
below), and `limits.cpu_ms` cannot be set on it.

```sh
pnpm install
cd apps/forge-worker
npx wrangler login
npx wrangler r2 bucket create git-forge
npx wrangler d1 create git-forge
npx wrangler queues create git-forge-imports
```

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

### Large pushes

The Worker rejects pushes above `MAX_PUSH_BYTES` (and Cloudflare rejects
request bodies above 100 MB on Free/Pro, 200 MB on Business). Two ways
around it:

- `git forge push` from `packages/cli` splits the push into several pushes
  below a budget: `git forge push --max-bytes 16MiB <url> main`.
- Import the repository from where it already lives:

  ```sh
  curl -X POST https://git-forge.<account>.workers.dev/api/admin/repos/acme/site/import \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -d '{"url":"https://github.com/acme/site.git","token":"'"$GITHUB_TOKEN"'"}'
  curl -H "Authorization: Bearer $ADMIN_TOKEN" \
    https://git-forge.<account>.workers.dev/api/admin/repos/acme/site/import
  ```

  Each import step runs as one queue message with its own CPU budget
  (`limits.cpu_ms`); steps fetch about `commitsPerStep` commits and at most
  32 MiB of pack. The step design is described in `docs/design.md` (§7,
  Import).

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
  and checks that the previous tip is kept under `refs/archive/`, imports the
  generated repository from a local `git http-backend` server (with a token,
  stepped through the local queue), pushes 24 MiB with `git forge push`
  against the 16 MiB limit, and fires the Cron Trigger through
  `/__scheduled`. A second suite starts a private instance
  (`PUBLIC_READ=false` with a `READ_TOKEN`), uploads a JPEG with the real
  `git lfs push` and reads it back through the media and raw URLs (headers,
  Range, HEAD, `304`, redirect). Together they take about 40 seconds and are
  part of the root `pnpm test`.
- `pnpm --filter forge-worker bench` measures CPU time and memory per
  operation (below).

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
- **D1** is unused for now and stays within its free allowance.
