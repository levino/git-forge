# git-forge — Design

Status: 18 Oct 2026. Living document; decisions listed here override older
discussions. Roadmap and implementation status: [roadmap.md](roadmap.md).

## 1. Goal

A lean, serverless Git forge with built-in Git LFS and a GitHub-like user
experience. Instances can mirror each other's repositories as backups: anyone
who considers a repository worth preserving runs the same software with their
own storage and their own users. This is a light form of federation: no shared
admin, no shared database, only signed server-to-server access to Git content
and LFS objects.

First use case: the digital village archive of Rössing (texts, content
collections, photos, scans, videos; ~100 GB for the foreseeable future). The
forge itself is not archive-specific.

License: MIT.

### Goals

- `git push` / `git clone` / `git lfs` with standard clients over HTTPS.
- Built-in accounts with pluggable login (OIDC, passkeys), apps as machine
  accounts.
- Per-repository permissions, public and private repositories.
- Issues, pull requests, reviews and discussions, GitHub-style.
- Every copy is a bucket (or a directory on a Pi/NAS) from which a plain
  `git clone` works — even without this software.
- Mirrors in other hands that only ever append and detect rewritten history.

### Non-goals

Git over SSH (see §9), CI/Actions, package registry, Codespaces, Copilot,
code search, Projects, security scanning, cross-instance forks, syncing issues
or pull requests between instances.

## 2. Principles

1. **Reading needs no server.** Git over dumb HTTP and LFS objects under their
   hash are static files.
2. **Data outlives the software.** Without the code, cloneable Git
   repositories and an LFS directory remain.
3. **Append only.** Nothing is deleted automatically. Force pushes and
   deletions are allowed unless branch protection forbids them, and the
   previous state is archived (§5).
4. **Trust through signatures and recomputation, not claims.**
5. **One language:** TypeScript, Web-standard APIs only (`fetch`, Streams,
   `DecompressionStream`, WebCrypto). No WebAssembly.
6. **Providers are interchangeable.** Storage, database, scheduling and email
   are adapters (§11).
7. **Permissions always come from the verified token or session**, never from
   client-supplied data.
8. **Core logic as pure functions;** HTTP, UI and sync layers call the same
   functions.

## 3. Features

**Order:** core first (Git, LFS, accounts, mirrors), then the web UI, then
issues, pull requests and discussions.

**Must (first version)**

- **Repositories:** `git push`/`clone` over HTTPS, Git LFS; file tree,
  commits, diffs, Markdown rendering.
- **LFS in the browser:** preview of images, video, audio and PDF straight from
  the bucket; download; CDN-friendly media URLs (§7).
- **Accounts:** users, organizations, teams, per-repository roles (read,
  triage, write, maintain, admin), public and private repositories, personal
  access tokens, apps as machine accounts with limited permissions.
- **Mirrors:** mirror a repository from another instance, auto or manual sync,
  detach, alarm on rewritten upstream history (§6).
- **Issues:** create, comment, labels, assignees, close/reopen, references
  (`#12`), attachments.
- **Pull requests:** from a branch, diff view, comments (general and inline),
  reviews (approve / request changes), merge (merge, squash or rebase —
  conflict-free only), close.
- **Branch protection:** GitHub-style rules per repository (§5).
- **Discussions:** separate from issues; categories, threads, mark answer.

**Should (soon after)**

- Notifications, email, webhooks.
- Reactions, search in issues and discussions.
- Edit and upload files in the browser (commit via form).
- Releases.
- `gh auth login`-style device flow for the command line.

**Later / maybe**

- Actions (via compute adapter), Pages.
- Partial visibility within a repository (levels, derived views).
- Encrypted full backups for mirrors without read access to plaintext.
- External verification of mirrors (§10).
- SSH-to-HTTPS gateway (§9).

## 4. Instances and mirrors

There is **one software with one mode**. A "backup instance" is simply an
instance whose repositories are mirrors. It may run headless (no web UI), for
example on a Raspberry Pi.

- **Every instance is sovereign:** own bucket, own database, own users and
  permissions, own instance key. No instance can command another.
- **A mirror is a normal downstream repository.** Upstream branches and tags
  live read-only under `refs/upstream/{remote}/heads/*` and
  `refs/upstream/{remote}/tags/*`. The repository's own branches are
  independent of them.
- **Sync per repository:** `auto` (push-notified, with a daily safety net)
  or `manual`. **Detach** stops syncing; the repository and its
  `refs/upstream/*` stay as they are.
- **Only Git content and LFS objects are synced.** Issues, pull requests,
  discussions and reviews live in the instance database only and are never
  synced between instances.
- **Rewritten history:** if an upstream ref moves to a commit that does not
  descend from the previously mirrored value, the downstream instance archives
  the old value (§5), applies the new one and raises an alarm. Divergence is
  never merged automatically.
- **Users of a mirror are independent of the upstream.** Who may read a mirror
  is decided by its operator. If the upstream and its identity provider
  disappear, the mirror stays usable with its own users and can simply be
  detached and continue as the primary.
- **Mirror overview:** each instance shows for its repositories which mirrors
  it knows of (§10).

### Push notifications

Typical instances see new data once a month or every half year; it must
reach every mirror quickly, and an idle instance must cost nothing but
storage. Mirrors therefore do not poll; the upstream tells them.

- **Subscription:** when a mirror with `auth: instance` is configured, the
  mirror registers with the upstream through an authenticated federation call
  (`POST /api/federation/subscriptions`, instance JWT, body `repository` and
  `callback`). The upstream stores it in `mirror_subscriptions` only for
  issuers in its trust table, only for repositories named in the token and
  only for callbacks below the subscriber's own issuer URL, and only if the
  subscriber may read the repository (instance grant or public). Trust is
  mutual: the mirror needs the upstream in its own trust table to verify
  notifications. The daily safety
  net renews the subscription (idempotent), so a lost one heals itself.
- **Notification:** after a push that updated at least one ref, the upstream
  enqueues one job per subscriber. The job signs a JWT with the instance key
  (`sub: mirror-notification`, ≤ 300 s, `aud` = mirror) carrying the
  repository and its current ref state, no content, and POSTs it to the
  callback. Nothing is sent inline in the push request. Failed deliveries
  are retried with exponential backoff (10 s, 20 s, … capped at 1 h); a
  `404`/`410` ends them. A retry signs the state at send time, so it never
  delivers stale refs.
- **Receiving:** the mirror verifies the JWT against the upstream's JWKS
  (trust table, optional pinned thumbprint), checks that the addressed local
  mirror follows exactly that upstream repository, and answers `202` after
  enqueueing a sync job — the sync never runs inside the webhook request.
  Notifications are hints, not data: the mirror still fetches refs and packs
  itself and verifies them. They are idempotent: if the announced refs
  (mapped through the mirror's namespace) have the checksum of the last
  successful sync, the answer is `200 up-to-date` and nothing is enqueued;
  a duplicate that slips through runs a sync that changes nothing.
- **Chains:** a sync that moved refs notifies the mirror's own subscribers,
  so a mirror of a mirror (gamma ← beta ← alpha) follows without any cron.
- **Safety net:** the scheduled handler runs once a day (cron `17 3 * * *`,
  `MIRROR_INTERVAL_MINUTES` = 1440 in `wrangler.jsonc`) and enqueues a sync
  and a subscription renewal for every auto mirror whose last run is older
  than the interval. Without a job queue (e.g. a Node deployment without
  one) there are no notifications and the scheduled handler syncs inline, so
  a shorter interval is the right choice there. The rare deep check (§7) is enqueued every
  `MIRROR_DEEP_CHECK_DAYS` (default 30, 0 = off).

### Instance-to-instance access (federation)

OIDC-style, modelled on GitHub Actions OIDC:

- Each instance publishes `/.well-known/openid-configuration` and
  `/.well-known/jwks.json` with its Ed25519 public keys.
- To access another instance, an instance mints a short-lived JWT:
  `iss` = its base URL, `aud` = the target instance, signed with its instance
  key (EdDSA).
- The target keeps a **trust table**: "issuer X may read repository Y (Git +
  LFS)". Grants are revocable at any time.
- The target fetches the issuer's JWKS over HTTPS; the trust anchor is the
  issuer's domain. Optionally a key thumbprint is pinned per grant.
- Public repositories need no grant.
- The token carries the scopes `git:read` and `lfs:read`. The core tells the
  authorization hook whether a request is a Git or an LFS request, so both are
  checked separately.
- A mirror marks in its config (`auth: "instance"`) that it presents an
  instance token to its upstream; otherwise it fetches anonymously. A mirror
  of a mirror reads the upstream's `refs/upstream/{remote}/*` by setting the
  namespace to `upstream/{remote}/`.
- JWKS documents are fetched without following redirects (`redirect:
  "manual"`, any 3xx is an error), because Workers do not implement
  `redirect: "error"`.
- There are no push certificates. The instance signs; trust is
  server-to-server.

## 5. Refs, force pushes and archive

- Refs are updated with compare-and-swap (conditional writes).
- Force pushes and ref deletions are allowed unless a branch protection rule
  forbids them (below). The previous value is always kept under
  `refs/archive/{timestamp}/heads/...` resp. `refs/archive/{timestamp}/tags/...`,
  so no commit becomes unreachable.
- `refs/archive/*` and `refs/upstream/*` cannot be pushed to by clients.
- Git object format stays SHA-1 (compatibility). Signatures and LFS use
  SHA-256.

### Branch protection

Modelled on GitHub's classic branch protection rules; details and API in
the [accounts README](../packages/accounts/README.md#branch-protection).

- **Rules per repository**, each with a branch name pattern (`fnmatch` with
  `FNM_PATHNAME` like GitHub: `*` stops at `/`, `**/` spans directories).
  Exactly one rule applies to a branch: an exact name beats wildcards, among
  wildcards the oldest wins. Rules never combine. Only `refs/heads/*` is
  protected.
- **Settings:** allow force pushes (default no), allow deletions (default
  no), restrict who may push (users, teams, apps, minimum roles), require a
  pull request with 0–6 approving reviews (plus stale-review dismissal,
  code-owner review, last-push approval), require named status checks
  (optionally strict = up to date). `enforce_admins` off means repository
  admins bypass the rule, as on GitHub.
- **One pure check:** `evaluateBranchUpdate(rule, actor, update, evidence)`
  returns all unmet requirements. The actor (principal, resolved access,
  teams) comes from the verified token only. Direct pushes pass
  `via: 'push'`; the pull request merge will pass `via: 'pull-request'` with
  approvals and statuses and call the same function. Required reviews
  therefore already block direct pushes; required status checks block pushes
  whose commit has no passing statuses (no CI exists yet, so in practice all
  direct pushes).
- **Pre-receive policy:** receive-pack asks the `pushPolicy` hook once per
  request, which loads the rules and the actor before the ref transaction and
  returns a synchronous per-ref check. A violation rejects only that ref with
  `ng <ref> protected branch: <reason>`, shown by `git push` as
  `[remote rejected]`; with `--atomic` the whole push fails. A rejected force
  push archives nothing.
- **Mirrors:** `refs/upstream/*` and `refs/archive/*` are not client-writable
  at all and are never matched by branch protection; mirror sync writes
  `refs/upstream/*` itself. Branch protection applies only to the
  repository's own branches.
- **Storage:** rules live in the accounts database (migration
  `0002_branch_protection`), not in the bucket, so a plain clone of a bucket
  carries no rules. Changes are audited.

## 6. Bucket layout

```
<repo>/
  git/                              # cloneable via dumb HTTP
    HEAD
    info/refs
    objects/info/packs
    objects/pack/pack-<sha>.pack
    objects/pack/pack-<sha>.idx
  lfs/
    objects/<oid[0:2]>/<oid[2:4]>/<oid>
  import/status.json                # progress of the last import
  import/commits.txt                # commit order of the last import
  README.txt                        # plain text: what this is, how to read it
```

- Packs are never deleted. Compaction writes a new, larger pack and removes
  old ones from `objects/info/packs` only after a grace period.
- The bucket layout is a durable format and may only change
  backwards-compatibly.

## 7. Flows

**Push** — `receive-pack` over smart HTTP. Parse and index the pack
(completing thin packs), check branch protection per ref (§5), check
fast-forward or archive the old value, update refs via CAS, `report-status`.
Push size limit for Git packs: 64 MB by default;
large files belong in LFS. In v1 packs are processed in memory; streaming pack
indexing is a later optimization.

**Large pushes** — a push is one HTTP request, and Cloudflare caps request
bodies at 100 MB (Free/Pro). Three ways around it, none of which changes git:

- *Chunked push helper* `git forge push` (`packages/cli`, a single executable
  built with `bun build --compile`): splits the history not yet on the remote
  into pushes below a byte budget (default 80 MB, measured with
  `git pack-objects` dry runs) and pushes them one after another with the
  unmodified `git` client. Chunks of a branch go directly to the destination
  branch, so every step after the first is a fast-forward (works with branch
  protection, no garbage); only merged side branches and tags need temporary
  `refs/forge-chunk/…` refs, which the final atomic push deletes. Resuming is
  a rerun: what landed is on the remote. Details in `packages/cli/README.md`.
- *Server-side import* (below): the forge pulls from a URL, so no request
  body is involved at all.
- Later: streaming receive-pack and a remote helper uploading packs directly
  to object storage (roadmap M5a).

**Import** — create or update a repository by pulling from any Git URL
(smart HTTP v2 or dumb HTTP, optional token). It reuses the mirror client
(`connectRemote`, `fetchPackV2`, the dumb walker, `commitClosure`,
`scanNewObjects`, `mirrorLfsObjects`). Unlike a mirror, refs land directly in
`refs/heads/*` and `refs/tags/*`, it runs once and keeps no upstream config.
Rewritten refs are archived as on a force push; local refs missing upstream
are kept. To stay within the CPU and memory limits of one invocation it runs
as a sequence of stateless steps, each persisting its progress in
`<repo>/import/status.json` (compare-and-swap):

1. *discover* — list upstream heads and tags, note local tips and the wanted
   tips.
2. *graph* — if the server supports `filter`, fetch only the commit graph
   (`filter tree:0`), order the new commits parents-first (depth-first
   post-order, so side branches precede their merge) and store the order in
   `<repo>/import/commits.txt`. Nothing of this pack is kept.
3. *fetch* — one step per range of `commitsPerStep` commits (default 500):
   `want` the last commit of the range, `have` every earlier range end and all
   local tips, so the server sends exactly the new objects; store the pack,
   check connectivity, collect LFS pointers. A step whose pack exceeds
   `maxStepBytes` (32 MiB) is retried with a quarter of the commits; small
   packs double the range. A final fetch picks up tag objects. Servers without
   `filter`, and dumb servers, are fetched in one step.
4. *lfs* — 100 LFS objects per step via the upstream's batch API; missing
   objects are recorded, not fatal.
5. *refs* — update refs via compare-and-swap and rewrite `info/refs`; an
   empty repository adopts the upstream `HEAD`.

Fetched packs are handed to a `PackIngester` (`ingestPack`); the default
parses and indexes the pack in memory like the mirror does. Once streaming
pack indexing (a resumable job behind a job adapter, roadmap M5a) is on
`main`, the import streams each fetched pack into storage and hands it to
that job instead, so a step no longer holds the pack in memory.

A failing step is retried with exponential backoff (15 s … 10 min); after
five failures in a row the import is `failed`, and starting it again with the
same URL resumes at the failed phase. Credentials are never written to the
bucket: the token travels with each scheduled step. Steps are driven by the
scheduling adapter (`ImportScheduler`): a Cloudflare Queue in the Worker
(each message is one step in its own invocation), a simple loop (`runImport`)
elsewhere.

**Fetch** — public: dumb HTTP directly from the bucket/CDN. Private:
`upload-pack` (smart HTTP protocol v2) or dumb HTTP behind an authorizing
function.

**LFS** — Batch API; responses carry presigned URLs, the client uploads
directly to the bucket. Verify step before an object counts as present (size
and SHA-256). Reject pushes that reference missing LFS objects. LFS bytes never
pass through the function on upload.

**Mirror sync** — per run (stateless, may abort at any time): obtain a JWT
(§4), read the upstream's refs, bring in the missing objects, update
`refs/upstream/{remote}/*` (archive and alarm on rewrites), fetch missing LFS
objects via the Batch API and verify their hashes. Two strategies:

- **Copy-only** (default between instances, `strategy: 'copy'`): upstream
  packs are already indexed and immutable, so the mirror reads the dumb-HTTP
  files (`info/refs`, `HEAD`, `objects/info/packs`) and copies every pack it
  lacks, with its `.idx`, as is under the same name. Checks per pack, all
  cheap: the index's own SHA-1 trailer, its size against the object count,
  fan-out, strictly sorted ids and offsets inside the pack; while streaming
  the pack, the `PACK` header, version, object count equal to the index and
  the trailer SHA-1 over the whole pack equal to the index's pack checksum.
  The last 20 bytes are held back until the trailer is verified, so a
  tampered or truncated pack makes the storage `put` fail and nothing is
  stored. Then every upstream tip must be found in an index (otherwise the
  missing objects are fetched object by object as with any dumb remote).
  LFS pointers are found among the small blobs of the copied packs (entry
  headers and delta result sizes, inflating only candidates ≤ 1 KiB). No
  object is re-hashed and no index is recomputed, so the mirror's packs are
  byte-identical to the upstream's, down the whole chain. Copy-only trusts
  the upstream for connectivity; integrity of the bytes is verified.
- **Fetch** (any Git server, `strategy: 'fetch'`): negotiate with protocol v2
  `upload-pack` (or walk dumb HTTP), parse and index the received pack, check
  connectivity from the new tips. Used for non-forge upstreams such as
  GitHub.
- **Deep check** (`deepCheckRepository`, on demand via
  `POST /api/repos/{owner}/{repo}/mirrors/{remote}/verify` or scheduled
  rarely): inflate and hash every object of every pack, recompute every
  index and compare it byte for byte, and walk every ref to its last object.
  The result is stored in the mirror status (`lastDeepCheck`). It costs
  roughly a full re-index (§12), which is why it is not part of every sync.

Force pushes and deletions upstream are archived under `refs/archive/*` and
raise alarms with either strategy; storage stays append-only (packs are only
added, `objects/info/packs` only grows).

**Media URLs (LFS onto a CDN without CI)** — two read-only endpoints that a
pull-zone CDN (e.g. Bunny) can sit in front of. The CDN pulls on a cache miss;
there is no upload or publish step.

- `GET|HEAD /{owner}/{repo}/media/{oid}[/{filename}]` streams the LFS object
  with that SHA-256 oid from the bucket. Content-addressed, so
  `Cache-Control: public, max-age=31536000, immutable` and the strong ETag
  `"{oid}"`. The optional trailing file name sets `Content-Type` (by
  extension) and `Content-Disposition: inline`; without it the type is sniffed
  from the first 64 bytes (images, video, audio, PDF, fonts, archives),
  otherwise `application/octet-stream`. The file name does not change the
  bytes, only the headers.
- `GET|HEAD /{owner}/{repo}/raw/{ref}/{path}` resolves `{ref}` and walks the
  trees to `{path}`. `{ref}` is a full 40-character commit (or tag object) id,
  a tag, a branch (names with slashes work: the longest prefix of the path
  that names a ref wins, tags before branches as in `git rev-parse`) or
  `HEAD`. Abbreviated ids are not resolved. A plain blob is streamed with its
  Git blob id as ETag; an LFS pointer answers `302` to
  `/{owner}/{repo}/media/{oid}/{basename}` (relative, so a CDN keeps its own
  host), so the large bytes are cached once, immutably, however many refs
  point at them. Directories, submodules and pointers whose object is not in
  the bucket answer `404`.
- Caching of raw responses (including the redirect): full commit ids are
  immutable; branches, tags and `HEAD` get `public, max-age=60` (core option
  `refMaxAgeSeconds`) because they move.
- Both support single `Range` requests (`206`, `416` with
  `Content-Range: bytes */size`; multi-range requests get the full body),
  `If-Range`, `If-None-Match` (`304`) and `HEAD`.
- Served content must not run script on the forge origin: every response
  carries `X-Content-Type-Options: nosniff` and, except PDFs (browser PDF
  viewers refuse sandboxed documents), `Content-Security-Policy: default-src
  'none'; …; sandbox`. HTML is never labelled `text/html`; unknown types are
  `text/plain` if valid UTF-8, else `application/octet-stream`.
- Permissions use the same `Authorize` callback as Git and LFS with access
  `read`: public repositories anonymously, private ones need a token. A CDN
  pulls private content with a read-only token that the pull zone adds to
  every origin request (`Authorization: Bearer <token>`; in Bunny an Edge
  Rule "Set Request Header" or origin header setting). Everything the CDN
  caches is then readable by whoever can reach the CDN URL, so for private
  repositories the pull zone itself must restrict access (e.g. Bunny token
  authentication / signed URLs) or the repository should be public. The
  Worker has no special token for this: a personal access token with the
  scope `repo:read` of a user with read access does it.
- Core: `matchContentRoute`, `resolveRevision`, `resolvePath`, `resolveRaw`,
  `parseRange` and the content-type helpers are pure functions;
  `handleContentRequest` builds the HTTP responses. Plain blobs are read
  through the object database, which still loads packs into memory (see
  Push); LFS bytes are always streamed from the bucket, ranges via ranged
  bucket reads.

Optional later: a "publish" setting that copies public LFS objects into a
public CDN bucket on push.

**Submit via form** — the server creates blob, tree and commit on a proposal
branch.

**Merge pull request** — fast-forward or conflict-free rebase/merge only;
reject on conflict.

## 8. Identity and permissions

**Built in:** users, organizations, teams, memberships, roles (as on GitHub),
personal access tokens, apps and audit history live in the instance's own
SQLite database. A new instance works without an external identity provider.

**Login methods (pluggable, several at once):**

| Method | When |
|---|---|
| Passkeys (WebAuthn) | Default, built in |
| OIDC (ZITADEL, Keycloak, Authentik, Pocket ID, Google, …) | Connect existing identities; groups → teams optional |
| Personal access tokens | Git over HTTPS (as HTTP Basic password) |
| Device flow (`gh auth login`-style) | Later, for the command line |
| Break-glass key | Later: offline admin key (Ed25519), works without any IdP |
| SAML, SCIM | Later, for organizations that require them |

For the village archive: people log in via OIDC with ZITADEL; apps and
automations use app tokens; mirrors use instance federation (§4).

**Instance admins and bootstrap.** Instance admins (table `instance_admins`)
create users and tokens, trust other instances and count as admins of every
repository. A fresh instance has none: one call of `POST /api/bootstrap`,
authenticated with the deployment secret `BOOTSTRAP_TOKEN`, creates the first
admin atomically and returns a personal access token; further calls answer
`409`. Until login methods exist, the JSON API is used with personal access
tokens that carry the scope `repo:admin`.

**Visibility.** Repositories are private by default; visibility is a
per-repository setting in the database. There is no instance-wide public read
switch.

**Size limits.** Git pushes are limited by `MAX_PUSH_BYTES`; single LFS
objects by `MAX_LFS_OBJECT_BYTES` (default 100 MiB, the request body limit of
Cloudflare's Free and Pro plans), enforced in the batch API and on `PUT`.

## 9. Git over SSH

Not supported, by decision. Serverless functions accept only HTTP; SSH would
need an always-on host or a TCP-capable container platform, and SSH over
WebSocket needs client-side configuration. Git uses HTTPS with tokens, made
convenient by `git forge auth login` (credential helper, device flow).

## 10. Mirror overview and verification

- Each instance lists, per repository, the mirrors it has granted access to
  and when they last synced.
- Later: external verification of public data via range requests on random
  blocks compared to known hashes, with signed results. Redirecting and Sybil
  mirrors cannot be fully excluded; only count confirmed mirrors with
  different providers or known operators.

## 11. Building blocks and provider adapters

Almost everything runs serverless; only things that run foreign code (CI,
dev environments) need real machines, started on demand via API.

| Function | Building block |
|---|---|
| Git, files, diffs, blame | Function + bucket, cache expensive results |
| LFS | Function signs, client transfers directly to the bucket |
| Accounts, issues, PRs, comments, reviews, labels | SQLite database |
| Notifications, webhooks, email | Queues, cron, email service |
| Live updates | Durable Objects with WebSockets, polling as fallback |
| Search in issues | SQLite FTS5 |
| Web UI | Astro SSR |
| Releases, Pages | Bucket + CDN |
| CI (later) | Compute adapter, e.g. with `act` |

Every building block is an interface; Cloudflare is the first implementation.

**Cloudflare deployment.** One Worker serves Git, LFS, media and raw URLs, the
JSON API and the well-known federation documents, and runs mirror sync from a
Cron Trigger. It binds one R2 bucket (`BUCKET`) and one D1 database (`DB`).
The Worker never migrates its database: `wrangler d1 migrations apply` does,
from `packages/accounts/migrations` (`migrations_dir` in
`apps/forge-worker/wrangler.jsonc`, the release's `dist/migrations` in the
instance template; see §15). Several instances on one account are Wrangler
environments (`alpha`, `beta`, `gamma`), each with its own Worker, bucket and
database.

| Building block | Cloudflare | Others |
|---|---|---|
| Functions | Workers | Bunny Edge Scripting, Deno Deploy, Lambda, self-hosted Node/Bun |
| Object storage | R2 | any S3 with conditional writes: Hetzner, B2, OVH, IONOS, self-hosted (versitygw, RustFS); a local directory |
| Database | D1 / SQLite in Durable Objects | libSQL/Turso, SQLite file (Pi) |
| Per-repository consistency | Durable Object | conditional writes (S3 CAS), single-writer process |
| Scheduling, jobs | Cron Triggers, Queues (Workflows for long jobs) | `Deno.cron`, systemd timers, job table, in-process queue |
| Email | Mail service via API | SMTP |
| Compute for CI (later) | Containers | Fly Machines, Hetzner Cloud, … |

**Jobs:** the core defines `JobQueue<J>` (`enqueue(job, { delaySeconds })`),
`jobRetryDelaySeconds` (10 s doubling, capped at 1 h) and `PermanentJobError`.
`@git-forge/cloudflare` implements it on Queues (`QueueJobs`, `consumeJobs`
with `max_batch_size: 1`, so every job is its own invocation with its own
CPU budget); `createMemoryJobQueue` runs jobs in process (Node, tests). Jobs
are plain JSON (repository, remote, callback), so a retry re-reads current
state instead of replaying old data.

**SQLite as the common dialect:** the database layer writes SQLite SQL only,
so it runs on D1, Durable Objects, libSQL and a file on a Pi.

**Storage interface:** `get` (including range), `head`, `put` (streaming,
with checksum), `put` with `If-None-Match` / `If-Match`, `list` by prefix. No
delete. Conditional writes are the only coordination primitive; Durable
Objects are an optimization, not a requirement.

Contract every adapter must meet, checked by the shared conformance suite
`packages/core/test/storage-conformance.ts` (run against `MemoryStorage`,
`FsStorage`, `R2Storage` and `S3Storage`):

- `put` is atomic: if the body is shorter or longer than the declared size or
  the stream errors, the call throws and the key keeps its previous state.
  Streaming adapters achieve this by withholding the last byte until the
  length is verified (`exactLength` in the core).
- Exactly one of several concurrent conditional writers wins.
- ETags are unquoted and change on every write.
- `list` yields keys in lexicographic order across pages.
- Ranges past the end are clamped; the reported size is the full size.

Adapters: `MemoryStorage` (core, tests), `FsStorage` (`@git-forge/node`, a
plain directory per key, lock files for conditional writes), `R2Storage`
(`@git-forge/cloudflare`, binding, no presigning) and `S3Storage`
(`@git-forge/s3`, any S3 API including R2's, with presigning). Presigned LFS
uploads bind `Content-Length` and `x-amz-checksum-sha256` into the signature,
so the bucket rejects any other content.

**Local S3 test environment:** MinIO is discontinued. versitygw (posix
backend) is used; it passed the full suite, as did RustFS. SeaweedFS lists in
directory order instead of lexicographic order, and Garage ignores
`If-Match`/`If-None-Match` on `PutObject` — both unsuitable for refs. Details
in `packages/s3/README.md`.

## 12. Infrastructure and cost (100 GB)

| Item | approx. per month |
|---|---|
| Forge: Cloudflare Workers (paid) | $5 |
| Forge: R2, 90 GB above free tier | $1.35 |
| Mirror: Backblaze B2 | $0.70 |
| Mirror: Hetzner Object Storage | €4.99 |
| CDN: Bunny | ~$1 |
| Mirror compute (Workers Free, see below) | €0 |
| Pi with 1 TB SSD | one-off ~€150 |
| **Total** | **~€13–15** |

### Idle cost and a mirror on the Workers Free plan

An idle instance runs nothing: no polling, one cron invocation per day, and
otherwise only storage is billed. A pure mirror (no own pushes, no web
traffic) does per upstream push: one notification request, one sync job and
one delivery job per own subscriber. Measured with
`pnpm --filter forge-worker bench:mirror` (details and full table in
`apps/forge-worker/README.md`), median of three runs, Node 22 on the
development container:

| per invocation (CPU ms) | small repo (0.9 MiB pack) | medium repo (14.1 MiB pack) |
|---|---|---|
| notification request, in-process replay | 1.4–2.1 | 1.3–1.5 |
| copy-only sync of a 1-commit push, replay | 4.6–5.4 | 4.1–5.6 |
| delivering a notification, replay | 0.6–0.7 | 0.6–3.1 |
| same three through Node's HTTP stack | 4.5, 8.7–14.0, 1.7–2.0 | 6.4–10.0, 8.9–13.3, — |
| copy-only sync of the initial push, replay | 21.8 | 157 |
| re-indexing sync (fetch strategy) for comparison | 195 | 858 |
| deep check | 606 | 2 624 |

The replay rows run the same code in process against a storage snapshot and
recorded upstream responses; they exclude Node's JavaScript HTTP client and
server (workerd's `fetch` is native) and SQLite (D1 is remote I/O, not CPU).
The "Node's HTTP stack" rows are upper bounds.

Cloudflare limits that matter (as published on 18 Oct 2026):
Workers Free allows 10 ms CPU per invocation, 100 000 requests per day and
50 subrequests per invocation, where calls to R2, KV and D1 count as
subrequests ([limits](https://developers.cloudflare.com/workers/platform/limits/),
[pricing](https://developers.cloudflare.com/workers/platform/pricing/));
`limits.cpu_ms` cannot be raised. Cron Triggers are available (5 per
account). Queues are available on Free with 10 000 operations per day and a
fixed 24 h retention ([Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/),
[limits](https://developers.cloudflare.com/queues/platform/limits/)); a
message costs about three operations (write, read, delete), so ~3 000 jobs a
day. Workflows are available on Free with 10 ms CPU per step, 3 000 steps
per day and 100 concurrent instances
([Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/)).
D1 Free: 5 M rows read and 100 000 written per day; R2: 10 GB-month,
1 M Class A and 10 M Class B operations per month free.

Result:

- **Steady state fits.** The typical case — a small push once a month —
  costs a mirror about 1.5 ms (notification) + 5 ms (sync) + under 1 ms per
  downstream subscriber, each in its own invocation, i.e. at roughly half the
  10 ms budget, with ~30 subrequests (≈ 25 storage operations + 5 fetches)
  per sync. Queues, Cron and D1 stay far below their free allowances.
- **Bulk data does not fit.** Verifying bytes in JavaScript costs 6.3 ms per
  MiB of pack (SHA-1) and 7.7 ms per MiB of LFS object (SHA-256), so the
  initial copy of a repository, any push with more than about 0.8 MiB of new
  pack data and any LFS object above about 1 MiB exceed 10 ms. The deep
  check and the re-indexing sync never fit.

Changes that would make a pure mirror fit more often (proposed, not built):

1. **Native streaming hashes.** Pass a hash factory to `verifyingPackStream`
   and the LFS verification; on Workers back it with `crypto.DigestStream`
   (non-standard, native, [docs](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)),
   elsewhere with the JavaScript implementation. Native SHA-1/SHA-256 cost
   1.8/1.3 ms per MiB in the same measurement, so packs of ~3 MiB and LFS
   objects of ~5 MiB would fit.
2. **One unit of bytes per invocation.** Enqueue one job per pack and per
   LFS object and update the refs in a final job once all packs are
   present, so the budget applies per pack instead of per push. Anything
   larger than the budget stays pending (like `lfsPending`) for a paid
   instance or a Node/Pi mirror to fetch; the mirror on Free then only
   follows.
3. **Ranged object reads.** `ObjectDatabase` loads a whole pack to read one
   object (fast-forward check, peeling refs). Reading single entries by range
   keeps a sync cheap when a ref moves onto an object inside a large old
   pack (e.g. a tag on an old commit).
4. **Seed on a larger runtime.** The initial copy (and the deep check) runs
   once on Workers Paid, a Node instance or a Pi; afterwards the same bucket
   is served by a Free-plan worker. The bucket layout is the same everywhere.
5. Deploy a Free-plan instance without `limits.cpu_ms` in `wrangler.jsonc`
   (the key is rejected there).

## 13. Open questions

- Conditional writes on B2, Hetzner, Bunny — supported? (Run the S3 conformance
  suite against them; see `packages/s3/README.md`.)
- Compaction for dumb HTTP: frequency, grace period for old packs.
- Signed append-only log of ref/pack/LFS changes (e.g. C2SP tlog-tiles with
  cosigning instances as witnesses): still useful as audit trail, format open.
- Ref checksum à la GitHub Spokes (XOR over `hash(refname, value)`) for cheap
  mirror comparison.
- Name.

## 14. Prior art and references

**Research decisions**

- Never merge diverged branches automatically, only report.
- LFS via presigned URLs with a verify step.
- zlib inflate needs exact stream boundaries (`DecompressionStream` alone is
  not enough).
- Not: Git objects in Durable Object SQLite, one bundle per ref,
  consensus/3PC, LFS bytes through the function.

**Projects and sources**

- git-on-cloudflare (TS, MIT) — smart HTTP v2 on Workers, streamed push, own
  pack indexer with thin-pack resolution
  (https://github.com/zllovesuki/git-on-cloudflare)
- chr33s/git (TS on Effect, MIT, pre-1.0) — core for DO/Node/browser, merge
  and diff byte-identical to Git (https://github.com/chr33s/git)
- Cloudflare Artifacts (beta) — Git storage for agents, no forge, no LFS
- git-remote-s3 (awslabs) — CAS lock on S3 with `If-None-Match`
- git-lfs-s3-proxy (CC0) — Batch API scaffold with presigned URLs
- GitHub Spokes, GitLab Gitaly/Praefect/Workhorse — concepts
- GitHub Actions OIDC — model for instance federation
- C2SP tlog-tiles (https://github.com/C2SP/C2SP/blob/main/tlog-tiles.md)
- isomorphic-git — pack index, merge in JavaScript
- go-git v6 — `receive_pack.go` as reference for server flows and hooks
- Git docs: pack-protocol, http-protocol, protocol-v2; tests t5550/t5551/t5541
- git-lfs — Batch API specification and integration tests
- Radicle — signed refs per participant
- LOCKSS — many copies, verification, repair

## 15. CI, deployment and updates

### CI

CI emulates the GitHub runner stack so the unmodified official
`actions/runner` and existing per-minute providers work:

- A GHES-style API under `/api/v3`: runner REST (`generate-jitconfig`,
  registration tokens), GitHub App auth and PATs, signed `workflow_job`
  webhooks for external providers.
- The Actions service the runner talks to: connection data and token
  exchange, sessions and message long-poll (or broker and run service), job
  acquire/renew/complete, timeline, logs, later cache, artifacts and OIDC.
- First compute backend: **Cloudflare Containers / Sandbox SDK**. Per job the
  forge starts a container with the runner and a JIT config and discards it
  afterwards (billed per 10 ms, scale to zero, up to 4 vCPU / 12 GiB, rootless
  Docker-in-Docker).
- External backends later via the same API: WarpBuild Enterprise, AWS
  CodeBuild, RunsOn (research in issue #7).

### Deployment

Deployments run in our own CI: a job calls `wrangler deploy` with a Cloudflare
API token stored as an instance secret. No Cloudflare Workers Builds and no
GitHub mirror are needed.

### Distribution, new instances and updates

An instance is a stateless deployment; its operators choose the version. The
deployable unit is a release artifact, not an npm package, and instances never
update themselves.

- **Release artifact** (`release/build-release.sh`, run by
  `.github/workflows/release.yml` on every `v*` tag with `GITHUB_TOKEN` only):
  - `git-forge-worker.mjs`: `apps/forge-worker` bundled by
    `wrangler deploy --dry-run` into one ES module without imports, uploaded by
    instances with `no_bundle: true`, so workerd runs exactly the released
    bytes.
  - `migrations.tar.gz`: the D1 migrations (`migrations/*.sql`, currently from
    `packages/accounts`), built reproducibly.
  - `SHA256SUMS`: `sha256sum` output for both files.
  - The release notes contain the `git-forge.json` to pin. Tags with a `-` are
    pre-releases.
- **One pin covers everything:** `git-forge.json` holds `version` and the
  SHA-256 of `SHA256SUMS`. The build script checks `SHA256SUMS` against the
  pin and then every asset against `SHA256SUMS`; any mismatch fails the build
  before anything is deployed. Asset names and the archive layout are a durable
  format: later releases may add assets, never rename or remove these.
- **Instance template** (`templates/instance`, synced to its own repository
  `levino/git-forge-instance`): `wrangler.jsonc` (own bindings, vars, domain,
  `main: dist/git-forge-worker.mjs`, `build.command: sh build.sh`,
  `migrations_dir: dist/migrations`), `git-forge.json`, `build.sh` (POSIX sh,
  `curl`, `sha256sum`, `tar`), `deploy.sh`, `renovate.json`, a checksum
  workflow and a README. No `package.json`, no lockfile, nothing from npm in the Worker.
  `GIT_FORGE_RELEASE_URL` overrides the download base for mirrors and tests.
- **Resources only from config:** every Cloudflare resource is declared in
  `wrangler.jsonc` and created by Wrangler, never by hand. D1 and R2 have a
  name and no id, so the first `wrangler deploy` provisions them (automatic
  resource provisioning) and later commands find them by name. Cron, vars,
  routes (custom domains) and the required `BOOTSTRAP_TOKEN` secret
  (`secrets.required`) are declared there as well; only the secret's value is
  set outside the repository.
- **Build on Cloudflare (Workers Builds):** build command `sh build.sh`,
  deploy command `sh deploy.sh`. `deploy.sh` applies the D1 migrations before
  the upload so new code never sees an old schema; migrations are therefore
  additive and compatible with the previous release, which keeps a rollback
  (reverting the pin) safe. When the database does not exist yet (first
  deploy), it deploys first, which provisions the database, and migrates right
  after. `build.sh` is idempotent, so the second run through `build.command` is
  a no-op.
- **First install:** "Deploy to Cloudflare" button (copies the template and
  connects Workers Builds) or "Use this template" plus importing the
  repository in the dashboard. The setup page asks for `BOOTSTRAP_TOKEN`
  (from `.dev.vars.example`); one call of `POST /api/bootstrap` with it
  creates the first instance admin (§8).
- **Update:** bump `version` and `sha256` in `git-forge.json` and push.
  Renovate proposes the version via a regex manager on the GitHub releases of
  `levino/git-forge`. It cannot compute the checksum (the `github-releases`
  datasource's digest is the tag's commit, not a file hash, and
  `postUpgradeTasks` exist only for self-hosted Renovate), so the template's
  `Pin checksum` workflow fills in `sha256` on Renovate's pull requests from
  the new `SHA256SUMS` and runs `build.sh`; a human reviews and merges.
- **Template sync:** `.github/workflows/sync-instance-template.yml` copies
  `templates/instance` to `levino/git-forge-instance` with `git-forge.json`
  pinned to the latest release, after every release and on template changes on
  `main`. It pushes with the deploy key `INSTANCE_TEMPLATE_DEPLOY_KEY` and is
  skipped while that secret is missing. The copy in this repository carries an
  all-zero placeholder pin that fails the build on purpose.
- **Test:** `release/test/instance.test.ts` builds a release, runs the
  template's `build.sh` against it via `file://`, checks that wrong pins and
  tampered assets are refused, checks the order of `deploy.sh` with a stub
  Wrangler, applies the migrations and does a push/clone
  smoke test against `wrangler dev` running the template.
- The same bundle may additionally be published to npm later; the template
  never depends on it.

### Test instances

`apps/forge-worker` defines three wrangler environments `alpha`, `beta` and
`gamma`, each with its own D1 and R2. An E2E test runs all three locally and
checks mirroring and federation across them (beta mirrors alpha, gamma mirrors
beta).
