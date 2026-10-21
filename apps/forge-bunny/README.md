# forge-bunny

git-forge as one Bunny Edge Script (standalone, Deno runtime) with Bunny
Database (libSQL over Hrana HTTP) and Bunny Storage (S3 API). Nothing runs
while nobody calls it. Prototype: verified on a real account (push, clone,
fetch, LFS, import, UI pages, API), not yet a supported deployment.

## Build and deploy

```sh
pnpm --filter forge-bunny build     # astro build of forge-worker with src/host.ts, then esbuild -> dist/edge.js (~3.8 MB)
BUNNY_API_KEY=… BUNNY_SCRIPT_ID=… pnpm --filter forge-bunny deploy
```

The build reuses the Worker's Astro app with the Cloudflare adapter and swaps
`forge-worker/src/cloudflare.ts` for `src/host.ts`; the second step resolves
`cloudflare:workers` to `src/cloudflare-workers.ts` (environment from
`Deno.env`). Create the script once with `POST /compute/script`
`{"Name":…,"ScriptType":1,"CreateLinkedPullZone":true}` and apply the
migrations with `DATABASE=libsql git-forge-node migrate`.

## Configuration

Script variables and secrets, named as for forge-node: `PUBLIC_URL`,
`INSTANCE_KEY`, `BOOTSTRAP_TOKEN`, `LIBSQL_URL`, `LIBSQL_AUTH_TOKEN`,
`S3_ENDPOINT` (`https://de-s3.storage.bunnycdn.com`), `S3_REGION`, `S3_BUCKET`
and `S3_ACCESS_KEY_ID` (zone name), `S3_SECRET_ACCESS_KEY` (zone password),
`S3_FORCE_PATH_STYLE=true`, `S3_PREFIX`, `SCHEDULE`. `DATABASE=libsql`,
`STORAGE=s3` and `CONDITIONAL_WRITES=database` are the defaults here. Bunny
variables hold at most 256 characters; keys go into secrets. `EDGE_STATS=<key>`
records per-request subrequest counts and a statement trace in `edge_stats`,
readable at `GET /_edge/stats?since=<id>` with `Authorization: Bearer <key>`.

Pull zone: `OriginResponseTimeout` stays at 60 s and cannot be raised, so a
response must start within 60 s. Responses without `Cache-Control` get
`private, no-store`; the pull zone otherwise caches them for 30 days and
ignores cookies.

## Jobs without cron

There is no cron, queue or durable state in Edge Scripting.
`Bunny.v1.waitUntil` keeps the isolate alive after the response (measured:
900 s of background work, a 45 s busy loop). Jobs go into the `jobs`
table as on forge-node; a request that enqueued one drains both queues in
`waitUntil` until no job is due. At most once a minute per isolate a request
claims due schedules (`mirror-sync` from `SCHEDULE`, the five-minute Actions
tick) with one conditional `UPDATE` on `jobs` rows in queue `cron`. Without
requests nothing runs: retries and schedules wait for the next request.
