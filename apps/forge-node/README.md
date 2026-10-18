# forge-node

git-forge without Cloudflare: one process that serves the same router as the
Worker (`createForge` from `apps/forge-worker/src/app.ts`) over `node:http`,
with an SQLite file for accounts, a local directory or any S3 bucket for
repository data, an in-process job runner and a cron schedule for the mirror
safety net. Made for a backup mirror on a Raspberry Pi, but it is a full
instance: push, clone, LFS, federation, imports and the JSON API all work as
on the Worker.

It runs on Node 22 (`node --experimental-transform-types src/main.ts`) and as
a single executable built with `bun build --compile`
(`git-forge-node-linux-arm64` and `git-forge-node-linux-x64` in every
release, checksums in `NODE-SHA256SUMS`).

## Commands

| Command | Does |
|---|---|
| `git-forge-node serve` (default) | HTTP server, job runner and mirror schedule. Refuses to start while the database has pending migrations. Stops on `SIGTERM`/`SIGINT`: closes the listener, lets running jobs finish (up to 10 s) and closes the database. |
| `git-forge-node migrate` | Applies pending migrations to the database and exits. These are the SQL files from `packages/accounts/migrations` that `wrangler d1 migrations apply` uses for the Worker, bundled into the executable. Migrations are never applied implicitly. |
| `git-forge-node instance-key` | Prints a new Ed25519 private JWK for `INSTANCE_KEY` (key id on stderr). |
| `git-forge-node version` | Prints the version. |

Logs are JSON lines on stdout (`listening`, `job`, `import-step`,
`scheduled`, `error`, `stopping`, `stopped`), like the Worker's.

## Configuration

Environment variables. The names shared with the Worker mean the same
(`apps/forge-worker/README.md`): `PUBLIC_URL`, `INSTANCE_KEY`,
`BOOTSTRAP_TOKEN`, `MAX_PUSH_BYTES`, `MAX_LFS_OBJECT_BYTES`,
`MIRROR_INTERVAL_MINUTES`, `MIRROR_DEEP_CHECK_DAYS`, `MIRROR_UNIT_BYTES`,
`ALLOW_INSECURE_FEDERATION`, `ACTIONS`, `ACTIONS_SECRETS`,
`ACTIONS_SECRETS_KEY`, `ACTIONS_REPOSITORIES`, `ACTIONS_GITHUB_FALLBACK`,
`ACTIONS_INSTANCE_ID`, and the login settings `OIDC_ISSUER`,
`OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_NAME`, `OIDC_SCOPES`,
`SELF_SIGNUP`, `BREAK_GLASS_PUBLIC_KEY`. Push notifications need `PUBLIC_URL` and
`INSTANCE_KEY`; without them mirrors sync only on the schedule. With
`ACTIONS=true` CI is served, but there is no runner launcher: jobs wait for a
runner registered by hand. Every five minutes the instance runs scheduled
workflows and the CI reaper (timeouts, dead runners).

Only for this app:

| Name | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Listening port. |
| `HOST` | `0.0.0.0` | Listening address. Use `127.0.0.1` behind a reverse proxy on the same host. |
| `TRUST_PROXY` | `false` | `true` takes the request origin from `X-Forwarded-Proto` and `X-Forwarded-Host` and the client address for login rate limits from the last `X-Forwarded-For` hop (otherwise the socket address). Only behind a proxy that sets them. |
| `DATA_DIR` | `./data` | Base directory for the defaults below. |
| `DATABASE_PATH` | `$DATA_DIR/git-forge.sqlite` | SQLite file (WAL mode). |
| `STORAGE` | `fs` | `fs` (local directory, `FsStorage`) or `s3` (`S3Storage`). |
| `STORAGE_DIR` | `$DATA_DIR/objects` | Directory for `STORAGE=fs`. |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | region `us-east-1` | Bucket for `STORAGE=s3`. |
| `S3_PREFIX` | none | Key prefix inside the bucket, e.g. `git-forge/`. |
| `S3_FORCE_PATH_STYLE` | `false` | `true` for `https://host/bucket/key` URLs (most self-hosted S3 servers). |
| `SCHEDULE` | `17 3 * * *` | Cron expression (five fields, UTC; `@hourly`, `@daily` also work) for the safety-net run: enqueues a sync for every auto mirror whose last run is older than `MIRROR_INTERVAL_MINUTES`, plus the periodic deep checks. Same as the Worker's Cron Trigger. |
| `JOB_CONCURRENCY` | `2` | Background jobs (mirror syncs, notifications, deep checks) running at once. Imports run one step at a time. |

Invalid values stop the process with exit code 2 and a message instead of
falling back to a default.

## Jobs and restarts

Jobs run in the process, with the same handler, retry policy (exponential
backoff from 10 s, at most 8 attempts, `PermanentJobError` stops at once)
and job format as the Worker's Queue consumer. They live in memory: a job
that was queued or waiting for a retry when the process stopped is gone. For
mirrors this is safe: the upstream retries an undelivered notification with
backoff (eight attempts within about 20 minutes), a repeated notification of
an unchanged state is a no-op, and the next scheduled run catches up on
anything missed, including pushes made while the Pi was offline for longer. An import
interrupted by a restart is taken over by starting it again with the same URL
(`POST /api/repos/{owner}/{name}/import`) once it has made no progress for 30
minutes; it continues from its last completed step.

## A backup mirror on a Raspberry Pi

A Raspberry Pi 4 or 5 with a 64-bit OS (`aarch64`) and an SSD is enough.
The Pi only has to be reachable from the upstream instance for push
notifications; without that it still catches up on the schedule.

1. Install the executable and check it against the release checksums:

   ```sh
   v=0.4.0
   curl -fLO "https://github.com/levino/git-forge/releases/download/v$v/git-forge-node-linux-arm64"
   curl -fLO "https://github.com/levino/git-forge/releases/download/v$v/NODE-SHA256SUMS"
   sha256sum --check --ignore-missing NODE-SHA256SUMS
   sudo install -m 0755 git-forge-node-linux-arm64 /usr/local/bin/git-forge-node
   ```

2. Create a user and the configuration from
   [deploy/git-forge.env.example](deploy/git-forge.env.example):

   ```sh
   sudo useradd --system --home-dir /var/lib/git-forge --shell /usr/sbin/nologin git-forge
   sudo install -d -m 0750 -o root -g git-forge /etc/git-forge
   sudo install -m 0640 -o root -g git-forge deploy/git-forge.env.example /etc/git-forge/git-forge.env
   git-forge-node instance-key   # paste the JSON into INSTANCE_KEY
   ```

   Set `PUBLIC_URL` to the URL under which the upstream reaches the Pi, and a
   long random `BOOTSTRAP_TOKEN`. systemd interprets quotes in
   environment files, so keep `INSTANCE_KEY` in single quotes as in the
   example (a `docker --env-file` takes values literally: no quotes there).

3. Choose the storage.

   - **Local disk:** `STORAGE=fs` and `DATA_DIR` (or `STORAGE_DIR`) on the
     SSD. Every key is a plain file, so the directory is itself a readable
     backup: `git clone` works against it with any static web server, without
     this software (`packages/node/README.md`).
   - **Hetzner Object Storage:** `STORAGE=s3`,
     `S3_ENDPOINT=https://fsn1.your-objectstorage.com`, `S3_REGION=fsn1`,
     `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`.
   - **Backblaze B2:** `STORAGE=s3`,
     `S3_ENDPOINT=https://s3.eu-central-003.backblazeb2.com`,
     `S3_REGION=eu-central-003`, and an application key for the bucket.

   With S3 the Pi only holds the SQLite file; repository data and LFS objects
   live in the bucket, and LFS clients upload and download directly from it
   through presigned URLs. The bucket must honour `If-None-Match: *` and
   `If-Match` on `PutObject`, since refs are updated by compare-and-swap. Run
   the conformance suite against it once (`packages/s3/README.md`) before
   relying on a provider.

4. Install the units [deploy/git-forge-node.service](deploy/git-forge-node.service)
   and [deploy/git-forge-node-migrate.service](deploy/git-forge-node-migrate.service)
   (a oneshot that runs `migrate` with the same user and environment), apply
   the migrations and start:

   ```sh
   sudo install -m 0644 deploy/git-forge-node.service deploy/git-forge-node-migrate.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl start git-forge-node-migrate
   sudo systemctl enable --now git-forge-node
   journalctl -u git-forge-node -f
   ```

   If the data lives outside `/var/lib/git-forge`, add that path to
   `ReadWritePaths=` in both units.

5. Create the admin and connect the instances (the upstream is a Worker or
   another `git-forge-node`):

   ```sh
   curl -X POST https://backup.example.org/api/bootstrap \
     -H "Authorization: Bearer $BOOTSTRAP_TOKEN" -d '{"login":"admin"}'
   # on the upstream: trust the Pi and let it read the repository
   curl -X POST https://forge.example.org/api/admin/instances -H "Authorization: Bearer $UPSTREAM_TOKEN" \
     -d '{"issuer":"https://backup.example.org"}'
   curl -X POST https://forge.example.org/api/repos/acme/site/instances -H "Authorization: Bearer $UPSTREAM_TOKEN" \
     -d '{"issuer":"https://backup.example.org"}'
   # on the Pi: trust the upstream's notifications, create the repository and the mirror
   curl -X POST https://backup.example.org/api/admin/instances -H "Authorization: Bearer $PI_TOKEN" \
     -d '{"issuer":"https://forge.example.org"}'
   curl -X POST https://backup.example.org/api/repos -H "Authorization: Bearer $PI_TOKEN" \
     -d '{"owner":"admin","name":"site"}'
   curl -X POST https://backup.example.org/api/repos/admin/site/mirrors -H "Authorization: Bearer $PI_TOKEN" \
     -d '{"url":"https://forge.example.org/acme/site.git","auth":"instance"}'
   ```

   The mirror syncs once right away and subscribes to the upstream's push
   notifications; from then on every push upstream reaches the Pi within
   seconds, and the daily schedule is the safety net.

Put a TLS-terminating reverse proxy (Caddy, nginx) in front when the Pi is
reachable from the internet, with `HOST=127.0.0.1` and `TRUST_PROXY=true`.
Disable request body limits and timeouts in the proxy for Git paths; pushes
are limited by `MAX_PUSH_BYTES` and `MAX_LFS_OBJECT_BYTES`.

**Upgrades:** stop the service, replace the executable, `systemctl start
git-forge-node-migrate`, start the service.

**Backups of the Pi itself:** the SQLite file holds accounts,
tokens and trust; copy it with `sqlite3 git-forge.sqlite ".backup …"` while
running. Repository data in the bucket or directory is append-only.

## Container image

```sh
docker build -f apps/forge-node/Dockerfile -t git-forge-node .
docker run --rm -v git-forge:/data git-forge-node migrate
docker run -d -p 8080:8080 -v git-forge:/data --env-file git-forge.env git-forge-node
```

Multi-stage: Node and pnpm install the workspace, Bun compiles the executable
for the target architecture (`docker buildx build --platform
linux/arm64,linux/amd64` cross-compiles without emulation), and the result
runs as a non-root user on `gcr.io/distroless/cc-debian12` with `/data` as
volume.

## Development

```sh
pnpm --filter forge-node start              # serve from source with Node
pnpm --filter forge-node build              # dist/git-forge-node-linux-{x64,arm64}
pnpm --filter forge-node test               # unit tests and the E2E suite
```

The unit tests cover configuration parsing, cron expressions, the scheduler,
the migrate/serve contract and the storage conformance suite on the `fs`
storage as configured here. The E2E suite (`test/e2e`) starts a Worker under
`wrangler dev` and this app as a separate process, then: pushes and clones
with Git LFS (protocol v2 and dumb HTTP) on the Node instance; mirrors a
Worker repository on the Node instance including LFS objects; follows a push
to the Worker by notification without a scheduled run; lets the Worker mirror
the Node instance and get notified on push; restarts the Node instance and
checks that its data is still served. `GIT_FORGE_NODE_BINARY=<path>` runs the
same suite against a compiled executable instead of Node (the `node-binary`
CI job does that).
