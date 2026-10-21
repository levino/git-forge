# forge-bunny

git-forge on bunny.net without servers: one Edge Script serves the UI, the
API, Git and LFS; Bunny Database (libSQL) holds the metadata, Bunny Storage
(S3 API) the repositories. A tiny container on Magic Containers runs the job
queues and the schedules. Idle cost: storage, the database's storage and the
container, which idles at about 30 MB and 0.002 CPU (one 64 MB RAM block and
CPU seconds, about $0.25 a month, October 2026).

## Deploy

You need a bunny.net account, its API key (`BUNNY_API_KEY`, account
settings) and a release `V` of git-forge (`git-forge-bunny.js` and the
`ghcr.io/levino/git-forge-node:<V>` image).

1. **Storage.** Create a storage zone (Storage, Add Storage Zone, region
   Germany or another S3-enabled one) and enable S3 access. Note the zone
   name (`S3_BUCKET` and `S3_ACCESS_KEY_ID`), the password
   (`S3_SECRET_ACCESS_KEY`) and the endpoint (`S3_ENDPOINT`, e.g.
   `https://de-s3.storage.bunnycdn.com`, `S3_REGION=de`).
2. **Database.** Create a database (Database, Add Database) and an access
   token with read and write. `LIBSQL_URL` is its `libsql://…` URL,
   `LIBSQL_AUTH_TOKEN` the token. Apply the migrations (again after every
   update):

   ```sh
   docker run --rm -e DATABASE=libsql -e LIBSQL_URL -e LIBSQL_AUTH_TOKEN ghcr.io/levino/git-forge-node:$V migrate
   ```

3. **Keys.** `docker run --rm ghcr.io/levino/git-forge-node:$V instance-key`
   prints `INSTANCE_KEY`; pick a long random `BOOTSTRAP_TOKEN`.
4. **Edge Script.** Create a standalone script with a linked pull zone:

   ```sh
   curl -X POST -H "AccessKey: $BUNNY_API_KEY" -H 'content-type: application/json' \
     -d '{"Name":"git-forge","ScriptType":1,"CreateLinkedPullZone":true}' https://api.bunny.net/compute/script
   ```

   In the script's settings add the variables `PUBLIC_URL` (the pull zone's
   `https://…b-cdn.net` or `.bunny.run` hostname, or your own domain),
   `LIBSQL_URL`, `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`,
   `S3_FORCE_PATH_STYLE=true` and optionally `S3_PREFIX`, `SCHEDULE`,
   `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_NAME`; and the secrets
   `INSTANCE_KEY`, `BOOTSTRAP_TOKEN`, `LIBSQL_AUTH_TOKEN`,
   `S3_SECRET_ACCESS_KEY` (variables hold at most 256 characters). Upload the
   code and publish it:

   ```sh
   curl -fsSLO https://github.com/levino/git-forge/releases/download/v$V/git-forge-bunny.js -fsSLO https://github.com/levino/git-forge/releases/download/v$V/BUNNY-SHA256SUMS
   sha256sum -c BUNNY-SHA256SUMS
   jq -Rs '{Code: .}' git-forge-bunny.js | curl -fsS -X POST -H "AccessKey: $BUNNY_API_KEY" -H 'content-type: application/json' --data-binary @- https://api.bunny.net/compute/script/$BUNNY_SCRIPT_ID/code
   curl -fsS -X POST -H "AccessKey: $BUNNY_API_KEY" -H 'content-type: application/json' -d '{}' https://api.bunny.net/compute/script/$BUNNY_SCRIPT_ID/publish
   ```

5. **Pull zone.** Under Caching set "Cache expiration time" to "Respect
   origin Cache-Control" (the script's page and object caches need it; every
   dynamic response carries `Cache-Control`, signed-in ones `private`).
6. **Jobs.** Create a Magic Containers app (shared runtime, one instance,
   one region near the database, no endpoint) with the image
   `ghcr.io/levino/git-forge-node:$V`, the command `jobs` and the same
   variables and secrets as the script plus `DATABASE=libsql`,
   `STORAGE=s3`, `CONDITIONAL_WRITES=database`. It runs mirror syncs, imports,
   LFS copies, notifications, webhooks and the schedules, and writes a
   heartbeat the admin page shows ("Jobs runner last seen").
7. **First admin.**

   ```sh
   curl -X POST -H "Authorization: Bearer $BOOTSTRAP_TOKEN" -H 'content-type: application/json' \
     -d '{"login":"you"}' https://<host>/api/bootstrap
   ```

   With OIDC, add `https://<host>/login/oidc/callback` as a redirect URI of
   the client.

Update: migrate, deploy the new `git-forge-bunny.js`, set the container's
image tag.

## How it runs

- Edge Scripts have no cron and no queue. Requests only enqueue jobs into
  the `jobs` table; `git-forge-node jobs` polls it (one indexed query,
  backing off from 2 s to `JOB_POLL_SECONDS`, default 30) and claims due
  schedules once a minute (`cron:*` rows, conditional `UPDATE`, so two
  runners never fire one schedule twice and a missed run is caught up once).
  Without a heartbeat for 10 minutes (no container, or it is down) the
  script itself drains due jobs and schedules in `Bunny.v1.waitUntil` of the
  next requests, as an alternative an external cron (cron-job.org) can open
  any page every few minutes.
- A response must start within 60 s (`OriginResponseTimeout`); pushes answer
  at once and send side-band keepalives until the report.
- Database round trips are HTTP requests: reads of one request are batched
  into one Hrana pipeline and repeated lookups answered once
  (`docs/design.md` §11). Conditional writes go through the database
  (`CONDITIONAL_WRITES=database`, Bunny Storage has none).
- Page and object caches use the Cache API with named caches and keys under
  the instance's own host (`/_cache/<secret>/…`), so the CDN never serves
  them; `caches.default` is not used.
- `EDGE_STATS=<key>` records subrequests per request in `edge_stats`,
  readable at `GET /_edge/stats?since=<id>` with `Authorization: Bearer <key>`.

## Build from source

```sh
pnpm --filter forge-bunny build    # astro build with wrangler.jsonc (entry src/entry.ts), esbuild -> dist/edge.js
```

The Astro Cloudflare adapter is used for the UI; `src/astro-adapter-runtime.ts`
stands in for its `cloudflare:workers` import.
