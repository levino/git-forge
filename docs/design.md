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

It is a general-purpose forge. Sizing assumptions in this document (e.g.
§12, ~100 GB with large media in LFS) come from a first real deployment, a
media-heavy archive; nothing in the forge is specific to it.

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

Git over SSH (see §9), package registry, Codespaces, Copilot,
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

- Notifications, email, webhooks (§16).
- Reactions, search in issues and discussions.
- Edit and upload files in the browser (commit via form).
- Releases (§16).
- Browser login for the command line (`git forge auth login`, §8).

**Later / maybe**

- Pages (first version implemented, §20).
- Partial visibility within a repository (refs and paths for a wider audience, implemented, §8).
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
- **Plain clones of a mirror check out the upstream default branch.** Git
  clients only check out `refs/heads/*`, so a mirror shows one remote's
  `refs/upstream/{remote}/heads/*` and `…/tags/*` additionally as
  `refs/heads/*` and `refs/tags/*` (a read-side view, nothing is stored
  twice) and points `HEAD` at the upstream default branch. The view is named
  in `refs.json` as the optional field `mirrorView: { remote, head }`, set by
  the first sync of a remote (only one remote provides it) and its `head`
  follows the upstream `HEAD`. `advertisedRefs(state)` computes the view and
  is used for every read: protocol v2 `ls-refs` and `fetch`, the static
  `info/refs` and `HEAD` files (so a plain clone from the bucket behaves the
  same), raw URLs and the ref state in push notifications.
  `refs/upstream/*` stays visible, so mirrors of mirrors are unchanged.
  - **Own refs win:** a real `refs/heads/X` of the repository shadows the
    view's `X`; nothing local is ever hidden.
  - **Writes see real refs only:** `receive-pack` advertises `refs.json` as
    stored, so pushing `X` to a mirror creates a real branch (which then
    shadows the view) and branch protection never sees virtual refs.
  - **Detach materializes the view:** `detachMirror` writes the view into
    real `refs/heads/*` and `refs/tags/*`, points `HEAD` at the default
    branch and drops `mirrorView`; `refs/upstream/*` stay. The repository
    then continues as a primary.
- **Users of a mirror are independent of the upstream.** Who may read a mirror
  is decided by its operator. If the upstream and its identity provider
  disappear, the mirror stays usable with its own users and can simply be
  detached and continue as the primary.
- **Mirror overview:** each instance shows for its repositories which mirrors
  it knows of, whether they hold the current state and whether their bytes
  match (signed attestations and spot checks, §10).

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
- **GitHub upstreams** notify through a repository webhook (`push` event) at
  `POST /api/repos/{owner}/{repo}/mirrors/{remote}/webhook`. The body is
  verified with HMAC-SHA256 (`X-Hub-Signature-256`, WebCrypto `verify`)
  against a per-mirror secret; `ping` answers `200`, `push` enqueues a sync
  (`202`), other events are ignored. `PUT` on the same path (repository
  admin) creates or rotates the secret and returns URL and secret; with
  `githubToken` (classic `admin:repo_hook`, fine-grained "Webhooks: write")
  it also creates or updates the hook through the GitHub REST API. Without
  a job queue the endpoint answers `503`.
- **Mirror credentials** (an upstream token for `auth: token`, the webhook
  secret) live in `mirror_secrets` (migration `0023`), sealed with AES-GCM
  under `ACTIONS_SECRETS_KEY` like Actions secrets, with the repository,
  remote and kind as additional data. They are never written to the bucket,
  returned by an API or logged. A token goes to the upstream as
  `Basic x-access-token:<token>`.
- **Bulk GitHub mirrors:** `POST /api/mirrors/github` (and the form on
  `/new`) with `account` (GitHub user or organization), `owner` (forge
  account the caller may create repositories in), optional `token`,
  `forks` (default false), `archived` (default true), `visibility`
  (`private` default, `public`, `upstream`), `mode`, `lfs` and `webhook`
  lists the account's repositories (`/user/repos?affiliation=owner` when the
  token belongs to `account`, else `/orgs/{org}/repos` or
  `/users/{user}/repos`, following `Link` pagination) and enqueues one
  `mirror-github` job per repository whose name is free on the forge.
  Private repositories need the token; it travels sealed in the job and is
  stored per mirror. The job creates the repository (permission checked
  again), configures `origin` and enqueues the first sync; existing
  repositories are skipped, so the call is idempotent.
- **Safety net:** the scheduled handler runs once a day (cron `17 3 * * *`,
  `MIRROR_INTERVAL_MINUTES` = 1440 in `wrangler.jsonc`) and enqueues a sync
  and a subscription renewal for every auto mirror whose last run is older
  than the interval. `apps/forge-node` does the same from its own cron
  schedule (`SCHEDULE`, default the same `17 3 * * *`) with its job table in
  the SQLite file. Without a job queue, `PUBLIC_URL` or `INSTANCE_KEY` there are no
  notifications and the scheduled handler syncs inline, so a shorter interval
  is the right choice there. The rare deep check (§7) is enqueued every
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
  whose commit has no passing statuses (CI does not report statuses yet, so in
  practice all direct pushes).
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
  `0002_branch_protection`; D1 on Cloudflare, an SQLite file on Node), not in
  the bucket, so a plain clone of a bucket carries no rules. Changes are
  audited.
- **API authentication:** repository admins manage rules with `repo:admin`
  tokens or a browser session; session writes need the CSRF token and the
  instance's origin (§8), like every other JSON API.

## 6. Bucket layout

```
<repo>/
  git/                              # cloneable via dumb HTTP
    HEAD
    info/refs
    objects/info/packs              # the current pack set
    objects/info/alternates         # forks only: ../../../../<owner>/<name>/git/objects
    objects/pack/pack-<sha>.pack
    objects/pack/pack-<sha>.idx
  lfs/
    objects/<oid[0:2]>/<oid[2:4]>/<oid>   # LFS objects, release assets and Pages files
  pages/deployments/<sha256>.json   # immutable Pages manifest, keyed by its own hash (§20)
  import/status.json                # progress of the last import
  import/commits.txt                # commit order of the last import
  import/blobs.txt                  # blobs of the commit an import is splitting
  actions/jobs/<jobId>/…            # CI logs, console lines, attachments (§15)
  actions/caches/<blobId>/blocks/<uuid>     # parts of a cache archive (§15)
  actions/artifacts/<blobId>/blocks/<uuid>  # parts of an artifact (§15)
  README.txt                        # plain text: what this is, how to read it
tmp/<repo>/<timestamp>-<uuid>/<n>   # staging chunks of a push or fetch, expired by the bucket
tmp/<repo>/<timestamp>-<uuid>/asset # a release asset upload without a declared SHA-256 (§16)
tmp/<repo>/<timestamp>-<uuid>/upload.json   # an upload session of git-remote-forge (§7)
tmp/<repo>/<timestamp>-<uuid>/part/<nnnnn>  # its parts, 1-based, five digits
```

- `<sha>` is the pack's trailing SHA-1 checksum, as with `git index-pack`.
  Every stored pack is self-contained: thin packs are completed by appending
  their delta bases before they are stored.
- **Current pack set:** readers (dumb HTTP clients, the object database,
  `upload-pack`, compaction) only consider the packs listed in
  `objects/info/packs`, in that order; the first pack that contains an object
  wins. Pack files that are not listed are ignored (for example the pack of a
  push whose refs update was rejected). The list is changed only by
  compare-and-swap.
- **Packs are never deleted.** Compaction writes a new pack with the objects
  of the merged packs and then swaps their names for the new one in
  `objects/info/packs`. The old files stay valid, so a reader holding the old
  list keeps working and no grace period is needed.
- **Staging:** a push larger than one chunk (4 MiB) is written to `tmp/` in
  chunks while it is parsed, because the final key contains the checksum,
  which is only known at the end, and `put` needs a key and a size. The chunks
  are read back once to write the final pack and never again. The `Storage`
  interface has no delete; operators expire `tmp/` with a bucket lifecycle
  rule (e.g. one day). Pushes up to one chunk never touch `tmp/`. Fetched
  packs are staged the same way; chunks of failed attempts and unlisted packs
  are never reused and stay until expired.
- **Upload sessions** (§7) live under `tmp/`: one session record, one object
  per part, written once; unfinished uploads expire with the `tmp/` rule.
- **Pages files** are stored the same way, under the SHA-256 of their
  content, and each deployment is one manifest that maps paths to those
  hashes (§20). Which deployment is active lives only in the database.
- **CI caches and artifacts** are stored as the uploaded parts, each under a
  fresh key; which parts make up an entry lives only in the database (§15).
  Evicting or deleting only stops referencing them.
- **Forks share objects through alternates.** A fork created on the same
  instance gets its own `refs.json`, an empty pack list and
  `objects/info/alternates` (git's format, a path relative to the objects
  directory, so a plain bucket clone resolves it like git does). The object
  database reads its own packs first, then the packs of the alternates
  (recursively, at most five levels); LFS lookups fall back to the
  alternates' `lfs/objects/`. Because packs are never deleted, the upstream's
  objects stay readable for the fork whatever happens upstream. Compaction
  only merges a repository's own packs. Over dumb HTTP a fork serves a
  combined `objects/info/packs` and falls back to the alternates for
  `objects/pack/*`, so dumb clients and copy-only mirrors get a
  self-contained repository; the alternates file itself is not served.
- **Release assets** are content-addressed like LFS objects
  (`lfs/objects/…`, §16). Which asset belongs to which release lives only in
  the database; a deleted asset or release leaves its bytes in place.
- **Stable prefixes:** `<repo>` is the repository's `storage_path`
  (migration `0024`, backfilled with `<owner>/<name>` at migration time), not
  its current name. Rename, transfer and account renames change only the
  database; `locatedStorage` in `createForge` maps every `repos/<o>/<n>/` and
  `tmp/repos/<o>/<n>/` key through `locateRepository` (live name, then a
  redirect, so queued imports and jobs under an old name keep working). New
  repositories use `<owner>/<name>`, or `<owner>/<name>.<random>` if that
  prefix is already claimed. Live lookups are cached for 30 s per isolate, so
  a name freed by a rename can be reused only after two minutes.
- **Deletion** sets `deleted_at` (a tombstone); the prefix becomes
  unreachable (reads miss, writes fail) and the name is free after seven days.
  The bytes stay. Operators reclaim space at bucket level: list tombstones
  (`SELECT storage_path FROM repositories WHERE deleted_at IS NOT NULL`) and
  delete `repos/<storage_path>/` with the provider's tools.
- The bucket layout is a durable format and may only change
  backwards-compatibly.
- A backup target (§19) holds the same keys plus `backups/db/<id>/` (database
  dumps) and `backups/changed/<id>/<key>` (later versions of rewritten keys).


## 7. Flows

**Push** — `receive-pack` over smart HTTP, streamed end to end
(`packages/core/src/pack-indexer.ts`):

1. Read the ref commands from the request stream, then parse the pack while it
   arrives. Every byte goes to the pack checksum, the entry's CRC32 and the
   staging writer (§6).
2. Inflate each entry incrementally. Non-delta objects are hashed as they are
   inflated; small ones (and every commit, tree and tag) are kept in a
   byte-budgeted LRU cache. A delta whose base is in the cache is resolved on
   the spot; the rest are deferred.
3. Resolve deferred deltas in pack order: bases are re-materialized from the
   staged pack with range reads (block cache) and the LRU cache, ref-deltas
   whose base is not in the pack are looked up in the repository (thin pack).
4. While resolving, check that every object a new commit, tree or tag refers
   to is in the pack or in the repository, collect LFS pointers, and check the
   ref commands (object exists, branches point at commits, branch protection
   (§5), fast-forward or archive).
5. Write the final pack (the staged bytes, or for thin packs a new header, the
   staged entries, the appended bases and a new trailer) and an idx v2 built
   from compact column arrays, register the pack in `objects/info/packs`,
   update refs via CAS, `report-status`.

Memory is the cache budget (16 MiB), one staging chunk (4 MiB) and about
60–100 bytes per object, independent of the pack's size in bytes. Plain
blobs of any size are only streamed, but objects that must be materialized
(commits, trees, tags, delta bases and delta results) are limited to 64 MiB;
large files belong in LFS. The Worker sets no push size limit of its own
(`MAX_PUSH_BYTES` is optional); the platform's request body limit applies
(`apps/forge-worker/README.md`).

**Large pushes** — a push is one HTTP request, and Cloudflare caps request
bodies at 100 MB (Free/Pro), 200 MB (Business) and 500 MB (Enterprise). Three ways around it, none of which changes git:

- *Remote helper* `git-remote-forge` (below): resumable upload in parts.
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

**Remote helper** — `git-remote-forge` (same executable as `git forge`)
serves `forge::https://host/owner/repo`. Fetch is relayed to
`git remote-https`. Push packs locally into `.git/forge-upload/<key>/`, then
uses `/{owner}/{repo}.git/forge/uploads`: `GET` limits, `POST {parts}`
creates the session (per part a presigned `PUT` bound to length and SHA-256,
or `PUT …/{id}/parts/{n}` through the function), `GET …/{id}` lists missing
parts with fresh URLs (resume), `POST …/{id}/finalize {commands, atomic}` runs
`receivePack` on the commands plus the parts, so policy, LFS check and
`onPush` are those of `git-receive-pack`, with the finalize request's token.
Every call needs `write`. A server without the API gets plain receive-pack.
Parts are separate objects, not S3 multipart: the indexer reads every byte
anyway, no Complete/Abort (abort would be a delete), no 5 MiB minimum, every
adapter works. Finalize indexes in one request, bounded by `cpu_ms`.

**Import** — create or update a repository by pulling from any Git URL
(smart HTTP v2 or dumb HTTP, optional token). It reuses the mirror client
(`connectRemote`, `fetchPackV2`, the dumb walker, `commitClosure`,
`scanNewObjects`, `mirrorLfsObjects`); the *graph* and *fetch* phases are the
stepped fetch in `packages/core/src/stepped-fetch.ts`, shared with mirror
sync. Unlike a mirror, refs land directly in
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
   `maxStepBytes` (32 MiB), or with a delta result above 64 MiB, is retried
   with a quarter of the commits; small packs double the range. A final fetch
   without byte limit picks up tag objects. Servers without `filter`, and dumb
   servers, are fetched in one step.

   *Split* — a one-commit range that is still too large is spread over steps
   (`split` in the state): fetch it with `filter blob:none` into a pack that
   stays unlisted, write the missing blobs of its new trees to
   `import/blobs.txt`, then `want` them by id in batches (halved on overflow,
   doubled after small packs); a batch of one blob has no byte limit and
   arrives undeltified (no `thin-pack`), so the indexer only streams it. After
   the last batch the tree pack is listed and the commit becomes a cut.
   Unlisted until complete, an abandoned split never exposes a commit without
   its blobs. github.com supports both (no `object-info`). Bound: one blob per
   invocation, about 6 s CPU per 100 MiB (JavaScript inflate and SHA-1), so
   about 1 GiB at `cpu_ms` 60000.
4. *lfs* — via the upstream's batch API, at most 100 objects and
   `maxLfsStepBytes` (512 MiB) per step, at least one object; objects are
   streamed into storage and verified by it (`putVerified`, §11) or with
   native SHA-256 (`DigestStream`, `node:crypto`), so any size up to the
   storage's single `put` (5 GiB on R2) works; `MAX_LFS_OBJECT_BYTES` only
   limits uploads. On R2 an object costs almost no CPU. Missing objects are
   recorded, not fatal.
   Endpoint precedence as in git-lfs: `lfsUrl`, then `.lfsconfig` of the
   default branch (other tips, then tags, only if it has none; `lfs.url`
   before `remote.origin.lfsurl`), then `<url>.git/info/lfs`. URLs are
   normalized (http(s), no credentials, trailing `/objects/batch` removed);
   other keys are ignored. The token goes to a `.lfsconfig` endpoint only if
   it has the import URL's origin.
   With a job queue (`scheduleLfs`), each pointer becomes an `import-lfs` job
   as soon as a fetch step finds it (`lfsPending`), carrying the token and the
   endpoint known so far (provisionally the setting or `<url>.git/info/lfs`;
   jobs are re-queued once `.lfsconfig` names another); *lfs* then only checks
   presence, re-queues after 10 minutes without progress (doubling,
   `lfsRound`), and after three rounds hands the rest to the sequential path
   above, which records them as missing. States without `lfsPending` and
   runtimes without a queue use the sequential path.
5. *refs* — update refs via compare-and-swap and rewrite `info/refs`; an
   empty repository adopts the upstream `HEAD`.
6. *metadata* — only with `metadata: true` (GitHub URLs; API
   `https://api.github.com` or `<origin>/api/v3`). One REST page per step,
   in this order: labels, milestones, pulls, issues, issue comments, reviews
   (per imported pull request), review comments, releases, then one release
   asset per step (streamed into `lfs/objects/`, verified against GitHub's
   `digest`). Progress (stage, next `Link` URL, pending assets, counts) lives
   in `metadata.progress` of the state. Pages are fetched with the job's
   token as Bearer and `If-None-Match` (`import_etags`); a `304` skips the
   page. A rate limit (`403`/`429` with `x-ratelimit-remaining: 0` or
   `retry-after`) is not a failure: the step returns `waitUntil` and the
   next step is delayed (at most an hour per step). Writes go through the
   collaboration package's import functions (permission `import`, admin),
   with a principal rebuilt from the job's `actor` (the user who started the
   import) on every step; no events or notifications are emitted.

Fetched packs are handed to a `PackIngester` (`ingestPack`); the default
streams each fetched pack into the same indexer as a push, so a step never
holds its pack in memory. The commit graph of the *graph* phase is read with
the indexer's object visitor without storing the pack.

A failing step is retried with exponential backoff (15 s … 10 min); after
five failures in a row the import is `failed`, and starting it again with the
same URL resumes at the failed phase. An import whose state has not changed
for 30 minutes (`STALE_IMPORT_MS`; a live import writes its state at least
every 10 minutes) counts as abandoned, for example because the process that
drove it lost its job: starting it again with the same
URL takes it over at its current phase. Credentials are never written to the
bucket: the token travels with each scheduled step. Steps are driven by the
scheduling adapter (`ImportScheduler`): a Cloudflare Queue in the Worker
(each message is one step in its own invocation), the SQLite job table in
`apps/forge-node` (so the steps survive a restart), a simple loop (`runImport`) elsewhere.

**Fetch** — public: dumb HTTP directly from the bucket/CDN. Private or
protocol v2 clients: `upload-pack` (smart HTTP protocol v2), streamed:

- **Full clones** (no common `have`) are covered by the stored packs. One pack
  is streamed verbatim; several are concatenated into one pack stream with a
  recomputed header and trailer, dropping objects that an earlier pack already
  contains and rewriting ofs-delta distances where that changes them. Objects
  not reachable from the wanted refs (e.g. archived history) may be included.
- **`packfile-uris`** (protocol v2): if the client asks for it and the forge
  can name a URL per pack (the dumb HTTP URL, a CDN base, or a presigned URL),
  the response lists every stored pack as `<checksum> <uri>` and the in-band
  pack is empty; the client downloads and indexes the packs itself.
- **Incremental fetches** walk the commits reachable from the common `have`s,
  the new commits and the trees of the boundary commits, then generate a pack
  entry by entry: stored non-delta entries are copied verbatim, stored deltas
  are reused as ref-deltas when the base is sent too or the client has it and
  asked for `thin-pack`, everything else is re-deflated.

**Compaction** (`packages/core/src/compaction.ts`) — geometric, like
`git repack --geometric=2`: packs are sorted by size, and the smallest packs
are merged until every remaining pack is at least twice as large as all
smaller packs together. The Worker runs it after each push through
`waitUntil`, up to a size limit; larger merges can run from a scheduled job.
The merged pack is the same concatenation as for full clones, written to
storage, and swapped into `objects/info/packs` (§6).

**LFS** — Batch API; responses carry presigned URLs, the client uploads
directly to the bucket. Verify step before an object counts as present (size
and SHA-256). Reject pushes that reference missing LFS objects. LFS bytes never
pass through the function on upload.

**Mirror sync** — per run (stateless, may abort at any time): obtain a JWT
(§4), read the upstream's refs, bring in the missing objects, update
`refs/upstream/{remote}/*` (archive and alarm on rewrites), fetch missing LFS
objects via the Batch API and verify their hashes. Two strategies:

- **Copy-only** (between instances; the Worker uses `strategy: 'auto'`,
  which copies whenever the upstream serves `objects/info/packs`): upstream
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
  headers and delta result sizes, inflating only candidates ≤ 1 KiB) and
  stored in `lfsPending` before the first download; copied packs are listed
  in the status as `lfsScan` before they are registered and leave it once
  their pointers are recorded. A sync that dies half way (CPU limit, deploy)
  or runs concurrently with another therefore never skips their LFS
  objects. No
  object is re-hashed and no index is recomputed, so the mirror's packs are
  byte-identical to the upstream's, down the whole chain. Copy-only trusts
  the upstream for connectivity; integrity of the bytes is verified.
- **Fetch** (any Git server, `strategy: 'fetch'`): used for non-forge
  upstreams such as GitHub. If the server supports `filter` and objects are
  missing, the sync runs the import's stepped fetch (graph with
  `filter tree:0`, commit ranges, split of oversized commits into blob
  batches) with its progress in `mirrors/{remote}/fetch.json` (plus
  `commits.txt`, `blobs.txt`), written with compare-and-swap. The target
  refs are fixed at the first step; `syncMirror` with `maxSteps` returns
  `pending` until the last step, and refs move only after it. A queued sync
  runs `MIRROR_STEPS_PER_JOB` (4) steps and enqueues a `continue` sync; LFS
  objects then get one `mirror-lfs` job each. After five failures in a row
  the state is dropped (`failed`) and the next sync starts over from new
  upstream refs. Without `filter`, or for dumb servers, one fetch as before
  (v2 negotiation or dumb walk), then a connectivity scan from the new tips.
  LFS endpoint for both strategies as for imports (`lfsUrl`, `.lfsconfig` of
  the upstream default branch first, `<url>/info/lfs`; the token only for the
  upstream origin), stored as `lfsEndpoint` in the mirror status for the
  `mirror-lfs` jobs.
- **Deep check** (`deepCheckRepository`, on demand via
  `POST /api/repos/{owner}/{repo}/mirrors/{remote}/verify` or scheduled
  rarely): inflate and hash every object of every pack, recompute every
  index and compare it byte for byte, walk every ref to its last object, and
  check that the LFS object of every pointer in the packs is stored with its
  size (missing ones go to `lfsPending`, so the next sync fetches them).
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

**LFS publish (optional)** — copy the LFS objects of public repositories
into a public bucket on push, keyed by oid alone, for a CDN that should be
refillable from hashes and never reach the Worker.

- Adapter in the core (`packages/core/src/lfs-publish.ts`): `LfsPublisher`
  with `has(oid, size)` and `publish(oid, size, body)`; `storagePublisher`
  implements it on any `Storage` (key `<prefix><oid>`, written with
  `If-None-Match: *`, never deleted). `publishLfsObjects` copies the given
  oids that exist in the repository and are not yet published;
  `listLfsOids` lists a repository's LFS objects for a backfill.
- `receivePack` reports the LFS pointers of the pushed pack in
  `PushOutcome.lfsPointers`. After a push with at least one accepted ref to a
  **public** repository, the app enqueues `lfs-publish` jobs of 100 oids
  (inline without a job queue). The visibility is checked again when the job
  runs; private repositories are never published, and objects published
  while a repository was public stay published.
  `POST /api/repos/{owner}/{repo}/lfs/publish` (repository admin) backfills
  all objects of a public repository.
- Targets: `CDN_BUCKET` (a second R2 binding) on Cloudflare,
  `LFS_PUBLISH_DIR` (`FsStorage`) on Node; an S3 bucket works through
  `S3Storage`.
- Versus a pull-zone CDN: with Bunny (or any pull zone) in front of the media
  URLs nothing has to be published; the zone pulls
  `/{owner}/{repo}/media/{oid}` on a miss and keeps it forever because it is
  immutable. Publishing is the push alternative: the bytes leave the forge
  once, the CDN or static host never talks to the Worker, and the public
  bucket keeps working without it. Both can be combined (a Bunny pull zone
  whose origin is the public bucket).

**Submit via form** — the server creates blob, tree and commit on a proposal
branch.

**Merge pull request** — merge commit, squash or rebase, computed in core
without a git binary (§17): the same tree as `git merge`, refused on any
conflict. New objects go into one new pack; the base branch moves with
compare-and-swap. No in-browser conflict resolution yet.

## 8. Identity and permissions

**Built in:** users, organizations, teams, memberships, roles (as on GitHub),
personal access tokens, apps and audit history live in the instance's own
SQLite database. A new instance works without an external identity provider.

**Login methods (pluggable, several at once):**

| Method | When |
|---|---|
| Passkeys (WebAuthn) | Default, built in; passkey-only accounts need no IdP |
| OIDC (ZITADEL, Keycloak, Authentik, Pocket ID, Google, …) | Connect existing identities; one provider per instance; groups → teams later |
| Personal access tokens | Git over HTTPS (as HTTP Basic password), JSON API |
| Command-line login (`git forge auth login`) | Paste a one-time code from the browser (PKCE), optionally a loopback redirect or the RFC 8628 device flow; issues a token with the chosen scope, git uses it through the credential helper |
| Break-glass key | Offline Ed25519 key, opens a short admin session when the IdP is down |
| SAML, SCIM | Later, for organizations that require them |

Typical setup: people log in via OIDC or passkeys; apps and automations use
app tokens; mirrors use instance federation (§4).

**Instance admins and bootstrap.** Instance admins (table `instance_admins`)
create users and tokens, trust other instances and count as admins of every
repository. A fresh instance has none: one call of `POST /api/bootstrap`,
authenticated with the deployment secret `BOOTSTRAP_TOKEN`, creates the first
admin atomically and returns a personal access token; further calls answer
`409`. The setup page `/-/setup` (linked from the home page while there is
no admin) calls the same operation (`services.instance.claim`) with the token
from a form and issues a one-time invite for the new admin instead of a
token, so the deployer registers a passkey or links an OIDC identity without
a shell. The JSON API accepts
personal access tokens with the scope `repo:admin` and browser sessions.

### Login

All flows are pure functions in `@git-forge/accounts` (`login.ts`) over a
SQLite store (`login-store.ts`, migration `0006_login`); `createLoginHandler`
maps them to routes under `/login`, `createForge` mounts it, and the web UI
calls the same functions. Cryptography is WebCrypto only: JWS `RS256`,
`ES256`, `EdDSA` for ID tokens, COSE `-7`, `-8`, `-257` for passkeys, a
minimal CBOR decoder for attestation objects.

**Sessions.** A session is a random 256-bit id (`gfs_…`) in an `HttpOnly`,
`SameSite=Lax` cookie (`__Host-gf_session`, `Secure`, on https), stored only
as SHA-256 with user, method, expiry (30 days, break-glass 1 hour) and
revocation. A session gives the user's full rights, like a password login on
GitHub; tokens stay the way to narrow rights. State-changing requests that
rely on the cookie must come from the instance's origin (`Origin`) and carry
the CSRF token `base64url(SHA-256("git-forge csrf\n" + session id))`, as
`X-CSRF-Token` or the form field `csrf`. The token needs no storage and is
worthless without the cookie. `SameSite=Lax` alone is not relied on, because
it still sends the cookie on top-level `POST` navigations from same-site
subdomains.

**OIDC.** Authorization code with PKCE (`S256`), configured per instance
(`OIDC_ISSUER`, `OIDC_CLIENT_ID`, optional secret `OIDC_CLIENT_SECRET`), or,
when those vars are not set, on `/-/setup` (`instance_settings`, the secret
sealed as in §18; discovery must succeed before it is saved). The provider is
re-read at most every 30 seconds per isolate. The
`state` is a one-time challenge in `login_challenges` that also holds `nonce`,
code verifier, `return_to` and intent (login, link, invite), and it is bound
to the browser by a 10-minute cookie, so a callback started elsewhere is
refused (login CSRF). The ID token is verified against the provider's JWKS
(cached 10 minutes, refetched at most once a minute for an unknown key):
signature, `iss`, `aud`/`azp`, `exp`, `iat`, `nbf`, `nonce`. When the ID token
carries no profile (ZITADEL's default), the profile comes from the userinfo
endpoint, which must name the same `sub`. The identity is `(issuer, sub)` in
`external_identities`; emails count only with `email_verified`.

**Who gets an account.** An existing link signs in. Otherwise an invite
(`invites`, one-time, 7 days) either links the identity or passkey to an
existing user or creates a new account (fixed login or chosen), and with
`SELF_SIGNUP=true` any identity or new passkey creates one. Without either,
the login is refused with a hint to ask for an invite. Logins are derived from
`preferred_username`, the email's local part or the name, with `-2`, `-3`, …
when taken.
With an identity provider the first admin comes from a one-time claim instead
of the bootstrap token: the operator inserts a verified email address or
OIDC subject into `instance_admin_claims` (migration 0010) with
`wrangler d1 execute`; the first matching OIDC sign-in creates the account
(even without self-signup), makes it an instance admin and deletes the claim.

**Passkeys.** Registration asks for a discoverable credential, user
verification and attestation `none`; attestation statements are never
verified, any format counts as `none` (no AAGUID allow-lists). Verification
checks type, challenge (one-time, 10 minutes), origin (`PUBLIC_URL`), no
cross-origin, the RP ID hash (the host of `PUBLIC_URL`), UP and UV, and the
signature; the counter must increase unless both sides are zero (synced
passkeys report 0), and it is updated with compare-and-swap. The user handle
is random and shared by all passkeys of a user. Public keys are stored as
JWKs. `PASSKEYS=false` makes an instance OIDC-only: the passkey functions in
`login.ts` refuse with `not_configured` (404 on every passkey endpoint,
including `/api/user/passkeys`), and the login page model carries
`passkeys: false`, so the sign-in, invite and settings pages render no passkey
buttons and no ceremony script. Stored credentials are kept, not deleted.
Break-glass and the device flow are unaffected.

**Access levels.** `repo:read` < `repo:write` < `repo:admin` are cumulative
ceilings; forms offer one radio choice (`accessChoices`). Effective rights are
the minimum of ceiling and repository role.

**Command-line login.** `git forge auth login [--scopes …]` gets a 90-day
token for client id `git-forge-cli`. Consent pages (session + CSRF) show
client, reported host, request IP, time and a phishing warning; the user may
lower the requested scope, never raise it.

1. *Paste (default).* `POST /login/cli/start` stores the PKCE challenge (S256)
   and scope under a random id (`cli_authorizations`, 10 minutes) and returns
   `/login/cli/{id}`. After approval the page shows a one-time code; the CLI
   redeems it with the verifier at `POST /login/cli/token`.
2. *Loopback (`--browser-redirect`, RFC 8252).* Same, but approval redirects
   to `http://127.0.0.1|[::1]|localhost:{port}` with `code` and `state`; that
   consent page's CSP `form-action` allows loopback origins.
3. *Device flow (`--device`, RFC 8628),* for compatibility; the CLI prints
   `verification_uri_complete`.

All three are phishable the same way (whoever starts the request and sends
the link gets the token), hence the consent details. Paste works over SSH and
in containers and a leaked code is useless without the verifier; loopback
needs a local browser; the device code is the only secret of the device flow.
The token goes to `hosts.json` (0600) and the git credential helper.
`git forge repo create` uses it against `POST /api/repos` (needs `repo:admin`).

**Rate limits and purging.** Login, consent and token endpoints are limited
per client address (`LOGIN_RATE_LIMITS`, sliding window in `rate_limits`,
`429` with `Retry-After`). The address is `CF-Connecting-IP` on Cloudflare and
the socket (or last `X-Forwarded-For` hop with `TRUST_PROXY`) on Node. The
scheduled handler deletes challenges, device and CLI authorizations an hour
after expiry and stale rate-limit windows.

**Break-glass.** An Ed25519 key pair generated offline
(`pnpm --filter forge-worker break-glass keygen`); only the public JWK is
deployed (`BREAK_GLASS_PUBLIC_KEY`). The operator signs a JWT
(`purpose: git-forge-break-glass`, `aud` = instance origin, `sub` = login,
`jti`, at most 10 minutes) on a trusted machine and pastes it at
`/login/break-glass`. It works once per `jti`, only for an existing, enabled
instance admin, and opens a one-hour session; every use is in the audit
log.

**Visibility.** Repositories are private by default; visibility is a
per-repository setting in the database. There is no instance-wide public read
switch.

**Partial visibility.** Rows in `visibility_rules` (migration `0017`) let a
wider audience (`public`, a user, a team, a trusted instance) read refs
matching a pattern (`refs/tags/*`, branch protection syntax), optionally only
one path. Admins manage them at `/api/repos/{owner}/{name}/visibility`
(`GET`, `POST` with `refs`, `path`, `audience`, `subject`; `DELETE …/{id}`).
`checkRepositoryAccess` turns the matching rules into a `ReadView`
(`reach(ref, path)`) for principals without read; audience matching is one SQL
fragment shared with listing and search. The `Authorize` hook hands the view
to the core, which applies it to Git, LFS, raw/media and the code pages of the
UI; everything else still needs full read.

- **Paths never reach Git.** Git cannot hide a blob inside a reachable tree;
  hiding it would need rewritten commits under a separate namespace (new ids,
  broken signatures, rewrite state, extra storage, mirror checksums that
  differ from the upstream). Path rules therefore only serve the UI, raw,
  media and LFS; a Git-cloneable subset belongs on its own branch. A visible
  ref exposes its whole history.
- **Git:** `ls-refs` lists the visible refs, `fetch` accepts wants only at
  their tips, ignores haves outside their history and always walks (no stored
  packs or packfile URIs); dumb HTTP answers `404`, so mirrors fetch.
- **LFS and commit ids** are readable when a visible path of a visible ref's
  history reaches them.
- **Mirrors:** partial readers may subscribe and attest; notifications carry
  only their refs; attestations compare with the view's checksum, kept under
  the namespace `view:{issuer}:{namespace}`.
- A view answers anonymous fetches instead of `401`, so members send
  credentials up front (`http.proactiveAuth=basic`, git ≥ 2.46).


**Size limits.** Git pushes are only limited by the platform's request body
limit unless `MAX_PUSH_BYTES` is set; single LFS
objects by `MAX_LFS_OBJECT_BYTES` (default 100 MiB, the request body limit of
Cloudflare's Free and Pro plans), enforced in the batch API and on `PUT`;
with presigned R2 URLs (§11) it can be raised to about 5 GiB.

## 9. Git over SSH

Not supported, by decision. Serverless functions accept only HTTP; SSH would
need an always-on host or a TCP-capable container platform, and SSH over
WebSocket needs client-side configuration. Git uses HTTPS with tokens, made
convenient by `git forge auth login` (credential helper, browser login, §8).

## 10. Mirror overview and verification

Each instance can tell, per repository, which mirrors hold it, whether they
hold the current state, how far behind they are and whether their bytes are
what the upstream has. Nothing here trusts a claim alone (§2.4): attestations
are signed and checked against the upstream's own history, bytes are
sampled and compared.

- **Ref checksum.** XOR over `SHA-1(refname ‖ value)` of all `refs/heads/*`
  and `refs/tags/*` (the advertised refs, §4), as in GitHub Spokes
  (`refsChecksum`, `namespacedChecksum` in core). Order-independent and
  incremental; the value is 40 hex characters, so `name ‖ value` is
  unambiguous. A mirror computes it over what it *holds* in
  `refs/upstream/{remote}/` mapped back through its namespace, so a mirror of
  a mirror compares with its upstream's `refs/upstream/{remote}/` view.
- **History.** The upstream records every checksum it has had
  (`ref_checksums`: repository, namespace, checksum, first seen) after
  pushes, mirror syncs, received attestations and overview requests.
- **Attestations.** After every successful sync, a mirror with
  `auth: "instance"` signs a JWT with its instance key (`sub:
  mirror-attestation`, `aud` = upstream, ≤ 300 s) with repository, checksum,
  ref count, namespace, last sync time, number of alarms, pending units, last
  deep check and its own Git URL, and POSTs it to
  `/api/federation/attestations` (job `mirror-attest`). The upstream verifies
  it like a notification (trust table, JWKS, optional pinned thumbprint),
  requires that the issuer may read the repository (instance grant or
  public), and keeps the latest per mirror including the token, so the
  signed claim can be shown to anyone (`mirror_attestations`).
- **Evaluation** (`evaluateMirror`, pure): the attested checksum equals the
  current one → `current`; equals an older one → `behind`, lag = time since
  the upstream moved past that state; unknown to a non-empty history →
  `diverged` (the mirror holds a state the upstream never had: tampering or
  rewritten history); no attestation for three days → `stale`. Alarms:
  `stale`, `diverged`, `lagging` (behind for more than 26 h), `mirror-alarms`
  (the mirror reported rewritten upstream history), `deep-check-failed`,
  `pending-units` (oversized packs or LFS objects not copied, §12),
  `spot-check-failed`.
- **Spot checks.** At most once a day per mirror, after an attestation, the
  upstream samples eight random 4 KiB ranges of its current packs and LFS
  objects and fetches the same ranges from the mirror (dumb HTTP
  `objects/pack/*` with `Range`, media URLs), with an instance token. Copy-only
  mirrors (§7) store packs byte-identically, so every sample must match; a
  pack the mirror does not have (fetch strategy) is skipped, as is a mirror
  that does not let the upstream read. Differing bytes or failing requests
  fail the check.
- **Overview API.** `GET /api/repos/{owner}/{name}/mirrors/overview` (read
  access) returns the repository's checksum, the mirrors known from
  subscriptions and attestations with state, lag, alarms, last attestation
  (with its token) and spot check, and the repository's own upstreams (sync
  status, held checksum). With an instance key it adds `signed`, a JWT of
  the summary signed by this instance (`sub: mirror-overview`), so a third
  party can archive the upstream's view of its mirrors. The web UI (M6) will
  render this.
- **Limits.** Redirecting and Sybil mirrors cannot be fully excluded: a
  mirror could proxy the upstream's bytes. Count only confirmed mirrors with
  different providers or known operators. Anonymous mirrors (no trust) can
  neither attest nor be spot-checked; anyone can still compare the public
  `info/refs` of two instances.

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
| Releases, Pages | Bucket + CDN (release assets and Pages files are content-addressed like LFS objects, §16, §20) |
| CI | Actions service emulating GHES for the official `actions/runner`; compute adapter starts one runner per job (§15) |

Every building block is an interface; Cloudflare is the first implementation.

**Cloudflare deployment.** One Worker serves the web UI (§18), Git, LFS, media
and raw URLs, the JSON API and the well-known federation documents, and runs
mirror sync from a Cron Trigger. It binds one R2 bucket (`BUCKET`) and one D1 database (`DB`).
The Worker migrates its database itself: when it first builds the forge in an
isolate, `migrateOnStart` adopts migrations that `wrangler d1 migrations
apply` recorded in `d1_migrations` into `schema_migrations` and then applies
the pending ones of the bundled `MIGRATIONS` (from
`packages/accounts/migrations`). A concurrent isolate that loses the race
finds nothing pending and goes on. `wrangler d1 migrations apply` with
`migrations_dir` in `apps/forge-worker/wrangler.jsonc` still works for
development and is adopted on the next start; the instance template has no
migration step (§15). Several instances on one account are Wrangler
environments (`alpha`, `beta`, `gamma`), each with its own Worker, bucket and
database.

| Building block | Cloudflare | Others |
|---|---|---|
| Functions | Workers | Bunny Edge Scripting, Deno Deploy, Lambda, self-hosted Node/Bun |
| Object storage | R2 | any S3 with conditional writes: Hetzner, B2, OVH, IONOS, self-hosted (versitygw, RustFS); a local directory |
| Database | D1 / SQLite in Durable Objects | libSQL/Turso, SQLite file (Pi) |
| Per-repository consistency | Durable Object | conditional writes (S3 CAS), single-writer process |
| Scheduling, jobs | Cron Triggers, Queues (Workflows for long jobs) | `Deno.cron`, systemd timers, job table, in-process queue |
| Public LFS bucket (`LfsPublisher`) | second R2 bucket (`CDN_BUCKET`) | any `Storage`: S3 bucket, local directory (`LFS_PUBLISH_DIR`) |
| Backup target (§19) | second R2 bucket (`BACKUP`) with a bucket lock | any `Storage` (`BACKUP_STORAGE`): S3 bucket with Object Lock, local directory |
| Email | Cloudflare Email Service (`send_email` binding, `@git-forge/cloudflare`); Amazon SES v2 HTTP API (`@git-forge/ses`, SigV4 via `aws4fetch`, runs on Workers and Node) | SMTP for the Node deployment (`@git-forge/smtp`); a console adapter for development |
| Compute for CI | Containers | external per-minute providers via the GHES API (WarpBuild, AWS CodeBuild, RunsOn), Fly Machines, a local process |

**Jobs:** the core defines `JobQueue<J>` (`enqueue(job, { delaySeconds })`),
`jobRetryDelaySeconds` (10 s doubling, capped at 1 h) and `PermanentJobError`.
`@git-forge/cloudflare` implements it on Queues (`QueueJobs`, `consumeJobs`
with `max_batch_size: 1`, so every job is its own invocation with its own
CPU budget); `createMemoryJobQueue` runs jobs in process (Node, tests), with
an optional `concurrency` limit, `keepHistory: false` for long-running
processes and an `onOutcome` callback for logging. Jobs are plain JSON
(repository, remote, callback), so a retry re-reads current state instead of
replaying old data. Memory jobs are lost when the process stops.

**Durable jobs (`apps/forge-node/src/jobs.ts`).** `createSqliteJobQueue`
implements `JobQueue<J>` on the `jobs` table (migration `0021_jobs`). A claim
is one `UPDATE … RETURNING` that increments `attempts` and takes a lease
(60 s, renewed while running); `attempts` fences later updates. Finished or
finally failed jobs are deleted, failed attempts get `run_at` moved by
`jobRetryDelaySeconds`. After a crash the lease expires and the job runs
again (at least once delivery); the lost run counts as an attempt.

**Node deployment (`apps/forge-node`).** The same router as the Worker
(`createForge` from `apps/forge-worker/src/app.ts`, imported as
`forge-worker/app`; it contains no Cloudflare types) in one process: `serve`
from `@git-forge/node` adapts it to `node:http` with streaming request and
response bodies; `FsStorage` or `S3Storage` hold repository data; the SQLite
file is opened with `@git-forge/accounts-node` (`node:sqlite`, WAL);
`nodeDigests` hashes with `node:crypto`; background jobs and import steps run
in two durable SQLite job queues (above) with the Worker's job handler and
retry policy; email goes out through the configured `EmailSender` (SMTP, SES
or console);
a cron scheduler (five-field expressions in UTC) calls the same `scheduled`
as the Worker's Cron Trigger. Configuration uses the Worker's variable names
plus `PORT`, `HOST`, `TRUST_PROXY`, `DATA_DIR`, `DATABASE_PATH`, `STORAGE`,
`STORAGE_DIR`, `S3_*`, `SCHEDULE`, `JOB_CONCURRENCY` and `SMTP_*`
(`EMAIL_PROVIDER=smtp`). Like the Worker it
never migrates implicitly: `git-forge-node migrate` applies the bundled
`MIGRATIONS` (the same SQL files as `migrations_dir`, kept in sync by a test
in `@git-forge/accounts`), and `serve` refuses to start while
`pendingMigrations` is not empty. It runs on Node 22 and, compiled with
`bun build --compile`, as a single executable for `linux-x64` and
`linux-arm64` (Bun implements `node:http`, `node:sqlite` and `node:crypto`);
a Dockerfile builds a distroless image (published as
`ghcr.io/levino/git-forge-node` for `linux/amd64` and `linux/arm64` with every
release) and `deploy/` has systemd units. The
E2E suite runs a Worker under `wrangler dev` and the Node instance (from
source or the executable) side by side and mirrors in both directions with
notifications.

**SQLite as the common dialect:** the database layer writes SQLite SQL only,
so it runs on D1, Durable Objects, libSQL and a file on a Pi.

**Storage interface:** `get` (including range), `head`, `put` (streaming,
with checksum), `put` with `If-None-Match` / `If-Match`, `list` by prefix. No
delete. Conditional writes are the only coordination primitive; Durable
Objects are an optimization, not a requirement.

Contract every adapter must meet, checked by the shared conformance suite
`packages/core/test/storage-conformance.ts` (run against `MemoryStorage`,
`FsStorage`, `R2Storage` and `S3Storage`):

- `get` with a range returns exactly the requested bytes (clamped at the end);
  the object database and the indexer read packs only through ranges.
- `put` is atomic: if the body is shorter or longer than the declared size or
  the stream errors, the call throws and the key keeps its previous state.
  Streaming adapters achieve this by withholding the last byte until the
  length is verified (`exactLength` in the core).
- `putVerified` (optional) stores a stream only if its SHA-256 equals the
  given one, checked by the storage itself, and throws
  `ChecksumMismatchError` otherwise. `R2Storage` passes R2's `sha256` put
  option (no Worker CPU; `withPresigner` keeps it). LFS objects and pack-upload
  parts use it when present, else the hashing `verifyingStream`. On Workers a
  `fetch` body arrives in 4 KiB chunks: hashing it in the Worker costs about
  24 ms CPU per MiB even piped into `crypto.DigestStream`, 38 ms through a
  `TransformStream`, so a 4 GB mirror never fit into one invocation.
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

**Presigned R2.** With `R2_S3_ENDPOINT`, `R2_BUCKET_NAME`,
`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` the Worker wraps the binding with
`withPresigner(R2Storage, S3Storage)`: the binding does all I/O, the S3
adapter only signs (LFS and pack-upload URLs) on the same keys. Verify re-hashes through the
binding (`crypto.DigestStream`, ~2 s CPU for 600 MB). Without the key LFS is
proxied, and the size error carries `oversizeHint`. The key is an account API
token with "Workers R2 Storage Bucket Item Read/Write"
(`6a018a9f2fc74eb6b293b0c548f38b39`, `2efd5506f9c8494dacb1fa10a3e7d5b6`) on
`com.cloudflare.edge.r2.bucket.<account_id>_default_<bucket>`; access key id =
token id, secret = hex SHA-256 of the token value.

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
| notification request, in-process replay | 1.3–1.5 | 1.1–2.5 |
| copy-only sync of a 1-commit push, replay | 4.7–10.2 | 4.1–5.0 |
| delivering a notification, replay | 0.7 | 0.6–0.8 |
| same three through Node's HTTP stack | 4.3–4.8, 8.9–14.1, 1.6–2.1 | 7.0–10.0, 10.6–14.9, — |
| copy-only sync of the initial push, replay, JavaScript hashes | 19.7 | 140 |
| the same with a native streaming hash | 10.2 | 65 |
| re-indexing sync (fetch strategy) for comparison | 215 | 851 |
| deep check | 574 | 2 651 |

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
- **Bulk data needs units.** Verifying bytes in JavaScript costs about 6 ms
  per MiB of pack (SHA-1) and 7 ms per MiB of LFS object (SHA-256). With
  `crypto.DigestStream` (native) hashing costs 1.2–1.8 ms per MiB; the rest
  of a bulk copy in the Node measurement (about 4 ms per MiB) is mostly
  Node's JavaScript implementation of web streams, which is native in
  workerd. A Free-plan mirror therefore copies one pack or LFS object per
  invocation and sets a byte budget per unit (`MIRROR_UNIT_BYTES`, e.g.
  1 MiB to stay safely inside 10 ms; check the real CPU time in Workers Logs
  and raise it). The deep check and the re-indexing sync never fit.

What was done about it:

1. **Native streaming hashes (built).** `verifyingPackStream` and the LFS
   `verifyingStream` take a `DigestFactory` (`@git-forge/core`,
   `javascriptDigests` by default). The Worker passes `digestStreams` from
   `@git-forge/cloudflare`, backed by `crypto.DigestStream` (non-standard,
   native, [docs](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/));
   it is tested against the JavaScript hashes in workerd.
2. **One unit of bytes per invocation (built).** With `MIRROR_UNIT_BYTES` set,
   a sync job first plans (`planPackCopy`: missing packs and their sizes from
   `HEAD` requests, stored as `pendingPacks` in the mirror status), then
   enqueues one `mirror-pack` job per pack (`copyPendingPack`: copy, verify,
   register, record the LFS pointers it contains). The job that copies the
   last pack enqueues the final sync, which only updates the refs and defers
   LFS (`deferLfs`); each LFS object then gets its own `mirror-lfs` job
   (`mirrorPendingLfsObject`). Packs above the budget stay in `pendingPacks`
   with `oversized: true` and the refs are not moved past them; LFS objects
   above the budget stay in `lfsPending`. A later sync with a larger budget
   (Workers Paid, a Node instance, a Pi) picks them up; the bucket layout is
   the same everywhere. Without `MIRROR_UNIT_BYTES` everything runs in one
   job as before.
3. **Ranged object reads (by the streaming work).** `ObjectDatabase` reading
   single entries by range instead of whole packs is part of the bounded-memory
   rework of `ObjectDatabase` (block cache with ranged storage reads) and is
   not duplicated here.
4. **Seed on a larger runtime (documentation).** The initial copy of a large
   repository and the deep check run once on Workers Paid, a Node instance
   or a Pi with the same bucket (or with the Free-plan instance's bucket via
   its S3 API); afterwards the Free-plan worker only follows small pushes.
   Oversized units left by a Free-plan mirror are picked up the same way.
5. Deploy a Free-plan instance without `limits.cpu_ms` in `wrangler.jsonc`
   (the key is rejected there).

## 13. Open questions

- Conditional writes on B2, Hetzner, Bunny — supported? (Run the S3 conformance
  suite against them; see `packages/s3/README.md`.)
- Signed append-only log of ref/pack/LFS changes (e.g. C2SP tlog-tiles with
  cosigning instances as witnesses): still useful as audit trail, format open.
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
- actions/runner — the runner and its SDK (`VssHttpClientBase`, `MessageListener`,
  `JobDispatcher`, pipeline contracts) define the CI protocol
- ChristopherHX/runner.server and ChristopherHX/github-act-runner — open
  reimplementations of the Actions service and the runner protocol
- Git docs: pack-protocol, http-protocol, protocol-v2; tests t5550/t5551/t5541
- git-lfs — Batch API specification and integration tests
- Radicle — signed refs per participant
- LOCKSS — many copies, verification, repair

## 15. CI, deployment and updates

### CI

Decision (18 Oct 2026, research in issue #7): CI **emulates the GitHub
runner stack**. Workflows are GitHub Actions YAML, jobs run on the
**unmodified official [`actions/runner`](https://github.com/actions/runner)**,
and the forge looks like a GitHub Enterprise Server (GHES) to everything
outside: the runner, and later external per-minute runner providers.

Why: the runner, the action ecosystem and the providers all exist already.
`actions/runner` treats every host that is not `github.com` / `*.ghe.com` as
GHES, so a forge that answers under `/api/v3` and speaks the runner's service
protocol can use all of them. The alternatives from issue #7 (Gitea's
`act_runner` protocol, Buildkite, GitLab runner emulation) would lock us out
of either the official runner or the providers.

#### Architecture

```
git push ──► receive-pack ──► onPush
                                │ read .github/workflows/*.yml at the new tip
                                │ parseWorkflow (core, pure) + triggeredByPush
                                ▼
                      actions_runs / actions_jobs (SQLite)
                                │ per queued job: JIT runner (RSA key, ephemeral)
                                ▼
                      RunnerLauncher (compute adapter)
                       ├─ Cloudflare Container: official runner image, --jitconfig
                       ├─ local process (tests, Pi)
                       └─ later: external provider via GHES API + workflow_job webhook
                                │
           unmodified actions/runner ──HTTPS──► Actions service  /_services/actions
                                                connectionData, OAuth, sessions,
                                                message long-poll, job renew/finish,
                                                timeline, logs ──► bucket
```

Pieces and where they live:

| Piece | Package | Notes |
|---|---|---|
| YAML subset parser, workflow/job model, trigger filters, reading workflow files from a commit | `@git-forge/core` (`yaml.ts`, `workflow.ts`) | Pure functions. Unsupported YAML (anchors, tags, multi-document, multi-line plain scalars) and unsupported workflow keys are rejected with all problems listed, never silently ignored. |
| Expression evaluator, matrix expansion, cron | `@git-forge/core` (`expression.ts`, `matrix.ts`, `cron.ts`) | Pure. The GitHub expression language (literals, contexts, `.`/`[]`/`.*`, operators with GitHub's loose equality, `contains`/`startsWith`/`endsWith`/`format`/`join`/`toJSON`/`fromJSON`, status functions), used server-side for job `if`, `runs-on`, `strategy`, job names, `environment`, `concurrency`. |
| Commit tarballs, shallow fetch | `@git-forge/core` (`tarball.ts`, `upload-pack.ts`) | `uses:` actions are downloaded as `tar.gz` streamed from a commit; `deepen <n>` and `deepen-relative` in upload-pack because `actions/checkout` fetches with depth 1. |
| Check runs | `CheckRunSink` adapter (`dispatch.ts`) | One check run per job, written through the collaboration package's check-run store (required status checks). |
| Actions service (runner protocol) | `@git-forge/actions` (`service.ts`) | Mounted at `/_services/actions`; that URL is the runner's `ServerUrl`. |
| GHES REST subset | `@git-forge/actions` (`rest.ts`) | Under `/api/v3`. |
| Job message, template tokens, context data | `@git-forge/actions` (`job-message.ts`, `template.ts`) | Pure. `${{ }}` in strings becomes a `format()` expression token, so the runner evaluates expressions exactly as on GitHub. |
| Dispatch: triggers → runs → jobs → JIT runners; `needs`, `if`, matrix, throttling, approvals, cancellation, re-runs, schedules, reaper | `@git-forge/actions` (`dispatch.ts`) | See "Workflow semantics" below. |
| Secrets and environments | `@git-forge/actions` (`secrets.ts`) | AES-256-GCM under the instance key `ACTIONS_SECRETS_KEY`. |
| Action downloads | `@git-forge/actions` (`actions-download.ts`) | `owner/repo@ref` → repository on the forge (usually a mirror) → tarball URL plus a scoped token. |
| Results service: cache (v1 REST and v2 twirp), artifacts v4, blob URLs, ID tokens | `@git-forge/actions` (`results.ts`, `cache.ts`, `artifacts.ts`, `blobs.ts`, `oidc.ts`) | Mounted at `/twirp/`, `/_services/cache/`, `/_services/results/` and `/_services/token/`. See "Results service" below. |
| Runner container | `apps/forge-worker` (`runner-container.ts`, `runner-launcher.ts`, `runner/Dockerfile`), declared in `apps/forge-worker/wrangler.jsonc` (opt-in snippet in the README of `templates/instance`) | Cloudflare Containers; the only Cloudflare-specific part. A plain Durable Object class on `ctx.container`, so the release bundle stays one module without imports. |

#### Runner protocol

The spike implements the "legacy" distributed-task flow (`use_v2_flow:
false`), which the runner still supports for GHES. Endpoints, relative to the
service URL (route templates published through `connectionData`, the same
location IDs as in the runner SDK and in ChristopherHX/runner.server):

| Endpoint | Purpose |
|---|---|
| `GET _apis/connectionData`, `OPTIONS _apis` | Location service: maps location GUIDs to route templates. |
| `POST _apis/v1/auth/` | OAuth 2 client-credentials with an RS256/PS256 JWT client assertion signed by the runner's RSA key; answers a short-lived runner token. Unauthenticated calls get `401` with `WWW-Authenticate: Bearer`, which makes the runner fetch a token. |
| `POST/DELETE _apis/v1/AgentSession/1[/{sessionId}]` | Session per listener process. Messages are not encrypted (no session key); TLS protects them. |
| `GET/DELETE _apis/v1/Message/1[/{messageId}]` | Long-poll (≤ 50 s, polling the job table) for a `PipelineAgentJobRequest` or a `JobCancellation` (`{ jobId, timeout }`) for a job of this session. A job is claimed atomically (`UPDATE … WHERE status = 'queued'`); a job message not yet acknowledged with `DELETE` is re-delivered to the same session. The listener keeps polling while its job runs, which is how cancellations reach it. |
| `GET/PATCH _apis/v1/AgentRequest/1/{requestId}` | Renew the job lock (first renew = job started) and finish it. |
| `PATCH _apis/v1/Timeline/{scope}/{hub}/{plan}/{timelineId}` | Timeline records (job and steps). |
| `POST _apis/v1/Logfiles/{scope}/{hub}/{plan}[/{logId}]` | Step logs, stored as append-only chunks in the bucket. |
| `POST _apis/v1/TimeLineWebConsoleLog/…` | Live console lines, stored in the bucket. |
| `POST _apis/v1/FinishJob/{scope}/{hub}/{plan}` | `JobCompleted` event from the worker: result and job outputs, then the run advances. |
| `PUT …/attachments/{recordId}/{type}/{name}` | Step summaries and other attachments. |
| `POST _apis/v1/ActionDownloadInfo/…` | Resolves `{ nameWithOwner, ref }` to `{ resolvedNameWithOwner, resolvedSha, tarballUrl, authentication }`, keyed `owner/repo@ref`; `404` listing every action that cannot be resolved. |
| `GET/POST _apis/v1/AgentPools`, `_apis/v1/Agent/1` | Classic `config.sh` registration with a registration token. |

The job message is built server-side from the job model: `run` steps become
`ActionStep`s with a `script` reference; `uses` steps get a `repository` /
`containerRegistry` reference; job and workflow `env` become
`environmentVariables`, `defaults.run` becomes `defaults`, job `outputs`
become `jobOutputs` (evaluated by the runner, returned in `JobCompleted`);
the `github` (with the event payload), `inputs`, `needs`, `matrix` and
`strategy` contexts are filled from the run and the job leg; the job token is
`system.github.token`; secrets are variables with `isSecret: true` (so the
runner masks them in logs and exposes them as the `secrets` context). Step
expressions (`${{ }}` in `run`, `with`, `env`, step `if`) stay expressions
for the runner.

#### Workflow semantics

A run is created by a trigger (`createWorkflowRun`): it stores the parsed
workflow, the event payload and the inputs in `actions_runs.definition`, and
inserts one placeholder job per workflow job (`expanded = 0`, `pending`).
`advance(runId)` then loops until nothing changes:

- A placeholder whose `needs` are all complete is evaluated: `if` (default
  `success()`; `success()`/`failure()`/`cancelled()`/`always()` refer to
  the needed jobs and the run) with the `github`, `inputs`, `vars` and
  `needs` contexts. False → `skipped` (or `cancelled` in a cancelled run).
  True → the matrix is evaluated (it may come from `fromJSON(needs.…)`) and
  expanded into legs; the placeholder becomes the first leg, the others are
  inserted. Each leg gets its evaluated name (`build (linux, 22)` unless the
  name references `matrix`), labels, environment and `continue-on-error`.
  Evaluation errors fail the job with the message in its definition and
  check run.
- Legs start `queued` (a JIT runner is launched) up to `max-parallel`, the
  rest wait `pending` and are promoted as others finish. Legs whose
  environment has required reviewers wait with `approval = 'waiting'`.
- `fail-fast` (default on): a failed leg that does not continue on error
  cancels the other legs of its job.
- The result of a job for `needs.<job>.result`: `failure` if a leg failed
  without `continue-on-error`, else `cancelled` if one was cancelled, else
  `skipped` if all were skipped, else `success`. Its outputs are the legs'
  outputs merged in order (the last leg that sets a name wins).
- When every job is complete the run gets `completed_at` and a conclusion
  (`failure`, `cancelled` or `success`).
- `concurrency` (workflow level): the group is evaluated at creation. With
  `cancel-in-progress` older runs of the group are cancelled; without it,
  older runs that have not started are cancelled. A run waits (its
  placeholders stay) while an older run of its group is not complete.
- `concurrency` (job level): evaluated per leg and stored in its
  definition. A grouped leg starts `pending`; it is promoted only while no
  job of the repository in that group is queued or running (one atomic
  `UPDATE`). A new leg cancels the pending ones of its group, with
  `cancel-in-progress` also the running ones. A completed job advances the
  run with the oldest waiting job of its group.
- `vars`: repository variables, overridden by those of the approved
  environment in the job message (`actions_variables`, `GET/POST
  …/actions/variables`, `GET/PATCH/DELETE …/actions/variables/{name}`, same
  under `…/environments/{name}/`; names as for secrets). Untrusted runs get
  none.

Cancellation (`cancelRun`, API `…/cancel`): `pending` and `queued` jobs are
completed as `cancelled` at once (and their ephemeral runner is removed,
which makes it exit); running jobs get `cancel_requested_at`, and the next
long-poll of their session returns a `JobCancellation` message. The runner
cancels the steps and reports `canceled`.

Re-runs (`rerunRun`, API `…/rerun`, `…/rerun-failed-jobs`,
`…/jobs/{id}/rerun`) need a completed run with a stored definition. They
start a new attempt (`actions_runs.attempt`, `github.run_attempt`): the
selected jobs (all, those that failed or were cancelled, or one) and every
job that needs them transitively get new placeholders with the new attempt.
The current state of a run is, per workflow job, the rows of its latest
attempt; older attempts stay for the API (`?filter=all`). A whole matrix is
re-run, not single legs.

Reaper (`reapActions`, from `actionsTick` on the `*/5 * * * *` cron):

- sessions without a poll for 10 min are closed (their undelivered jobs go
  back to `queued`);
- `in_progress` jobs past `timeout-minutes` get a cancellation (reason
  `timeout`, check-run conclusion `timed_out`); jobs whose cancellation was
  not acknowledged within 5 min are completed as `cancelled`;
- `in_progress` jobs whose lock was not renewed for 5 min past its expiry
  (the runner renews every minute, the lock lasts 10 min) are failed
  (`runner-lost`);
- jobs delivered but not started within 10 min, and queued jobs whose
  ephemeral runner never connected within 10 min, are requeued and get a new
  runner, up to three launches per job; then they fail;
- expired tokens older than a day are deleted.

#### Triggers

| Event | Entry point | Notes |
|---|---|---|
| `push` | `queueRunsForPush` (receive-pack hook) | Branch and tag filters. A push to the default branch also refreshes the repository's schedules. |
| `workflow_dispatch` | `dispatchWorkflow`, `POST …/actions/workflows/{file}/dispatches` | `ref` (branch, tag or SHA) and `inputs`, validated against the typed inputs (`string`, `boolean`, `number`, `choice`, `environment`), defaults applied. |
| `schedule` | `syncSchedules` (on push to the default branch) and `runDueSchedules` (cron) | `actions_schedules` holds `(repo, workflow, cron, next_run_at)`; a due row is claimed with a compare-and-swap on `next_run_at`, the workflow is read again from the current default branch. Cron in UTC, five fields with names, ranges, steps, lists. |
| `pull_request` | `queueRunsForPullRequest(event)`, called by the Worker for the collaboration package's `pull_request` activities | Base branch filters and `types` (default `opened`, `synchronize`, `reopened`); the workflow is read from the merge commit if given, else the head; `github.ref` is `refs/pull/{n}/merge` or `…/head`. The caller decides `trusted`; pull requests on this forge come from branches of the same repository, so they are trusted. |

`paths` and `paths-ignore` (`push`, `pull_request`) match the changed files:
`before..after` of a push (none for new branches, so they run; ignored for
tags), base..merge commit (or head) of a pull request. `paths-ignore` skips
only when every file matches, `paths` needs one match (`!` negates).

#### Actions (`uses:`)

The runner asks `ActionDownloadInfo` for every `owner/repo@ref` of the job
(also nested ones of composite actions). The forge maps the name to a
repository on the forge (`ACTIONS_REPOSITORIES`, e.g. `{"actions/*":
"mirrors/*"}`, identity by default), resolves the ref there (SHA, tag,
branch; for mirrors through the read-side view or `refs/upstream/*`) and
answers `tarballUrl = /api/v3/repos/{o}/{r}/tarball/{sha}` with a `github`
token scoped to that repository and the job (revoked with the job's other
tokens). The runner downloads with `Authorization: Basic x-access-token:…`.
A job may use repositories of its own owner and public ones (`canUse`).
Without a repository on the forge the action either fails the job (default)
or, with `ACTIONS_GITHUB_FALLBACK`, is downloaded from `api.github.com`.
Tarballs are built while streaming (`commitTarball`: ustar with pax headers
for long names, symlinks, executable bits, a top-level `owner-repo-sha7/`
directory like GitHub) and gzipped with `CompressionStream`.

`actions/checkout` fetches the job's commit with `--depth=1` over smart
HTTP with the job token as `AUTHORIZATION: basic …` extra header, so
upload-pack supports `deepen <n>`, `deepen-relative` and `shallow` lines
(`shallow-info` section), not `deepen-since`, `deepen-not` or filters.

#### Check runs

Every job leg reports a check run through the `CheckRunSink` adapter
(`create(repo, report) → id`, `update(repo, id, report)`): name = job
display name, `head_sha` = run SHA, `status` queued → in_progress (first
lock renewal) → completed, conclusion from the job (`timed_out` for
timeouts), `external_id` = job ID, `details_url` = job URL; the id is kept
in `actions_jobs.check_run_id`. The collaboration package owns the
`check_runs` table, its API and the evaluation of required status checks;
the Worker implements the sink with its `recordCheckRun` /
`updateCheckRunRecord`. Without a sink no check runs are written.

#### Results service: cache, artifacts, ID tokens

No broker or v2 flow: in the legacy flow the runner takes the URLs from the
`SystemVssConnection` endpoint data (`CacheServerUrl` → `ACTIONS_CACHE_URL`
= `/_services/cache/`, `ResultsServiceUrl` → `ACTIONS_RESULTS_URL` = `/`,
`GenerateIdTokenUrl` → `ACTIONS_ID_TOKEN_REQUEST_URL`) and the variable
`actions_uses_cache_service_v2`. `ACTIONS_RUNTIME_TOKEN` is opaque (checked
by hash) but JWT-shaped with `scp: "Actions.Results:{runId}:{jobId}"`,
because `@actions/artifact` reads the IDs from it; the forge derives job,
run and repository from the token and rejects IDs that differ.

The toolkit treats every host except `github.com`, `*.ghe.com` and
`*.localhost` as GHES. There `actions/cache@v4` uses the **v1** REST protocol
(`_apis/artifactcache/…`, `PATCH` chunks of 32 MiB with `Content-Range`);
elsewhere the **v2** twirp `CacheService`. `@actions/artifact` 2.x
(`upload-artifact@v4`, `download-artifact@v4`) refuses
GHES hosts on the client, so the twirp `ArtifactService` only works with the
official actions on `*.localhost`, or with forks that drop the check (e.g.
`christopherhx/gitea-upload-artifact@v4`, mapped with
`ACTIONS_REPOSITORIES`; `upload-pages-artifact` follows the mapping).
`deploy-pages@v4` itself only uses REST (`runs/{id}/artifacts?name=`,
`pages/deployments`) and an ID token. Artifacts v3 are not implemented.

**Blobs.** Uploads and downloads use capability URLs
`/_services/results/blobs/{token}[/{filename}]` (`actions_blob_grants`:
SHA-256 of a random token, read or write, bound to the job). The handler
speaks the Azure block blob subset the Azure SDK uses (`PUT`,
`?comp=block`, `?comp=blocklist`, `GET`/`HEAD` with `Range`). Every block or
v1 chunk is written once to a new key; the commit records the ordered parts
in `actions_blob_parts` and freezes the blob. Uploads always pass through
the Worker: the Azure SDK appends `comp`/`blockid` to the signed URL and the
v1 client builds its own URLs, so presigned R2 URLs (which sign the query
and need size and SHA-256 up front) cannot be handed out. Blocks (8 MiB for
artifacts, 32 MiB v1 chunks) stay below the Worker body limit; only v2
single-shot uploads of 100–128 MiB, which occur on `*.localhost` only, exceed it.

**Cache.** Entries are scoped per repository and ref; a restore searches
the run's ref, the pull request base, then the default branch, each by
exact primary key, then restore keys exactly and as prefix, newest first.
Entries are immutable; a run only writes its own ref. The reaper evicts by
setting `evicted_at`: unused for `ACTIONS_CACHE_UNUSED_DAYS` (7), older than
`ACTIONS_CACHE_MAX_DAYS` (30), unfinished reservations after six hours, and
least recently used beyond `ACTIONS_CACHE_LIMIT_BYTES` (10 GiB). Bytes stay;
a lifecycle rule may expire `…/actions/caches/` after the max age plus one
day, and `…/actions/artifacts/` after `ACTIONS_ARTIFACT_RETENTION_DAYS`
(90) plus one.

**Artifacts.** One per name and run; retention capped by
`ACTIONS_ARTIFACT_RETENTION_DAYS`; deleting sets `deleted_at`. REST:
`artifacts[/{id}[/zip]]`, `runs/{id}/artifacts`, `caches`, `cache/usage`.
Pages deployments with `artifact_id` read the artifact through
`openArtifactFile`: `artifact.tar` (or the only entry) of the stored zip,
located by its central directory and inflated while streaming.

**ID tokens.** Only for trusted runs whose job or workflow `permissions`
grant `id-token: write`, checked when the URL is handed out and again on
`GET /_services/token/idtoken?audience=…`. Claims follow GitHub's (`sub`
`repo:o/r:ref:…`, `…:environment:e` or `…:pull_request`; IDs are the forge's
strings; `ref_protected` is always `false`); default audience
`{PUBLIC_URL}/{owner}`; five minutes. Issuer `{PUBLIC_URL}/_services/token`
with discovery and JWKS. Signed ES256 with `ACTIONS_OIDC_KEY` (P-256 JWK,
`git-forge-node oidc-key`), else EdDSA with `INSTANCE_KEY` (not accepted by
AWS STS). Trust from AWS or Google Cloud is configured as for GitHub with
this issuer; not verified against real accounts.

#### GHES API (`/api/v3`)

Implemented for repositories: `POST …/actions/runners/generate-jitconfig`,
`POST …/actions/runners/registration-token` (and `remove-token`),
`GET …/actions/runners[?name=]`, `GET/DELETE …/actions/runners/{id}`,
`POST /api/v3/actions/runner-registration` (`RemoteAuth`), `GET
…/actions/runs[/{id}[/jobs]]`, `GET …/actions/jobs/{id}[/logs]`, `POST
…/actions/runs/{id}/cancel|force-cancel|rerun|rerun-failed-jobs`, `POST
…/actions/jobs/{id}/rerun`, `GET/POST …/actions/runs/{id}/pending_deployments`,
`POST …/actions/workflows/{file}/dispatches`, `…/actions/secrets[/{name}]`,
`…/environments[/{name}[/secrets[/{name}]]]`, `GET
…/tarball/{ref}`, `GET /api/v3/meta`. Reading runs, jobs, logs
and tarballs needs read access, cancel/re-run/dispatch need write access,
runners, secrets and environments need admin access.

Runners also exist per organization (`actions_runners.repo = ''`, admin of the
organization): `/api/v3/orgs/{org}/actions/runners[/{id}]`,
`…/generate-jitconfig`, `…/registration-token`, `…/remove-token`, and
`/orgs/{org}/actions/runner-groups[/1[/runners]]` with the single group
`Default` (id 1, the only accepted `runner_group_id`). Labels per runner:
`GET/POST/PUT/DELETE …/runners/{id}/labels[/{name}]`; `self-hosted`, OS and
architecture labels are `read-only`. `config.sh --url https://<forge>/<owner>[/<repo>]
--token …` works unchanged: the runner posts the token to
`/api/v3/actions/runner-registration` (it drops any port from the URL), gets
the service URL, which must be on the same host, and registers with
`POST _apis/v1/Agent/1` (lists with pool `0`); `config.sh remove` deletes
with a `remove-token`. Removed runners free their name. A runner claims
queued jobs of its scope only (its repository, or every repository of its
organization) whose labels it has.

Routing: a queued job goes to the built-in launcher unless a registered
runner of its scope (not bound to a job) has all its labels, or the launcher
does not serve them (`RunnerLauncher.labels`, `ACTIONS_RUNNER_LABELS` in the
Worker). Such jobs wait for that runner or for an external provider.

`workflow_job` events: dispatch reports `queued` (and `completed` for queued
jobs that are cancelled or abandoned), the service `in_progress` (first lock
renewal) and `completed` through `JobEventSink`; the Worker turns them into
forge events, so repository and organization webhooks receive them signed
(`X-Hub-Signature-256`) like every other event, and GitHub App installations
receive whatever the event fan-out routes to them. The REST API accepts any
principal the accounts layer authenticates (PATs, sessions, later
installation tokens); runner management needs admin rights on the repository
or organization.

#### Tokens and permissions

All CI credentials are random opaque tokens, stored only as SHA-256 hashes in
`actions_tokens`, with an expiry and a kind:

| Kind | Holder | Grants |
|---|---|---|
| `registration` | `config.sh` | Register one runner for one repository (1 h). |
| `runner` | Runner listener | Its own sessions, messages and job requests (1 h, renewed via OAuth). |
| `runtime` | Runner worker (`SystemVssConnection`), steps (`ACTIONS_RUNTIME_TOKEN`) | Timeline, logs and completion of exactly one job (plan id checked on every call); the results service (cache, artifacts, ID tokens) for that job. JWT-shaped with an `Actions.Results` scope, still verified only by hash. Revoked when the job completes. |
| `github` | Steps (`GITHUB_TOKEN`); action downloads | Read access to the job's repository over Git HTTP, or, for an action, to that action's repository (Git HTTP and tarball). Revoked when the job completes. |

The forge never trusts IDs from the runner: the runner is derived from the
token, a session must belong to that runner, a job request must be assigned to
it, and a runtime token must match the plan in the URL. Runner management
(REST) needs repository admin rights; until accounts are wired in, that is the
instance admin token.

#### Compute backends

`RunnerLauncher.launch({ jobId, encodedJitConfig, labels, … })` is the compute
adapter. The dispatcher creates one ephemeral JIT runner per queued job, binds
the job to it and calls the launcher; if the launch fails, the job is unbound
and stays queued for any registered runner with matching labels.

- **Cloudflare Containers (first backend):** billed per 10 ms while
  running, scale to zero, from `lite` (1/16 vCPU, 256 MiB) up to
  `standard-4` (4 vCPU, 12 GiB), rootless Docker-in-Docker (needed later for
  `container:` and `services:`). `RunnerContainer` is a Durable Object
  container class, one instance per job (`env.RUNNER.idFromName(jobId)`),
  that starts its container with the entrypoint `run.sh --jitconfig <config>`.
  A pending `monitor()` keeps the object in memory for at most 15 minutes, so
  it also sets the container's inactivity timeout to 6 hours (GitHub's job
  limit, the platform maximum) and watches the container again when the
  object is recreated (after a deploy or an eviction); the runner exits after
  its one job and the container stops then. The image (`runner/Dockerfile`,
  in the app and in the instance template, 2.4 GB unpacked) is the official
  `ghcr.io/actions/actions-runner` image plus Git and Node.js. Like every other
  resource it comes from the wrangler config (`containers`, the `RUNNER`
  Durable Object binding and its migration, in every environment of
  `apps/forge-worker`; in the instance template a documented opt-in, because
  every deploy then builds the image). The default instance type is `basic`
  (1/4 vCPU, 1 GiB, 4 GB disk): the smallest one whose disk holds the image,
  enough for the runner and small jobs; an instance picks a bigger one in its
  `wrangler.toml`.
  **Docker (`container:`, `services:`, `docker://`):** the stock runner puts
  job and service containers on a Docker network with aliases, which needs
  iptables; Cloudflare Containers run Docker-in-Docker but without iptables.
  So the image sets `ACTIONS_RUNNER_CONTAINER_HOOKS` to `runner/hook.js`, an
  implementation of the runner container hook protocol (`prepare_job`,
  `run_script_step`, `run_container_step`, `cleanup_job`). It starts the
  image's `dockerd` with sudo on first use (`--iptables=false`; `vfs` when the
  root file system is overlayfs), pulls with `registry` credentials, runs all
  containers with `--network=host`, adds every service name and
  `--network-alias` as `127.0.0.1` to the job container's `/etc/hosts`,
  waits for health checks (`--health-cmd` in `options`) like GitHub, execs
  `run` steps in the job container and removes everything labelled
  `git-forge-hook` at the end. The hook protocol does not pass service names,
  so the job message appends `--label=git-forge-service=<name>` to each
  service's `options`. With a shared network, ports are not remapped: a
  service listens on its own port (`ports: ['5433:5432']` still means 5432),
  and two services cannot use the same port. Jobs that need Docker are
  launched with `docker: true`; the Worker sends them to a second container
  class (`RUNNER_DOCKER`, bigger instance type) when it is bound.
  **Image source (decision, 18 Oct 2026):** the instance repository carries
  the Dockerfile and `wrangler deploy` builds it and pushes it to the account's
  Cloudflare registry; Workers Builds has Docker, so this works with the
  Deploy button and without a shell (verified on the production instance).
  Pre-built images are no alternative today: a `containers` entry with a
  single `image` accepts the Cloudflare registry, Docker Hub (public images
  without setup), Amazon ECR and Google Artifact Registry, not `ghcr.io`, so
  an image published with the release on GHCR cannot be referenced, and
  publishing to Docker Hub would need a Docker Hub account and credentials in
  the release workflow. If that becomes worth it (faster deploys), the
  release publishes `docker.io/<namespace>/git-forge-runner:<version>` and the
  template references it by tag. The release bundle is built with
  `wrangler deploy --dry-run --containers-rollout=none`, which skips the
  image.
- **Local process:** the integration test copies the downloaded runner into a
  temporary directory per job and starts it with `--jitconfig`. The same works
  on a Pi or against `wrangler dev`.
- **External providers:** WarpBuild Enterprise, AWS CodeBuild and RunsOn
  call `generate-jitconfig` / `registration-token` themselves after a
  `workflow_job` webhook (see "GHES API"). Tested with a mini provider that
  receives the `queued` webhook, calls `generate-jitconfig` and starts the
  real runner with `--jitconfig`; not yet tried with the real providers.

#### Secrets and environments

Three sources, later ones win on equal names: instance secrets from a
`SecretsProvider` adapter (the Worker reads the `ACTIONS_SECRETS` secret, a
JSON object), repository secrets and environment secrets. Repository and
environment secrets live in `actions_secrets`, encrypted with AES-256-GCM
under the instance key `ACTIONS_SECRETS_KEY` (32 bytes, a Worker secret);
the additional data binds each ciphertext to owner, repository, environment
and name, so rows cannot be swapped, and `key_id` (a hash prefix of the key)
detects a changed key. Names follow GitHub (`[A-Za-z_][A-Za-z0-9_]*`, not
`GITHUB_*`, stored upper case), values up to 48 KiB. The API takes the plain
value over HTTPS (`PUT …/actions/secrets/{name}` with `{"value": "…"}`);
GitHub's sealed boxes (libsodium) are not available with WebCrypto, so
`public-key` answers `501`. Values are only ever decrypted for a job
message and are sent marked secret, so the runner masks them in logs.

Runs have a `trusted` flag: pushes, dispatches and schedules are trusted,
pull requests are trusted only when the caller says so (the collaboration
package: head in the same repository). Untrusted runs get no secrets at all,
only the read-only `GITHUB_TOKEN`.

Environments (`actions_environments`) have required reviewers (logins).
A job leg with such an environment waits (`approval = 'waiting'`, run status
`waiting`) until a reviewer approves via `POST …/runs/{id}/pending_deployments`
(`{ environment_ids, state }`, the reviewer must be listed); rejected legs
fail. Environment secrets are only sent once approved. The UI will use the
same functions (`reviewDeployment`).

#### Data

- SQLite, migrations `packages/accounts/migrations/0005_actions.sql`,
  `0009_actions_workflows.sql` and `0013_actions_results.sql`, applied by the
  Worker on start like every other migration and shipped in the release bundle and its
  `migrations.tar.gz`: `actions_runners`, `actions_tokens`,
  `actions_sessions`, `actions_runs` (plus definition, attempt, trusted,
  concurrency group, cancellation, completion), `actions_jobs` (plus
  attempt, `expanded`, matrix, outputs, environment, approval,
  cancellation, launches, check run), `actions_timeline_records`,
  `actions_logs`, `actions_secrets`, `actions_environments`,
  `actions_schedules`; `0013`: blobs, blocks, parts, grants, caches,
  artifacts, variables. `0009` only adds columns and tables,
  so the previous release keeps working on the new schema.
- Bucket, append-only, written with `If-None-Match: *`:
  `repos/<owner>/<repo>/actions/jobs/<jobId>/logs/<logId>/<chunk>`,
  `…/console/<recordId>/<startLine>` and
  `…/attachments/<recordId>/<type>/<name>`; cache and artifact parts under
  `repos/<owner>/<repo>/actions/caches/<blobId>/blocks/<uuid>` and
  `…/actions/artifacts/<blobId>/blocks/<uuid>`. Like the rest of the bucket
  layout this is a durable format.

#### Status and known gaps

- The real runner runs in CI (`packages/actions/test/runner.integration.test.ts`):
  `actions/checkout@v4` from a mirror of `github.com/actions/checkout` on
  the forge, a matrix with job outputs through `needs`, a masked secret,
  `wrangler deploy --dry-run`, the cancellation of a running job,
  `actions/cache@v4` (v1 and v2), an ES256 ID token verified against the
  JWKS, and `upload-artifact@v4` → `download-artifact@v4` on `forge.localhost`.
- Deployed on Cloudflare Containers on the production instance (image
  built by Workers Builds, `basic` instances, `ACTIONS_GITHUB_FALLBACK` for
  `actions/checkout`).
- `container:` and `services:` run on the real runner with the container
  hook against local Docker (`node:22` job container, a `postgres` service
  queried as `postgres:5432`, a `docker://` step); a runner registered with
  `config.sh` and a provider's JIT runner run jobs against `wrangler dev`
  (`apps/forge-worker/test/e2e/runners.e2e.test.ts`). Docker-in-Docker on
  Cloudflare itself is not verified yet.
- Not supported yet: reusable workflows,
  organization variables, `hashFiles` server-side, wait timers and branch
  policies of environments, re-running single matrix legs.
- Broker / run service (v2 flow) and message encryption with the session
  key: not needed for cache, artifacts or ID tokens (see "Results service");
  only needed if a future runner drops the legacy flow for GHES.
- Official artifact actions v4 (and so `upload-pages-artifact`) only on
  `*.localhost` hosts; artifacts v3 not implemented (see "Results service").
- Web UI for runs, logs and reviews.

### Deployment

Deployments run in our own CI: a job calls `wrangler deploy` with a Cloudflare
API token stored as a secret. No Cloudflare Workers Builds and no
GitHub mirror are needed.

For example:

```yaml
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: [self-hosted, linux]
    environment: production
    steps:
      - uses: actions/checkout@v4
      - run: npm ci && npx wrangler deploy
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
```

`actions/checkout` comes from a mirror on the forge (see "Actions" above),
`CLOUDFLARE_API_TOKEN` is an environment secret of `production`.

### Distribution, new instances and updates

An instance is a stateless deployment; its operators choose the version. The
deployable unit is a release artifact, not an npm package, and instances never
update themselves.

- **Release artifact** (`release/build-release.sh`, run by
  `.github/workflows/release.yml` on every `v*` tag with `GITHUB_TOKEN` only):
  - `git-forge-worker.mjs`: `apps/forge-worker` built by `astro build` and the
    result bundled by `wrangler deploy --dry-run` into one ES module whose
    only imports are workerd built-ins (`cloudflare:workers`), uploaded by
    instances with `no_bundle: true`, so workerd runs exactly the released
    bytes. The web UI is part of it (§18); there is no separate asset
    directory.
  - `migrations.tar.gz`: the D1 migrations (`migrations/*.sql`, currently from
    `packages/accounts`), built reproducibly.
  - `SHA256SUMS`: `sha256sum` output for both files.
  - The release notes contain the pin `V=<version> S=<sha256 of SHA256SUMS>`
    and the complete `[build]` command line of the template with it. Tags
    with a `-` are pre-releases.
- **One pin covers everything:** `V` and `S` at the start of the instance's
  `[build]` command. The command downloads `SHA256SUMS` and
  `git-forge-worker.mjs`, checks `SHA256SUMS` against `S` and the bundle
  against `SHA256SUMS` (`sha256sum -c --ignore-missing`, so assets the
  instance does not download are skipped); any mismatch fails the build
  before anything is deployed. Asset names and the archive layout are a
  durable format: later releases may add assets, never rename or remove
  these. `migrations.tar.gz` is no longer needed by Workers instances (the
  bundle embeds the migrations) but stays published.
- **Instance template** (`templates/instance`, deployed straight from this
  monorepo): a single `wrangler.toml` (Worker name, `main =
  "dist/git-forge-worker.mjs"`, `no_bundle`, the pinned `[build]` command,
  bindings by name, queues, cron, `limits.cpu_ms`), `.dev.vars.example`
  (`BOOTSTRAP_TOKEN`), the optional `runner/Dockerfile` for CI and a README.
  No `package.json`, no lockfile, no scripts, nothing from npm in the Worker;
  the command needs only `sh`, `curl` and `sha256sum`. All vars (OIDC,
  `PUBLIC_URL`, email, …) are optional and documented in the README, not
  declared. `GIT_FORGE_RELEASE_URL` overrides the download base for mirrors
  and tests. The production instance `levino/levins-git-forge` is a copy of it
  with its own names, domain and OIDC vars.
- **Resources only from config:** every Cloudflare resource is declared in
  `wrangler.toml` by name, without id, so later deploys find it by name. The
  first `wrangler deploy` would provision missing ones (automatic resource
  provisioning) in an arbitrary region, so the README has them created first
  with a location (`d1 create --location`, `r2 bucket create --location`,
  `queues create --jurisdiction eu`); `[placement] mode = "smart"` keeps
  requests next to them. The
  jobs queue is recognised by the suffix `-jobs`. Cron and routes (custom
  domains) are declared there as well. The `BOOTSTRAP_TOKEN` secret is
  deliberately not `secrets.required`: a secret can only be set on an existing
  Worker, so requiring it would block a first deploy without the button. Until
  it is set `/api/bootstrap` answers `503`.
- **Build on Cloudflare (Workers Builds):** no build command in Workers
  Builds, the default deploy command `npx wrangler deploy`, which runs the
  `[build]` command from `wrangler.toml` and uploads the verified bundle. There
  is no migration step: the Worker migrates itself on start (§11), so
  migrations are additive and compatible with the previous release, which
  keeps a rollback (reverting the pin) safe.
- **First install:** the "Deploy to Cloudflare" button points at the
  subdirectory `https://github.com/levino/git-forge/tree/main/templates/instance`.
  Cloudflare copies that directory (it is self-contained) as the root of a new
  repository in the user's account, offers to rename the resources from
  `wrangler.toml`, asks for `BOOTSTRAP_TOKEN` (from `.dev.vars.example`),
  connects Workers Builds and deploys. Without OIDC one call of
  `POST /api/bootstrap` with the token creates the first instance admin (§8);
  with OIDC a one-time `instance_admin_claims` row inserted with
  `wrangler d1 execute` does.
- **Update:** change `V` and `S` and push. `/-/admin` shows the running
  version (`release/VERSION`, or `GIT_FORGE_VERSION` at build time, compiled
  into the bundle) and the latest release (the redirect of
  `github.com/levino/git-forge/releases/latest`, no API rate limit, cached six
  hours in `instance_settings`) with its pin, `S` computed by hashing the
  release's `SHA256SUMS`. With a fine-grained GitHub token for the instance
  repository (contents read/write, stored sealed) **Update** commits the new
  pin to its `wrangler.toml` through the contents API, which triggers Workers
  Builds. Without a token, the template's
  `.github/workflows/update-git-forge.yml` opens the same change as a pull
  request daily. There is no Renovate integration:
  Renovate could bump `V` but cannot compute `S` (the `github-releases`
  datasource's digest is the tag's commit, not a file hash), and a
  half-updated pin only fails the build.
- **Template pin:** the template must always pin a published release, because
  the Deploy button deploys it as is. After every release that is not a
  pre-release the `pin-template` job of `.github/workflows/release.yml` writes
  the new `V` and `S` into `templates/instance/wrangler.toml` and pushes that
  commit to `main` with `GITHUB_TOKEN`.
- **Test:** `release/test/instance.test.ts` builds a release, checks the
  template's shape (one pin, resources by name only, `BOOTSTRAP_TOKEN` as the
  only secret), runs the `[build]` command from `wrangler.toml` against the
  release via `file://`, checks that a wrong pin and a tampered bundle are
  refused, then starts `wrangler dev` on the template (which runs the build
  command too), checks that the Worker migrated its database by inserting an
  admin claim, and does a push/clone smoke test and a page request.
- The same bundle may additionally be published to npm later; the template
  never depends on it.
- **Without Cloudflare:** every release also carries
  `git-forge-node-linux-x64` and `git-forge-node-linux-arm64` (single
  executables of `apps/forge-node`, built with Bun, version from
  `release/VERSION`) and `NODE-SHA256SUMS`. They need no template: install the
  executable, run `migrate`, start `serve` (systemd units and a Dockerfile in
  `apps/forge-node`).
- **Container image:** the `image` job of the release workflow pushes
  `apps/forge-node/Dockerfile` for `linux/amd64` and `linux/arm64` to
  `ghcr.io/levino/git-forge-node` (`<version>`; releases also
  `<major>.<minor>` and `latest`) with `GITHUB_TOKEN`.

### Test instances

`apps/forge-worker` defines three wrangler environments `alpha`, `beta` and
`gamma`, each with its own D1 and R2. An E2E test runs all three locally and
checks mirroring and federation across them (beta mirrors alpha, gamma mirrors
beta).

## 16. Notifications, webhooks, email and releases

Packages: `@git-forge/notifications` (events, subscriptions, inbox, digests,
webhooks), `@git-forge/releases`, `@git-forge/ses`; the email interface lives
in the core (`packages/core/src/email.ts`). Tables come from migration
`0007_notifications.sql`.

### Events

Every producer describes what happened as a `ForgeEvent` (version `v: 1`):
the GitHub webhook event name and action, repository, actor, base URL, the
GitHub-compatible payload *without* `repository`, `organization` and `sender`
(those are rendered at delivery time), and optionally a notification
`subject` (key, type, title, URLs) and an `audience` (author, participants,
mentions, assignees, requested reviewers, CI actor, repository admins, which
watchers). `emit(event)` appends it to `forge_events` (append-only, enforced
by triggers like `audit_log`) and enqueues one `notification-event` job; the
job fans out webhooks and notifications. Jobs carry ids only, so a retry
re-reads the database.

Builders in `events.ts` produce the events, so payloads look the same
wherever they come from:

| Producer | Event | Status |
|---|---|---|
| `receive-pack` (`onPush`) | `push`, `create`, `delete` | wired; commits are read from the object database (at most 20, oldest first, stopping at the old value or, for new branches, at other branch tips); `added`/`removed`/`modified` stay empty |
| Mirror sync (`onSynced` in `MirrorContext`) | `mirror_alarm` (custom) on rewritten or deleted upstream refs | wired |
| Actions (`onJobCompleted`) | `workflow_job` completed, `workflow_run` completed when the last job of the run completes | wired; CI part 2 may refine it |
| Releases | `release` (`created`, `published`, `released`/`prereleased`, `edited`, `unpublished`, `deleted`) | wired |
| Collaboration (issues, pull requests, reviews, comments) | `issues`, `issue_comment`, `pull_request`, `pull_request_review`, `pull_request_review_comment` | builders ready, emitted by the collaboration package |

### Notifications

GitHub's model, per user:

- **Watching** a repository (`repository_watches`): `all`, `releases` or
  `ignore`; without a row the user is only notified when participating.
- **Participating** (`thread_subscriptions`): author, commenter, mentioned,
  assigned or requested reviewer of a subject (`issue:12`, `pull:3`, …) are
  subscribed to it and notified about later events on it. A thread can be
  ignored.
- **Fan-out** (`resolveRecipients`, pure): the strongest reason wins
  (`review_requested` > `assign` > `mention` > … > `subscribed`); ignored
  threads and ignored repositories receive nothing; the actor gets nothing
  unless `own_activity` is on; every recipient must still be able to read the
  repository, checked with the same `checkRepositoryAccess` as Git.
- **Inbox:** one `notification_threads` row per user and subject, updated in
  place (unread again, newest reason, `last_event_id`). Mirror alarms go to
  repository admins with reason `security_alert`, CI results to the
  triggering user with `ci_activity`.
- **Settings** (`notification_settings`): email `off`, `instant`, `hourly` or
  `daily`; email for participating and/or watching notifications; own
  activity; an optional address overriding the account email.

### Email

`EmailSender.send(message)` is the adapter (`createMemoryEmailSender` for
tests, `createConsoleEmailSender` for development, `createSesEmailSender` for
production, `createSmtpEmailSender` from `@git-forge/smtp` for the Node
deployment). SES uses the v2 `SendEmail` API with a simple message (subject,
text, HTML, `List-Unsubscribe` and auto-reply suppression headers), signed
with SigV4; `4xx` answers are permanent (`EmailRejectedError`), throttling
and `5xx` are retried by the job queue. SMTP (`@git-forge/smtp`, `node:net`
and `node:tls`, Node only): one connection per message, STARTTLS (required),
implicit TLS or plain without credentials, `AUTH PLAIN`/`LOGIN`, MIME with
base64 parts. `5xx` throws `EmailRejectedError`, everything else `SmtpError`
(retried). Cloudflare (`createCloudflareEmailSender`, `send_email` binding
`EMAIL`): the structured `send()` form; rate, quota, internal and delivery
errors are retried, every other error code is permanent. With the binding
and no `EMAIL_PROVIDER` the Worker uses it, sending from `EMAIL_FROM` or
`Forge <forge@<PUBLIC_URL host>>`; without either address email stays off.
Arbitrary recipients need Workers Paid; on the free plan only verified
Email Routing destinations receive mail. `POST /api/admin/email/test` (and
the button on `/-/admin`) sends a test message through the same sender.

Digests: when a notification should be emailed, the user's
`digest_due_at` is claimed by compare-and-swap (`… WHERE digest_due_at IS
NULL`) and one `notification-digest` job is enqueued with the mode's delay
(0, 1 h, 24 h). The job collects every unread thread updated since it was
last emailed, sends one message, marks the threads, releases the claim and
schedules the next digest if something arrived meanwhile. So a burst of
events makes one email per user and period, and a lost job is picked up by
the daily cron (`sweep`).

### Webhooks

GitHub-compatible, per repository and per organization (an organization hook
receives the events of all its repositories):

- REST under `/api/v3`: `…/hooks`, `…/hooks/{id}`, `…/hooks/{id}/config`,
  `…/hooks/{id}/pings`, `…/hooks/{id}/deliveries[/{id}[/attempts]]`.
  Managing repository hooks needs repository admin, organization hooks an
  organization owner (instance admins may do both), with a token that has
  `repo:admin`.
- Requests: `POST` with `Content-Type` `application/json` or
  `application/x-www-form-urlencoded` (`payload=…`), `User-Agent:
  GitHub-Hookshot/git-forge`, `X-GitHub-Event`, `X-GitHub-Delivery` (a UUID),
  `X-GitHub-Hook-ID`, `X-GitHub-Hook-Installation-Target-Type`/`-ID` and,
  with a secret, `X-Hub-Signature-256` (HMAC-SHA256 of the body) and the
  legacy `X-Hub-Signature` (SHA-1). Creating a hook sends a `ping`.
- Delivery log (`webhook_deliveries`): the payload is rendered once per event
  and hook and stored; each attempt records status code, duration, request
  headers (without signatures) and up to 64 KiB of the response.
  Redirects are not followed, the timeout is 10 s.
- Retries: network errors, `408`, `429` and `5xx` are retried up to five
  attempts with 30 s, 2 min, 8 min, 32 min; other answers fail at once. The
  retry is a new delayed job, and a lease on the delivery row
  (`next_attempt_at`) keeps a duplicate job or the cron sweep from sending
  twice. Redelivery creates a new row with the same delivery id and
  `redelivery: true`, as on GitHub.
- URLs must be `https` and must not point to loopback, private, link-local
  or `.local`/`.internal` hosts; `ALLOW_INSECURE_WEBHOOKS=true` lifts both
  for tests. DNS is not resolved, so a public name pointing to a private
  address is not caught (on Workers such requests cannot reach private
  networks anyway; on a Node deployment, egress filtering is the operator's
  job). `insecure_ssl` is stored but has no effect: Workers always verify
  TLS.
- Secrets are stored in plain text in the database, because signing needs
  them; the API shows them as `********`.
- Repository and user ids in payloads are the forge's string ids, not
  integers.

Without a job queue (a Node deployment without one) fan-out, deliveries and
instant digests run inline in the request; retries and delayed digests then
wait for the scheduled handler.

### Releases

- GitHub's REST API under `/api/v3/repos/{owner}/{repo}/releases`: list,
  create, get, `latest`, `tags/{tag}`, update, delete; assets: list, upload,
  get, update, delete; uploads also at
  `/api/uploads/repos/{owner}/{repo}/releases/{id}/assets?name=&label=` (the
  `upload_url` that `gh` and Octokit use).
- Reading needs repository read access; drafts and all writes need write
  access. Instance admins may write everywhere.
- Publishing a release whose tag does not exist creates a lightweight tag at
  `target_commitish` (branch or commit, default branch by default) with a
  compare-and-swap on `refs.json`, then runs the push pipeline (mirror
  notifications, CI, `create` and `push` events) as if the tag had been
  pushed. Drafts never create tags.
- **Assets are LFS objects.** An upload streams into
  `lfs/objects/<sha256>` and is served by the immutable media URL
  `/{owner}/{repo}/media/{oid}/{name}` (§7: `Range`, ETag, CDN friendly). The
  key is the SHA-256 of the content, which is only known at the end of the
  stream, and `put` needs the key first: a client that sends
  `X-Content-SHA256` (hex) is stored directly and verified while streaming;
  otherwise the upload is staged in `tmp/` while hashing (expired by the
  bucket lifecycle rule like push staging) and then copied, unless the object
  already exists. Assets are limited to `MAX_LFS_OBJECT_BYTES`, and the API
  reports `digest: "sha256:…"` like GitHub.
- `browser_download_url` (`/{owner}/{repo}/releases/download/{tag}/{name}`)
  and `GET …/releases/assets/{id}` with `Accept: application/octet-stream`
  answer `302` to the media URL and count the download. A draft's asset is
  reachable through its media URL by anyone who can read the repository and
  knows the hash.
- Not implemented: `tarball_url`/`zipball_url` (no archive endpoint yet),
  `generate_release_notes`, `make_latest` (the latest release is the newest
  published non-prerelease).

## 17. Collaboration

Issues, pull requests, reviews, commit statuses, check runs and discussions
(`@git-forge/collaboration`, API in its
[README](../packages/collaboration/README.md)). Decisions:

- **Database only, never synced.** All collaboration data lives in the
  instance's SQLite database (migration `0008_collaboration`). Nothing of it
  is written to the bucket, so a mirror or a plain bucket clone carries no
  issues or reviews (§4). Pull requests keep their head and base shas in the
  database; there are no `refs/pull/*` refs. The only Git writes are merge
  results, which are repository content like any push.
- **GitHub semantics and shapes.** Every pull request is an issue; issues,
  pull requests and discussions share one number sequence per repository.
  Roles are GitHub's (read, triage, write, maintain, admin); readers may open
  issues, pull requests and discussions and comment unless the repository
  turns `read_can_participate` off. The REST API under `/api/v3` uses
  GitHub's paths and JSON shapes where reasonable, so existing tools work;
  IDs are integers except users and repositories. Markdown bodies are stored
  raw; rendering is the UI's job.
- **One permission function.** `allowed(permission, subject)` is pure; the
  subject comes from the verified token or session (`openRepository`), never
  from the request body. Read-only tokens never mutate.
- **Push tracking without a hook dependency.** Pull requests compare their
  stored shas with `refs.json` on every read and on every push
  (`handlePushedRefs` from `onPush`). A moved head records an event and,
  with `dismiss_stale_reviews`, dismisses approvals; a base branch that
  contains the head marks the pull request merged; commits pushed to the
  default branch close issues they reference with a closing keyword. Ancestry
  walks for this are bounded (1000 commits).
- **Diff and merge in core, identical to git.** `xdiff.ts` is a port of
  git's xdiff (Myers with git's heuristics, record cleanup, change
  compaction) and of its zealous three-way line merge, so line diffs and
  clean/conflict decisions match `git diff` and `git merge-file` byte for
  byte (checked against git on randomized inputs). `diff.ts` adds tree diffs
  with exact-rename detection, binary detection (a NUL in the first 8000
  bytes, like git), LFS pointer detection and git's patch format.
  `merge.ts` computes merge bases (with a virtual merge base for criss-cross
  histories, as `ort` does), the three-way tree merge (trivial cases, mode
  merge, text merge, modify/delete, directory/file) and the three methods:
  merge commit (parents base and head), squash (parent base), rebase
  (cherry-picks parents first, drops commits that become empty, refuses
  merge commits). Results are compared commit by commit with `git merge
  --no-ff`, `git merge --squash` and `git rebase --force-rebase`. Renames
  are detected like `merge-ort` does (`rename.ts`, a port of
  `diffcore-rename`): per side, base→side deletions are rename sources and
  additions destinations (empty files excluded); only sources whose other
  side changed or removed the file are relevant; exact matches first, then
  same-basename pairs at 75% similarity (with git's directory hint for
  non-unique basenames), then the similarity matrix at 50% (git's span-hash
  score, four candidates per destination, stable sort, greedy pairing,
  rename limit 7000). A rename on one side with an edit on the other merges
  the content at the new path; both sides renaming to the same path merge
  there; rename/delete, rename/rename to different paths and rename/add are
  conflicts. Similarity scores are checked against `git diff -M` and
  randomized rename histories against `git merge`, `git merge --squash` and
  `git rebase`. Where git's result could depend on its hash-map iteration or
  traversal order (several identical files competing for one rename, tied
  scores or tied directory hints) or the comparison budget (250 000 pairs) is
  exceeded, the relevant sources are reported as conflicts instead.
  Directory renames: a path the other side adds below a directory that one
  side removed is a `directory-rename` conflict when a file of that
  directory was renamed (git's default `merge.directoryRenames=conflict`),
  and merges cleanly when it was only deleted. Sources in such directories
  are always considered for renames. The merge is therefore never clean
  where git conflicts, and identical where both are clean.
- **Branch protection on merge.** The merge calls the same
  `evaluateBranchUpdate(rule, actor, update, { via: 'pull-request', … })` as
  receive-pack, with approvals from reviewers with write access (the
  author's own reviews never count), requested changes, the last-push
  approval, the strict up-to-date flag and the latest statuses and check
  runs of the head. `require_code_owner_reviews` reads `CODEOWNERS` from
  the base branch (GitHub's locations and syntax; patterns are gitignore
  patterns, checked against `git check-ignore`, except that a final `/*`
  does not reach into subdirectories, as GitHub documents) and needs an
  approval from an owner of every changed owned file; user owners are
  requested as reviewers automatically. Required status checks on direct pushes
  still see no statuses (the push policy is synchronous); the pull request
  is the path that satisfies them.
- **Statuses and check runs** are stored here and written by CI (directly
  through `recordCommitStatus` / `recordCheckRun`) or by anyone with write
  access through the API.
- **Hooks.** After a merge the host's `onBranchUpdated` runs the same
  pipeline as a push (CI dispatch, mirror notifications, `push` events).
  Every mutation reports an activity (`onActivity`) that the Worker turns
  into notification events (§16: `issues`, `issue_comment`,
  `pull_request`, `pull_request_review`, `pull_request_review_comment`,
  `discussion`, `discussion_comment`);
  the collaboration package itself does not depend on the notifications
  package.
- **Forks.** `POST /repos/{o}/{r}/forks` creates a fork on the same
  instance (bucket: alternates, §6; database: `repository_forks` with parent
  and root, migration `0011_forks`). Anyone with read access may fork into
  their own account or an organization they own; the fork has the
  upstream's visibility and is an independent repository (its own
  collaborators; upstream collaborators get no access to a private fork).
  Pull requests may use a head from another repository of the same fork
  network (`head: owner:branch`, `head_repo` when an owner has several).
  Their head objects are copied into the base repository when the pull
  request is opened and whenever the head moves (a pack streamed from the
  head repository, like GitHub's `refs/pull/N/head` but without a ref), so
  diffs, reviews, merges and CI read only the base repository and the base
  never depends on the fork. LFS objects of pointers in the copied pack are
  copied with it (content-addressed, written once, hash verified). Pushes to
  a fork refresh the pull requests it heads. With `maintainer_can_modify` (set by the author) users with write
  access to the base may push to that one head branch of the fork, and
  read the fork, through a `delegatedBranches` hook of the git access check;
  every other ref stays denied. CI for pull requests from forks runs
  untrusted (`trusted: false`: no secrets, read-only token).
- **Imported data** (§7 *metadata*). Numbers, authors and times are kept.
  Every imported item has an `imported_items` row (node id, source key
  such as `issue:7` or `review-comment:301`, original URL, author login,
  time, unmapped assignees), which also makes re-runs idempotent. GitHub
  users map to forge users by login, else by an `email` in the payload;
  unmapped authors are stored as `github:<login>` and shown by login,
  unmapped assignees from `imported_items`. A pull request stays one when
  its head and base commits exist (and it is closed or from the same
  repository); otherwise it becomes an issue with a note. Review comments
  that do not anchor (`validateAnchor` on their original commit and line)
  become issue comments quoting path and line. Releases keep their times;
  assets are deduplicated by name.
- **Limits of v1.** Computing mergeability and file lists loads the involved
  objects through the in-memory object database, no reactions, no
  in-browser conflict resolution.

## 18. Web UI

The web UI is server-rendered Astro (`@astrojs/cloudflare`) inside the same
Worker as everything else. There is one Worker per instance and one release
bundle.

### Entry and routing

- `apps/forge-worker/src/worker.ts` is the Worker entry (`main` in
  `wrangler.jsonc`). Its `fetch` hands every request to Astro's handler; its
  `scheduled` and `queue` handlers and the `RunnerContainer` export are the
  same as before the UI (`src/cloudflare.ts`), so cron, queues and containers
  are unaffected by Astro.
- The Astro middleware (`src/middleware.ts`) is the router between the two
  worlds. `isForgePath` (`src/routing.ts`, pure) sends to `createForge`:
  `/api` and everything below (including `/api/v3`), `/_services/`,
  `/.well-known/`, `/login`, everything below `/login/` and `/logout` (the
  login routes of `@git-forge/accounts`, including the device flow), media
  and raw URLs (`matchContentRoute`), and Git paths
  (`matchGitRoute` with a `.git` suffix, or one of `HEAD`, `info/refs`,
  `git-upload-pack`, `git-receive-pack`, `objects/…`, `info/lfs/…`,
  `releases/download/…`). Every
  other path is a page. A catch-all page (`src/pages/[...path].astro`) makes
  sure every request reaches the middleware; it renders the 404 page.
- `UI=false` (var) skips Astro entirely: `fetch` goes straight to
  `createForge`, as before. This is the headless mode for backup mirrors.
  `createForge` itself knows nothing about the UI and stays usable on Node.
- Login pages: the login routes stay in `createForge` and keep all logic
  (OIDC, passkeys, invites, device flow, break-glass, cookies, CSRF). With
  the UI on, the Worker passes `renderLoginPage` (`src/ui/login-pages.ts`):
  it records the page model the login handler wants to show for that request
  and returns a marker response; the middleware then rewrites to the page
  `/-/login`, which renders the model with the site layout. Without the UI
  (or on Node) the plain built-in pages are used. The passkey ceremony script
  is the one exported by `@git-forge/accounts` (`PASSKEY_SCRIPT`).
- Pages hosts (§20) never reach Astro: `worker.ts` hands every request whose
  host matches `PAGES_HOST` or `PAGES_DOMAINS` to `createForge` directly.
  `/_pages/` (the Pages session handoff) is a forge path on the forge host.
- Reserved first path segments: `api`, `explore`, `search`, `login`, `logout`,
  `settings`, `notifications`, `organizations`, `orgs`, `new`, `-` (assets,
  login and admin pages) and the other page routes. Account names must not
  use them: `RESERVED_LOGINS` of `@git-forge/accounts` is checked when an
  organization is created and when an instance admin creates a user (names
  with characters outside `LOGIN_PATTERN`, such as `-` or `.well-known`, are
  invalid anyway).

### Permissions

Pages get `Astro.locals.forge` (`ForgeServices`: storage, accounts store,
`authenticate`, `repositoryAccess`, `isInstanceAdmin`) and
`Astro.locals.principal`, set by the middleware from the verified credential
of the request: the session cookie (`readActiveSession`) or, without one,
the `Authorization` header, as for the API. Repository pages call `repositoryAccess(principal,
repo, role)`, the same function the JSON API uses for its admin checks, which
wraps `checkRepositoryAccess` from `@git-forge/accounts` and adds instance
admins. Private repositories answer 404 to visitors who may not read them,
like the Git endpoints. Lists and search filter in SQL with the same rules
(see *Lists and search*).

Writes from pages (settings forms) need the session and its CSRF token:
`verifySessionWrite` is `checkSession` of the login package (same origin and
the token derived from the session id, from the `csrf` form field or the
`X-CSRF-Token` header). Account operations (`services.account`: list, create
and revoke own tokens, list and remove own passkeys) take the session's user
and never a client-supplied account. The same holds for the inbox
(`services.inbox`: threads, mark read, mark done, mark all read, all scoped
to the session's user id); releases (`services.releases`) are read through
the release store after the repository's read check, drafts only with write
access, as in the releases API. Media and raw URLs also accept a browser
session for reads (`GET`/`HEAD`, checked with `repositoryAccess`), so LFS
previews work in private repositories.

Repositories are created and imported through `services.repositories`
(`owners`, `create`, `startImport`, `importStatus`), the same functions the
API routes `POST /api/repos` and `POST|GET /api/repos/{owner}/{repo}/import`
call; the API additionally requires a session or a token with `repo:admin`
(`requireManager`), the page `/new` a session write. A user may create
repositories in their own account and in organizations they own; instance
admins in any account. The import status page `/{owner}/{repo}/import` needs
repository admin and refreshes itself while the import runs; an empty
repository links to it for repository admins while an import exists. The
access token entered for an import goes only into the queued job, never into
the stored import state or a page.

All UI writes must also come from the same origin:
`isCrossSiteWrite` rejects UI requests whose `Origin` or `Sec-Fetch-Site`
says otherwise (Astro's own `checkOrigin` is off because it would also apply
to Git and API paths, which non-browser clients call without an `Origin`).

### Read model

Repository browsing uses pure functions in `@git-forge/core`
(`browse.ts`, `diff.ts`): `resolveRefAndPath` (refs with slashes, tags,
full commit ids; the mirror view of `advertisedRefs`), `resolveTarget`,
`readBlobContent` (text, binary, LFS pointer), `commitLog` (date order,
path filter, paging, at most 10 000 commits walked per call), and for
commit diffs `diffTrees` and `diffFile` of the shared diff module (git's
xdiff, §17), the same code pull requests use.
They read through `ObjectDatabase` like the Git endpoints. The UI layer
(`src/ui/*.ts`) only composes them into view models; `.astro` files only
render.

Blame (`/{owner}/{repo}/blame/{ref}/{path}`) is `blame` in core: newest
commit first, lines unchanged against a parent pass to it (the first parent
that has them wins at merges, as in git), the rest belong to the commit. No
rename, move or copy detection; files up to 512 KiB. Each `depth` step walks
500 more commits (at most 20 steps, *Load more history*); lines not reached
show *Older history not loaded*. Tested against `git blame`.

### Lists and search

- **Repository lists** (home, explore, profiles, `GET /api/repos?owner=&sort=updated|name&page=&per_page=`)
  are one query: `listReadableRepositories` of `@git-forge/accounts`.
  `readableRepositories(principal)` is the SQL form of `resolveAccess` plus
  the instance-admin rule of `repositoryAccess` (public, owner,
  collaborators, organization owners, members with a base role or a team
  role, apps, granted instances with `git:read`, token ceiling and
  repository list); a test compares it with `checkRepositoryAccess` for every
  principal kind. Sorting by last commit or name, `LIMIT/OFFSET` paging,
  total via `count(*) OVER ()`.
- **Stored summary.** `repositories.default_branch`, `last_commit_at`
  (committer time of the default branch head, ms) and `stats_at` (migration
  `0026`). `refreshRepository` rewrites them after every push (also merges and
  release tags), every mirror sync with ref updates and every import step.
  Rows without `stats_at` (repositories from before `0026`) are filled the
  first time a list shows them; after that lists read no storage.
- **Full-text search** with FTS5 (migration `0026`): `search_repositories`
  (owner, name, description, topics; the last two stay empty until
  repositories have metadata), `search_accounts` (login, display name) and
  external-content tables over `issues` (title, body; pull requests
  included), `issue_comments`, `discussions` and `discussion_comments`.
  Triggers update them inside the writing statement; the migration backfills,
  `POST /api/admin/search/rebuild` (instance admins) rebuilds. Review
  comments are not indexed.
- **Queries.** Words become prefix terms (`"word"*`, all must match, at most
  12); qualifiers `repo:owner/name`, `user:`/`org:`, `is:issue|pr|open|closed`.
  Ranked by bm25, filtered with `readableRepositories`, disabled owners
  hidden, issues need `has_issues` (pull requests always), discussions
  `has_discussions`. `GET /api/search?q=&type=repositories|issues|discussions|users&page=&per_page=`
  and `GET /api/v3/search/{repositories,issues,users}` answer with GitHub's
  `{ total_count, incomplete_results, items }` and reduced item shapes; the
  page `/search` and the navbar box call the same `search`.

### Collaboration pages

Issues, pull requests and discussions call the service functions of
`@git-forge/collaboration` directly with a scope from `services.collaboration`
(its `openRepository` with the same options as the `/api/v3` handler, so
activity reaches notifications, webhooks and CI the same way). Buttons and
forms are shown with the package's `can(scope, permission)`; every write
goes through the service function, which checks the permission again, after
`verifySessionWrite`. Collaboration errors are shown on the page with their
status. Links that come from the API (check run `details_url`, status
`target_url`) are rendered only for `http(s)` URLs.

Forks: the repository header has a *Fork* button (`…/fork`: owner and
name, `createFork`), the fork count (`…/forks`, with a *Compare* link per
fork) and, on a fork, *forked from* with a *Contribute* link. *New pull
request* takes `head_repo` (any readable repository of the fork network)
and offers that repository's branches; *Allow edits by maintainers* sets
`maintainer_can_modify`.

Inline review comments on the *Files changed* tab use the only client script
of these pages: a click on a line's `+` clones a `<template>` form below the
row with path, line and side filled in; the form posts to the page like every
other form.

### Repository settings

`/{owner}/{repo}/settings` (repository admins) changes visibility,
collaborators, branch protection, mirrors and federation grants. The JSON
API routes and the page call the same principal-based operations in
`createForge` (`services.settings`: `read`, `setVisibility`,
`setCollaborator`, `removeCollaborator`, `grantInstance`, `revokeInstance`,
`addMirror`, `syncMirror`, `verifyMirror`, `detachMirror`,
`branchProtection`, `setBranchProtection`, `deleteBranchProtection`); each
starts with the same admin check (`adminOf`: authenticated user, token with
`repo:admin`, `repositoryAccess(…, 'admin')`). The same object holds `setMetadata`
(description, website, up to 20 topics), `setArchived`, `move` (rename and
transfer to an account the actor may create repositories in) and `remove`,
behind `PATCH|DELETE /api/repos/{owner}/{repo}`, `POST …/transfer` and the
GitHub routes `PATCH|DELETE /api/v3/repos/{owner}/{repo}`, `…/transfer`,
`GET|PUT …/topics`. Archived repositories refuse every write below admin
(`archivedBlocks`: pushes, LFS uploads, issues). `services.renameAccount`
(`PATCH /api/accounts/{login}`, account page, organization page, admin page)
lets users rename themselves, owners their organizations and instance admins
anyone; reserved logins stay refused. Old names live in
`repository_redirects` and `account_redirects`: a 401/403/404 on a path of
an old name answers 301 (`GET`/`HEAD`) or 307 to the new one, for pages, the
API, Git and LFS, but only if the caller may read the target. Name-keyed
tables (actions, mirror subscriptions and checksums) are rewritten in the
same batch; the `search_repositories` triggers (migration `0028`) index
description and topics and follow renames. Branch protection forms are
translated into the GitHub-shaped JSON body and parsed by
`parseBranchProtectionSettings` of `@git-forge/accounts`, the parser of the
protection API. Errors carry the API's status (`ForgeError`) and are shown
on the page.

### Organizations and accounts

Organizations are managed through `createOrganizationOperations` of
`@git-forge/accounts`: any signed-in user (session, or a token with
`repo:admin`) may create one and becomes its first owner; owners and instance
admins (`canAdministerOrganization`) add and remove members, change roles
(the last owner cannot be demoted or removed), create teams, and set team
members and team repository roles; members see people and teams, everyone
else gets 404. `/organizations/new`, `/orgs/{org}` and
`/orgs/{org}/teams/{slug}` call these operations, and so does the JSON API
under `/api/orgs/{org}` (members, teams, team members, team repositories;
`OrganizationError` carries the status). The account page `/settings` also
lists linked OIDC identities (unlinking the last way to sign in is refused)
and active sessions (ending any but the current one); both operations take
the session's user and only touch that user's rows.

### Instance administration

`/-/admin` (instance admins only, 404 for everyone else; linked from the
account menu) lists and changes instance admins (the last admin cannot be
removed), trusted instances (issuer normalized by `normalizeIssuer`, optional
pinned key thumbprint) and shows every mirror of the instance with its
health (alarms, failed sync, failed deep check, last success), linking to the
repository's mirror settings. The page and the admin API (`GET|POST
/api/admin/instances`, `DELETE /api/admin/instances/{issuer}`, `GET
/api/admin/admins`, `PUT|DELETE /api/admin/admins/{login}`, `GET
/api/admin/mirrors`) call the same operations: `createInstanceAdministration`
of `@git-forge/accounts` (`view`, `setAdmin`, `trust`, `distrust`, each
starting with `canAdministerInstance`: a user principal without a token
ceiling below `admin` who is an instance admin) and `services.instance.mirrors`
in `createForge`, which runs the same check before reading the mirror configs
and statuses from storage. The mirror overview reads one config and one status
object per mirror; it is meant for the admin page, not for public listings.

The same page shows updates (§15), jobs and storage, and links to
`/-/setup` (OIDC and deployment checks). Page and API (`GET
/api/admin/overview`, `GET /api/admin/setup`, `PUT|DELETE /api/admin/oidc`,
`GET|POST /api/admin/update`, `PUT|DELETE /api/admin/update/repository`,
`POST /api/admin/jobs/{id}/retry`, `POST /api/admin/usage/recount`) call
`createAdminOperations` (`src/admin/operations.ts`), each starting with
`canAdministerInstance`. Tables from migration 0025:

- `instance_settings`: JSON values by name. Secrets (OIDC client secret,
  GitHub token, job credentials) are sealed with `sealSecret` of
  `@git-forge/actions` under `ACTIONS_SECRETS_KEY`, or without it a key
  derived by HKDF from `BOOTSTRAP_TOKEN`, so Deploy-button instances need no
  extra secret; a changed key makes them unreadable, never wrong.
- `job_failures`: `runJob` records a failed job keyed by the hash of its
  payload (credentials stripped and sealed), `retrying` until the last
  attempt, then `failed`; a later success deletes the row. *Retry* takes the
  row and queues the payload again. Queues cannot be listed through the
  binding, so in-flight jobs are not shown; imports are (phase and progress
  from each repository's `import/status.json`, running or finished within
  seven days).
- `storage_objects`, `repository_usage`: the storage passed to the forge is
  wrapped once, below `locatedStorage`; every successful `put` of a pack
  file or LFS object, and every LFS verify after a presigned upload, inserts
  its physical key (`INSERT OR IGNORE`), and a trigger adds its size to the
  git or LFS bytes of that storage path, which survives renames and
  transfers (joined with `repositories.storage_path` for the name; deleted
  repositories keep their bytes). Page views read one row per storage path,
  never the bucket.
  *Recount* queues one `usage-scan` job per repository that lists its packs
  and LFS objects, for data stored before the counter existed.
- `usage_counters`: requests, R2 class A (`put`, `list`) and class B
  (`get`, `head`) operations and D1 statements, counted in memory per
  isolate and added per month every 1000 events or 60 seconds; lost counts
  of an evicted isolate make the estimate rough.

**Setup checks** (`src/admin/setup.ts`, pure over measured facts): D1 and R2
latency (median of three requests; warning above 50 and 100 ms, with the
Worker's colo and D1's `served_by_region` and links to the location-hint
docs), presigned LFS (the exact dashboard steps), both queues, Actions and
runner containers, `PUBLIC_URL`, OIDC source.

**Cost estimate** (`estimateMonthlyCost` in `src/admin/costs.ts`, the only
place with prices): this month's counters extrapolated to 30 days plus the
stored bytes, at Cloudflare list prices: Workers Paid $5 with 10 M requests
included, then $0.30/M; R2 $0.015/GB-month above 10 GB, class A $4.50/M
above 1 M, class B $0.36/M above 10 M; D1 rows read $0.001/M above 25 B and
rows written $1.00/M above 50 M, assuming 20 rows read per query and 2 rows
written per write statement.

### Actions pages

`/{owner}/{repo}/actions` lists workflow runs, filtered by workflow
(`?workflow=<path>`; the side list holds every workflow that has runs, named
after its latest run). A run page lists the jobs of the current attempt
(refreshing every five seconds while the run is active), and a job page shows
the job log. Pages read through `services.actions`, which only returns runs
and jobs of the repository the page already checked with
`repositoryAccess(…, 'read')`; logs come from `readJobLog` of
`@git-forge/actions`, the same function as the GHES job log endpoint (stored
log chunks, or the live console lines while the job runs). The job page
strips ANSI escapes, shows at most the last 2 MiB and, while the job is not
done, polls `…/jobs/{job}/log.txt` every three seconds with a small inline
script; the response header `X-Job-Done` makes the page reload into its final
state.

Writers see *Cancel run* while a run is active and *Re-run all jobs*,
*Re-run failed jobs* and per-job *Re-run* once it completed. The forms post
to the run page with the session's CSRF token and call
`services.actions.cancel` and `services.actions.rerun`, which check read
access, that the run belongs to the repository, and write access through
`canWriteActions` (`repositoryAccess(…, 'write')`), then call `cancelRun`
and `rerunRun` of `@git-forge/actions`, the functions behind the GHES
`…/cancel`, `…/rerun`, `…/rerun-failed-jobs` and `…/jobs/{id}/rerun`
endpoints. The GHES write check uses the same `canWriteActions`, so instance
admins may cancel and re-run there too. A re-run while the run is still in
progress answers 409.

### Rendering

- Tailwind CSS with daisyUI, own themes `forge` (default) and `forge-dark`
  (`prefers-color-scheme`) in `src/styles/global.css`: neutral base, one blue
  accent, flat buttons, system font stack. Icons are inline Lucide paths
  (MIT) in `src/components/Icon.astro`; avatars are initials coloured from a
  hash of the name. The stylesheet is compiled at build time
  (`?inline`) and served by the Worker at `/-/style.css?v=<hash>` with an
  immutable cache header, so pages stay small and the release needs no asset
  directory.
- Syntax highlighting is server-side with shiki's JavaScript regex engine (no
  WebAssembly) and a fixed set of grammars; tokens carry light and dark
  colours as CSS variables. Files above 256 KiB or with unknown types are
  shown unhighlighted. Diffs highlight the old and the new side of each hunk
  separately. Fenced Markdown code blocks (`language-*`) are highlighted after
  `rehype-sanitize`, so only highlighter spans carry styles.
- Markdown (README, `.md` files) goes through remark/rehype with GFM and
  `rehype-sanitize` (GitHub's schema); relative links point to the blob view,
  relative images to the raw endpoint.
- LFS files are previewed through the media URL (images, video, audio, PDF),
  binary files through the raw URL at the commit id.
- Repository lists read each repository's `refs.json` and head commit for
  the default branch and the last update time. Tree views mark LFS files by
  the `filter=lfs` patterns of the `.gitattributes` files on the path.
- No client-side framework. Interactive bits use native elements
  (`<details>` dropdowns); islands are added only where a page needs them
  (passkey ceremonies, diff line comments, copy buttons).

### Tests

- `packages/core/test/browse.test.ts`: read model against a real pushed
  repository; `blame.test.ts`: blame against `git blame` across a merge.
- `packages/accounts-node/test/search.test.ts`: the SQL access filter against
  `checkRepositoryAccess`, FTS backfill, triggers and private repositories.
- `apps/forge-worker/test/unit/ui.test.ts`: routing split, origin check,
  Markdown sanitizing and link rewriting, highlighting.
- `apps/forge-worker/test/pages/`: pages rendered with Astro's container API
  against a Node forge (SQLite, memory storage) with a pushed repository
  (`vitest.pages.config.ts`).
- `apps/forge-worker/test/browser/`: Playwright (desktop and mobile Chromium)
  against `wrangler dev` running the built bundle, with a repository pushed by
  the real `git` and `git-lfs` clients, and a passkey sign-up from an invite
  with Chromium's virtual WebAuthn authenticator (settings, token create and
  revoke, sign-out, passkey sign-in), organizations and teams, repository
  settings, cancelling and re-running a workflow run (the runner launch fails
  under `wrangler dev`, so jobs stay queued), and the instance admin page.
- `apps/forge-worker/test/e2e/headless.e2e.test.ts`: the same bundle with
  `UI=false` serves only the forge.
- The release test requests a page from the template instance.

## 19. Backups

Mirrors (§4) are the federated copies; a backup is the operator's copy of
their own instance, kept somewhere that cannot be rewritten. The forge backs
itself up into a second storage target (`BACKUP` R2 binding in the Worker,
`BACKUP_STORAGE` on Node); the built-in database dump replaces `wrangler d1
export`, which refuses databases with FTS5 tables (§18). Backups are plain
copies, restorable without git-forge and without keys. Encrypted full
backups were built and dropped (PR #28).

**Run.** The scheduled run (Cron Trigger, `SCHEDULE` on Node) or "run now"
(`POST /api/admin/backup`, admin page) starts a run if none is active and
enqueues one `backup` job; each job does a bounded step (256 MiB or 2000
keys, 50 dump pages) and enqueues the next. State is one JSON row in
`backup_state`, advanced by compare-and-swap on `version`, so duplicate jobs
stop and a failed or lost job resumes from the cursor on the next scheduled
run. Order per run: database first, then objects, so every dumped row refers
only to objects that exist by the time they are copied.

**Database dump** under `backups/db/<id>/` (`<id>` = UTC `YYYYMMDDTHHMMSSZ`):
`0000-schema.sql` (tables), `<nnnn>-<table>-<page>.sql` (500 rows per page,
keyset by `rowid`, tables in creation order), `9999-indexes.sql` (indexes,
FTS5 tables, the search index rebuild, triggers, views), then
`manifest.json` when the run is complete. One statement per line (newlines
in strings become `char(10)`). `backup_state`, `backup_objects`, FTS5
virtual tables and their shadow tables are not dumped; the FTS5 tables are
recreated and rebuilt from their content after the data. The dump spans
several steps, so it is not a single-instant snapshot.

**Objects.** All source keys except `tmp/` are listed in order after the
cursor; `backup_objects` (source key → target key, ETag, size, SHA-256)
skips unchanged keys. Each copy streams through SHA-256 and is re-read and
re-hashed from the target. The target is write-once, so R2 bucket locks and
S3 Object Lock work: a new key is copied to the same key; a rewritten key
(`refs.json`, `objects/info/packs`, …) goes to
`backups/changed/<id>/<key>`. An existing target key is re-hashed instead of
overwritten. Lock the backup bucket (R2 bucket lock rule, or Object Lock in
compliance mode) for the retention period.

**Verify.** `POST /api/admin/backup/verify` (`{"sample": n}`), the admin page
or `git-forge-node backup-verify [n]` re-hash a random sample of
`backup_objects` in the target.

**Restore.** `git-forge-node restore [id]` (latest complete backup by
default) loads the dump into an empty `DATABASE_PATH`, copies every plain key
and then the `backups/changed/<run>/` overlays up to `<id>` into `STORAGE`
with verification, and applies newer migrations. For Cloudflare, run it with
`BACKUP_STORAGE=s3` (R2's S3 API) and `STORAGE=s3` on the new bucket, and
load the database with `git-forge-node restore-sql [id] > restore.sql` and
`npx wrangler d1 execute <db> --remote --file restore.sql`. Without
git-forge: execute `backups/db/<id>/*.sql` in name order with any SQLite
client and copy the bucket with the overlays on top. D1 Time Travel (30 days
on Paid) stays the quickest way back to a recent minute.

## 20. Pages

Static sites per repository, like GitHub Pages, served by the same Worker.
Package `@git-forge/pages`, tables from migration `0012_pages.sql`
(`pages_sites`, `pages_deployments`, `pages_grants`, `pages_sessions`).

### Sources

- **Branch** (`build_type: legacy`, `source: {branch, path}` with path `/`
  or `/docs`): enabling Pages, changing the source and every push that moves
  the branch create a deployment of that commit. Files are served as they
  are; there is no Jekyll build (use a workflow for generators). Symlinks and
  submodules are skipped.
- **Workflow** (`build_type: workflow`): `POST
  /api/v3/repos/{owner}/{repo}/pages/deployments`. With `artifact_id` or
  `artifact_url` (what `actions/deploy-pages` sends) the deployment reads the
  artifact through the `ArtifactSource` adapter; the Worker's reads the
  stored CI artifact (§15) and streams its `artifact.tar`
  (`actions/upload-pages-artifact`). `artifact_url` alone is not resolved.
  Any CI may instead upload the same tar (or tar.gz) as the request body
  (`Content-Type: application/x-tar`), deployed while it streams. The `GITHUB_TOKEN` of a trusted, non-`pull_request` run of the
  same repository may create deployments, like `pages: write` on GitHub; so
  may users with write access. `GET …/deployments/{id}` reports GitHub's
  status strings (`deployment_queued`, `deployment_in_progress`, `succeed`,
  `deployment_failed`, `deployment_cancelled`), which `deploy-pages` polls.

### Deployments

- Building a deployment is a pure function of its input
  (`buildFromTree`, `buildFromTar`): every file is stored under
  `lfs/objects/<sha256>` (the LFS key space, so identical files, LFS objects
  and release assets share bytes), and a manifest
  `{"version":1,"files":{"<path>":{"oid","size","lfs"?}}}` with sorted keys
  is written to `pages/deployments/<sha256 of the manifest>.json` with
  `If-None-Match: *`. Deployments are therefore immutable and
  content-addressed; nothing is ever overwritten. Files that are LFS
  pointers (in the branch, or in an artifact checked out without LFS) are
  recorded as `lfs: true` with the pointer's oid. Limits: 50 000 files and
  1 GiB per site. Tar entries up to 4 MiB are hashed in memory, larger ones
  are staged under `tmp/` while hashing and then copied, like release
  assets.
- **Atomic switch:** the deployment row moves to `succeed` and
  `pages_sites.active_deployment_id` to its id in one database batch, and
  only forward (`active_deployment_id < id`), so a slow older build never
  replaces a newer one. Readers see either the old or the new manifest,
  never a mix. A failed deployment leaves the active one in place.
- Deployments run as `pages-deploy` jobs on the job queue (one invocation
  each) or inline without one; uploads run in the request that streams them.
  Cancelling marks a queued or running deployment `cancelled`; it is then
  never activated.

### Serving

- `PAGES_HOST` is a pattern `{owner}.<suffix>` (scheme `https` unless given,
  optional port for development). `https://<owner>.<suffix>/<repo>/` serves
  the project site of `<owner>/<repo>`; a repository named exactly like the
  host (`<owner>.<suffix>`) is the owner's site at the root, as with
  `<owner>.github.io`. Project sites win over paths of the owner site.
  Owners whose names are not DNS labels (dots, underscores) have no Pages
  host. `PAGES_DOMAINS` maps custom domains to repositories
  (`{"docs.example.com": "acme/handbook"}`); on Cloudflare each is also a
  Workers custom domain and the wildcard a zone route, all declared in the
  Wrangler configuration. The API reports the domain as `cname` and refuses
  to change it (`422`): domains are instance configuration, not repository
  data.
- Path resolution (pure, `resolvePagesPath`): `/repo` → `301 /repo/`;
  `dir/` → `dir/index.html`; `dir` → `301 dir/` when `dir/index.html`
  exists; `page` → `page.html`; anything else → `404.html` with status 404 if
  the site has one. `..` never resolves.
- Responses: `Content-Type` by extension (`text/html; charset=utf-8` for
  HTML, unlike raw URLs, because these hosts are not the forge origin),
  `X-Content-Type-Options: nosniff`, `ETag` = the file's SHA-256,
  `If-None-Match`, single `Range` and `HEAD`. Public sites are
  `Cache-Control: public, max-age=<PAGES_MAX_AGE>` (default 60 s), so a
  pull-zone CDN can front the Pages hosts; the content behind a path changes
  only on a switch, and the short max-age plus ETag revalidation bounds the
  staleness. Private responses are `private, no-cache` with
  `Vary: Cookie, Authorization`.
- **LFS files** of public repositories answer `302` to the absolute media
  URL on `PUBLIC_URL` (`/{owner}/{repo}/media/{oid}/{name}`, immutable), so
  large files are cached once however many deployments reference them. For
  private repositories the bytes are streamed on the Pages host, because the
  media URL needs a forge session or token the browser does not send there.
- Manifests are cached per isolate (LRU, 32 MiB), which is safe because
  they are immutable; each request still reads the repository, the site row
  and the active deployment from the database, so a switch is visible
  immediately.

### Private sites

Access is the repository's `read` check (`checkRepositoryAccess`), with the
principal taken from a Pages session cookie or an `Authorization` header,
never from the request otherwise. Pages hosts are other origins than the
forge, so the forge session cookie is not sent there; the handoff:

1. A visitor without access and without credentials gets `302` to
   `<PUBLIC_URL>/_pages/authorize?redirect=<page URL>`.
2. The forge accepts only redirect URLs on its own Pages hosts (scheme,
   host pattern or configured domain, no credentials). Without a forge
   session it sends the visitor to `/login?return_to=…` and comes back after
   sign-in. With a session it stores a random one-time code (hash only, two
   minutes, bound to the target host) and redirects to
   `https://<pages host>/__pages/callback?code=…&path=…`.
3. The Pages host redeems the code once, creates a Pages session (hash in
   `pages_sessions`, twelve hours, bound to the host) and sets an
   `HttpOnly; SameSite=Lax` cookie without `Domain` (host-only; `__Host-`
   prefixed and `Secure` on https), then redirects to the path (same host
   only).

Readers without access get `404` like private repositories elsewhere. Pages
sessions are not revoked by signing out of the forge; they expire. All
repositories of one owner share an origin (as on GitHub): their scripts
can read each other's pages with the visitor's cookie, but only what that
visitor may read anyway. Use a registrable domain of its own for Pages so
that site scripts cannot set cookies for the forge.

### Not yet

- Repository settings page in the UI; custom domains set per repository
  (today: instance configuration), HTTPS certificates for them beyond
  Workers custom domains.
- Preview deployments, the `pages/health` endpoint, `pages_build_version`
  validation against the repository.
