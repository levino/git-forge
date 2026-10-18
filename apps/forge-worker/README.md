# forge-worker

The Cloudflare Worker deployment of git-forge. It serves Git over HTTPS
(smart HTTP protocol v2 for fetch, `receive-pack` for push, dumb HTTP for
protocol v0 clients) straight from an R2 bucket, using `handleGitRequest` from
`@git-forge/core` and `R2Storage` from `@git-forge/cloudflare`.

## What is deployed

| Piece | Purpose |
|---|---|
| `BUCKET` (R2) | All repository data, in the bucket layout described in `docs/design.md` (`repos/<owner>/<name>/…`). |
| `DB` (D1) | CI state (`actions_*` tables, migrated on first use); later accounts. |
| `RUNNER` (Durable Object + Container) | `RunnerContainer`: one container per CI job running the official `actions/runner` with a JIT config (`runner/Dockerfile`). |
| Cron Trigger `*/30 * * * *` | Stub for mirror sync; currently only logs. |
| `ADMIN_TOKEN` (secret) | Protects `POST /api/admin/repos` and, until accounts exist, every push. |
| `PUBLIC_READ` (var) | `true` (default): anyone may clone. `false`: clones need the admin token too. |
| `MAX_PUSH_BYTES` (var) | Largest accepted push request, default 16 MiB. Larger files belong in Git LFS. |
| `ACTIONS` (var) | `true` (default): CI is on — workflows run on push, `/_services/actions` and `/api/v3` are served. |
| `ACTIONS_SECRETS` (secret) | JSON object of instance secrets for workflows, e.g. `{"CLOUDFLARE_API_TOKEN":"…"}`. |
| `PUBLIC_URL`, `INSTANCE_ID` (vars, optional) | Public base URL handed to runners (default: the request origin) and a stable GUID for the Actions location service. |

### Routes

- `POST /api/admin/repos` with `Authorization: Bearer <ADMIN_TOKEN>` and a JSON
  body `{"owner": "acme", "name": "site", "defaultBranch": "main"}` creates a
  repository. Answers `201` with the clone URL, `409` if it exists, `400` for
  invalid names, `401` for a wrong token and `503` if no token is configured.
- `GET /api/health` answers `{"ok": true}`.
- `/_services/actions/…` is the Actions service for `actions/runner`, and
  `/api/v3/repos/<owner>/<name>/actions/…` the GHES-style runner, run and job
  API (admin token). See [`@git-forge/actions`](../../packages/actions).
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

### CI runners on Cloudflare Containers

`wrangler deploy` builds `runner/Dockerfile` (official
`ghcr.io/actions/actions-runner` image plus Git and Node.js) and pushes it to
the Cloudflare registry, so Docker must be available where you deploy.
Containers need the Workers Paid plan. Each queued job starts one
`RunnerContainer` instance (`max_instances` in `wrangler.jsonc`), whose
entrypoint runs `run.sh --jitconfig "$ACTIONS_RUNNER_JITCONFIG"`; the runner
is ephemeral and the container stops after the job. Pin `RUNNER_VERSION` in
the Dockerfile to the runner release you have tested. This path has not been
deployed yet. `wrangler dev` runs with `dev.enable_containers: false`;
locally, start a runner by hand (see the actions package README).

```sh
echo '{"CLOUDFLARE_API_TOKEN":"…"}' | npx wrangler secret put ACTIONS_SECRETS
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
  and checks that the previous tip is kept under `refs/archive/`, fires the
  Cron Trigger through `/__scheduled`, and pushes a workflow to check that a
  run is queued in D1 and handed to a JIT runner over the Actions protocol. It takes about 8 seconds and is part of
  the root `pnpm test`.
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
