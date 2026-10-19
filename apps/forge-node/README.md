# forge-node

git-forge without Cloudflare: one process that serves the same router as the
Worker (`createForge` from `apps/forge-worker/src/app.ts`) over `node:http`,
with an SQLite file or libSQL (Bunny Database, Turso) for accounts, a local directory or any S3 bucket for
repository data, a job runner whose queue lives in the SQLite file, SMTP for
email and a cron schedule for the mirror safety net. Made for a backup mirror on a Raspberry Pi, but it is a full
instance: push, clone, LFS, federation, imports and the JSON API all work as
on the Worker.

It runs on Node 22 (`node --experimental-transform-types src/main.ts`) and as
a single executable built with `bun build --compile`
(`git-forge-node-linux-arm64` and `git-forge-node-linux-x64` in every
release, checksums in `NODE-SHA256SUMS`).

## Commands

| Command | Does |
|---|---|
| `git-forge-node serve` (default) | HTTP server, job runner and mirror schedule. Refuses to start while the database has pending migrations. Stops on `SIGTERM`/`SIGINT`: closes the listener, lets running jobs finish (up to 10 s) and closes the database; queued jobs stay in the database for the next start. |
| `git-forge-node migrate` | Applies pending migrations to the database and exits. These are the SQL files from `packages/accounts/migrations` that `wrangler d1 migrations apply` uses for the Worker, bundled into the executable. Migrations are never applied implicitly. |
| `git-forge-node instance-key` | Prints a new Ed25519 private JWK for `INSTANCE_KEY` (key id on stderr). |
| `git-forge-node restore [id]` | Restores the latest (or the given) complete backup from `BACKUP_STORAGE` into an empty `DATABASE_PATH` and `STORAGE`, verifying every object, then applies newer migrations. |
| `git-forge-node restore-sql [id]` | Prints the database dump of a backup as SQL, e.g. for `wrangler d1 execute --file`. |
| `git-forge-node backup-verify [n]` | Re-hashes `n` (default 20) random backed-up objects in `BACKUP_STORAGE`; exit code 1 on a mismatch. |
| `git-forge-node version` | Prints the version. |

Logs are JSON lines on stdout (`listening`, `job`, `import-step`,
`scheduled`, `error`, `stopping`, `stopped`), like the Worker's.

## Configuration

Environment variables. The names shared with the Worker mean the same
(`apps/forge-worker/README.md`): `PUBLIC_URL`, `INSTANCE_KEY`,
`BOOTSTRAP_TOKEN`, `MAX_PUSH_BYTES`, `MAX_LFS_OBJECT_BYTES`,
`MIRROR_INTERVAL_MINUTES`, `MIRROR_DEEP_CHECK_DAYS`, `MIRROR_UNIT_BYTES`,
`ALLOW_INSECURE_FEDERATION`, `ALLOW_PRIVATE_REMOTES`, `ACTIONS`, `ACTIONS_SECRETS`,
`ACTIONS_SECRETS_KEY`, `ACTIONS_REPOSITORIES`, `ACTIONS_GITHUB_FALLBACK`,
`ACTIONS_INSTANCE_ID`, `ACTIONS_OIDC_KEY` (create one with
`git-forge-node oidc-key`), `ACTIONS_ID_TOKENS`,
`ACTIONS_ARTIFACT_RETENTION_DAYS`, `ACTIONS_CACHE_LIMIT_BYTES`,
`ACTIONS_CACHE_UNUSED_DAYS`, `ACTIONS_CACHE_MAX_DAYS`, and the login settings `OIDC_ISSUER`,
`OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_NAME`, `OIDC_SCOPES`,
`SELF_SIGNUP`, `PASSKEYS`, `MEMBERSHIP_SOURCE`, `OIDC_GROUPS_CLAIM`, `BREAK_GLASS_PUBLIC_KEY`, and the Pages settings
`PAGES_HOST`, `PAGES_DOMAINS`, `PAGES_MAX_AGE` (point the Pages hosts at the
same process; behind a proxy keep the `Host` header). Email: `EMAIL_PROVIDER`
(`none`, `console`, `ses`, `smtp`), `EMAIL_FROM`, `SES_*`. Push notifications need `PUBLIC_URL` and
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
| `DATABASE` | `sqlite` | `sqlite` (a file) or `libsql` (Bunny Database, Turso, `sqld`; `@git-forge/libsql`). |
| `DATABASE_PATH` | `$DATA_DIR/git-forge.sqlite` | SQLite file (WAL mode) for `DATABASE=sqlite`. |
| `LIBSQL_URL`, `LIBSQL_AUTH_TOKEN` | none | Database URL (`libsql://…`, `https://…`) and token for `DATABASE=libsql`. |
| `STORAGE` | `fs` | `fs` (local directory, `FsStorage`) or `s3` (`S3Storage`). |
| `STORAGE_DIR` | `$DATA_DIR/objects` | Directory for `STORAGE=fs`. |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | region `us-east-1` | Bucket for `STORAGE=s3`. |
| `S3_PREFIX` | none | Key prefix inside the bucket, e.g. `git-forge/`. |
| `S3_FORCE_PATH_STYLE` | `false` | `true` for `https://host/bucket/key` URLs (most self-hosted S3 servers). |
| `CONDITIONAL_WRITES` | `storage` | `database` for buckets without conditional `PutObject`: `If-Match`/`If-None-Match` writes (refs, mirror state) are serialized by a per-key lease in the database (`lockedStorage`, `packages/accounts/README.md`) instead. Every process writing the bucket must use the same database. |
| `SCHEDULE` | `17 3 * * *` | Cron expression (five fields, UTC; `@hourly`, `@daily` also work) for the safety-net run: enqueues a sync for every auto mirror whose last run is older than `MIRROR_INTERVAL_MINUTES`, plus the periodic deep checks. Same as the Worker's Cron Trigger. |
| `JOB_CONCURRENCY` | `2` | Background jobs (mirror syncs, notifications, deep checks, Pages deployments, LFS publish) running at once. Imports run one step at a time. |
| `LFS_PUBLISH_DIR` | none | Directory that receives the LFS objects of public repositories on push, one file per oid (`LFS_PUBLISH_PREFIX` prepends a path), for a web server or CDN to serve. The Worker's `CDN_BUCKET` counterpart. |
| `BACKUP_STORAGE` | none | `fs` or `s3`: target of the daily [backup](#backup). `BACKUP_STORAGE_DIR` and `BACKUP_S3_*` like `STORAGE_DIR` and `S3_*`. |
| `SMTP_HOST` | none | SMTP server, required with `EMAIL_PROVIDER=smtp`. |
| `SMTP_SECURITY` | `starttls` | `starttls` (STARTTLS required), `tls` (implicit TLS, "SMTPS") or `none` (plain, only for a relay on the same host or network, without credentials). |
| `SMTP_PORT` | `587`, `465` or `25` | Port; the default follows `SMTP_SECURITY`. |
| `SMTP_USERNAME`, `SMTP_PASSWORD` | none | Credentials for `AUTH PLAIN` or `AUTH LOGIN` (whichever the server offers, PLAIN first). Both or neither; not with `SMTP_SECURITY=none`. |
| `SMTP_HELO` | host name | Name sent with `EHLO`. |

Invalid values stop the process with exit code 2 and a message instead of
falling back to a default.

## Backup

With `BACKUP_STORAGE` every `SCHEDULE` run backs up the database and every
object into that target (design §19); status, "run now" and verify are on
`/-/admin` and under `/api/admin/backup`. Use a bucket with Object Lock
(compliance mode) as the target; the backup never overwrites a key. Restore
on a new machine:

```sh
BACKUP_STORAGE=s3 BACKUP_S3_ENDPOINT=… BACKUP_S3_BUCKET=forge-backup … DATA_DIR=/data git-forge-node restore
```

## Jobs and restarts

Jobs run in the process, with the same handler, retry policy (exponential
backoff from 10 s, at most 8 attempts, `PermanentJobError` stops at once)
and job format as the Worker's Queue consumer. Jobs live in the `jobs` table
of the database and survive restarts; a job interrupted by a crash runs
again once its 60 s lease has expired.

## Email

`EMAIL_PROVIDER=smtp` with `EMAIL_FROM` and `SMTP_*` sends notification
digests over SMTP; `5xx` replies are permanent, everything else is retried.

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
   through presigned URLs, as do `git-remote-forge` pack parts. Refs are updated by compare-and-swap:
   the bucket must honour `If-None-Match: *` and `If-Match` on `PutObject`,
   or the instance runs with `CONDITIONAL_WRITES=database`. Run
   the conformance suite against it once (`packages/s3/README.md`) before
   relying on a provider. Expire `tmp/` with a lifecycle rule (a day or more).

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

## Bunny Magic Containers

A long-running container with Bunny Storage (S3 API) and Bunny Database
(libSQL). **Untested:** no Bunny account was available when this was written;
every step below is from Bunny's documentation and the local tests (sqld,
versitygw, a storage that ignores conditions), and needs the verification at
the end.

1. **Storage zone** with S3 enabled (only possible when creating the zone;
   S3 is in public preview). Pick an EU region (`de`, `se`, `uk`). Access key
   = zone name, secret = zone password. Bunny documents no conditional
   `PutObject`, no Object Lock and 500 requests/s per zone.
2. **Database** (Edge Platform → Database): URL `libsql://<id>.lite.bunnydb.net`
   and a Full Access token. Apply the migrations once from any machine:

   ```sh
   DATABASE=libsql LIBSQL_URL=libsql://<id>.lite.bunnydb.net LIBSQL_AUTH_TOKEN=… \
     docker run --rm -e DATABASE -e LIBSQL_URL -e LIBSQL_AUTH_TOKEN ghcr.io/levino/git-forge-node:<version> migrate
   ```

3. **Magic Containers app** from `ghcr.io/levino/git-forge-node:<version>`,
   port 8080, one region, min and max replicas 1 (the schedule and the job
   pollers run in the process; more replicas share the database safely but are
   untested). Environment:

   ```sh
   PUBLIC_URL=https://git.example.org
   INSTANCE_KEY='{"kty":"OKP",…}'       # git-forge-node instance-key
   BOOTSTRAP_TOKEN=<long random>
   TRUST_PROXY=true                      # if Bunny's edge sets X-Forwarded-Proto/-Host
   DATABASE=libsql
   LIBSQL_URL=libsql://<id>.lite.bunnydb.net
   LIBSQL_AUTH_TOKEN=<full access token>
   STORAGE=s3
   S3_ENDPOINT=https://de-s3.storage.bunnycdn.com
   S3_REGION=de
   S3_BUCKET=<zone name>
   S3_ACCESS_KEY_ID=<zone name>
   S3_SECRET_ACCESS_KEY=<zone password>
   S3_FORCE_PATH_STYLE=true
   CONDITIONAL_WRITES=database           # unless the conformance run shows native conditional writes
   ```

   No volume is needed: the container is stateless. (Alternative: SQLite on a
   persistent volume with `DATABASE_PATH`, which Bunny binds to one pod.)
   `BACKUP_STORAGE` must point elsewhere for write-once backups (no Object
   Lock on Bunny).
4. **Custom domain** on the app's endpoint (DNS CNAME to it), TLS by Bunny;
   `PUBLIC_URL` must be that URL. Check that the endpoint does not limit
   request bodies or time out long pushes.
5. **Bootstrap and federation** with another instance: the `curl` calls of
   step 5 above, with this instance in place of the Pi.

The cron schedule (`SCHEDULE`, plus the five-minute CI tick) is a timer in
the `serve` process, so it fires as long as the container runs; that is why
the minimum replica count must not be 0.

**Verification once an account exists:**

```sh
export S3_TEST_ENDPOINT=https://de-s3.storage.bunnycdn.com S3_TEST_REGION=de \
  S3_TEST_BUCKET=<zone> S3_TEST_ACCESS_KEY_ID=<zone> S3_TEST_SECRET_ACCESS_KEY=<password>
pnpm --filter @git-forge/s3 test:s3
pnpm --filter @git-forge/accounts-node exec vitest run test/locked-storage.test.ts
```

- `test:s3`: storage conformance via `S3Storage` (ranges, atomic puts,
  listing order across pages, conditional writes), presigned PUT with wrong
  length, forged same-length content, missing or replaced checksum header and
  expiry, and a 3 MiB `git-lfs` push through presigned URLs. If only the
  conditional-write tests fail, use `CONDITIONAL_WRITES=database`; the second
  command must then pass (conformance through `lockedStorage` on the zone). If
  the length or checksum tests fail, presigned LFS uploads are not safe on
  Bunny.
- `git-forge-node migrate` and `serve` against Bunny Database (the libSQL
  adapter is tested only against `sqld`).
- A large push (a 1 GB repository, a 500 MB LFS object) through the custom
  domain, then clone and `git fsck`.
- Federation with forge.levinkeller.de in both directions: mirror, push
  notification, scheduled run in the logs (`"event":"scheduled"`), and a
  container restart that keeps queued jobs.

## Container image

Every release publishes `ghcr.io/levino/git-forge-node` (`linux/amd64`,
`linux/arm64`):

```sh
docker run --rm -v git-forge:/data ghcr.io/levino/git-forge-node:0.8.0 migrate
docker run -d -p 8080:8080 -v git-forge:/data --env-file git-forge.env ghcr.io/levino/git-forge-node:0.8.0
docker build -f apps/forge-node/Dockerfile -t git-forge-node .
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
the SQLite job queue, the migrate/serve contract and the storage conformance
suite on
the `fs` storage as configured here. The E2E suite (`test/e2e`) starts a Worker under
`wrangler dev` and this app as a separate process, then: pushes and clones
with Git LFS (protocol v2 and dumb HTTP) on the Node instance; mirrors a
Worker repository on the Node instance including LFS objects; follows a push
to the Worker by notification without a scheduled run; lets the Worker mirror
the Node instance and get notified on push; restarts the Node instance and
checks that its data is still served. `GIT_FORGE_NODE_BINARY=<path>` runs the
same suite against a compiled executable instead of Node (the `node-binary`
CI job does that).
