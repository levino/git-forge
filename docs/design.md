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
- `gh auth login`-style device flow for the command line.

**Later / maybe**

- Pages.
- Partial visibility within a repository (levels, derived views).
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
- **Safety net:** the scheduled handler runs once a day (cron `17 3 * * *`,
  `MIRROR_INTERVAL_MINUTES` = 1440 in `wrangler.jsonc`) and enqueues a sync
  and a subscription renewal for every auto mirror whose last run is older
  than the interval. `apps/forge-node` does the same from its own cron
  schedule (`SCHEDULE`, default the same `17 3 * * *`) with an in-process job
  queue. Without a job queue, `PUBLIC_URL` or `INSTANCE_KEY` there are no
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
  `0002_branch_protection`), not in the bucket, so a plain clone of a bucket
  carries no rules. Changes are audited.

## 6. Bucket layout

```
<repo>/
  git/                              # cloneable via dumb HTTP
    HEAD
    info/refs
    objects/info/packs              # the current pack set
    objects/pack/pack-<sha>.pack
    objects/pack/pack-<sha>.idx
  lfs/
    objects/<oid[0:2]>/<oid[2:4]>/<oid>   # LFS objects and release assets
  import/status.json                # progress of the last import
  import/commits.txt                # commit order of the last import
  README.txt                        # plain text: what this is, how to read it
tmp/<repo>/<timestamp>-<uuid>/<n>   # staging chunks of a push or fetch, expired by the bucket
tmp/<repo>/<timestamp>-<uuid>/asset # a release asset upload without a declared SHA-256 (§16)
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
  rule (e.g. one day). Pushes up to one chunk never touch `tmp/`.
- **Release assets** are content-addressed like LFS objects
  (`lfs/objects/…`, §16). Which asset belongs to which release lives only in
  the database; a deleted asset or release leaves its bytes in place.
- The bucket layout is a durable format and may only change
  backwards-compatibly.


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
- Later: a remote helper uploading packs directly to object storage
  (roadmap M5a).

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
streams each fetched pack into the same indexer as a push, so a step never
holds its pack in memory. The commit graph of the *graph* phase is read with
the indexer's object visitor without storing the pack.

A failing step is retried with exponential backoff (15 s … 10 min); after
five failures in a row the import is `failed`, and starting it again with the
same URL resumes at the failed phase. An import whose state has not changed
for 30 minutes (`STALE_IMPORT_MS`; a live import writes its state at least
every 10 minutes) counts as abandoned, for example because the process that
drove it restarted and lost its in-memory job: starting it again with the same
URL takes it over at its current phase. Credentials are never written to the
bucket: the token travels with each scheduled step. Steps are driven by the
scheduling adapter (`ImportScheduler`): a Cloudflare Queue in the Worker
(each message is one step in its own invocation), the in-process job queue in
`apps/forge-node`, a simple loop (`runImport`) elsewhere.

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
| Device flow (`git forge auth login`, like `gh auth login`) | Command line: issues a `repo:write` token, git uses it through the credential helper |
| Break-glass key | Offline Ed25519 key, opens a short admin session when the IdP is down |
| SAML, SCIM | Later, for organizations that require them |

Typical setup: people log in via OIDC or passkeys; apps and automations use
app tokens; mirrors use instance federation (§4).

**Instance admins and bootstrap.** Instance admins (table `instance_admins`)
create users and tokens, trust other instances and count as admins of every
repository. A fresh instance has none: one call of `POST /api/bootstrap`,
authenticated with the deployment secret `BOOTSTRAP_TOKEN`, creates the first
admin atomically and returns a personal access token; further calls answer
`409`. The admin then invites themselves (`POST /api/admin/invites` with
`user`) to link an OIDC identity or register a passkey. The JSON API accepts
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
(`OIDC_ISSUER`, `OIDC_CLIENT_ID`, optional secret `OIDC_CLIENT_SECRET`). The
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
of the bootstrap token: `claim-admin.sh` inserts a verified email address or
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
JWKs.

**Device flow.** RFC 8628 with the fixed client id `git-forge-cli`. The user
code (8 letters without vowels and look-alikes) is entered or confirmed at
`/login/device` in a signed-in browser, which shows the client name and the
scope before approval. The first successful poll consumes the authorization
and issues a personal access token with `repo:write`, 90 days; a poll faster
than the interval gets `slow_down`. The CLI stores the token per host in
`~/.config/git-forge/hosts.json` (0600) and configures
`credential.<host>.helper = !git-forge auth git-credential` (after an empty
helper, which resets others), so plain `git` and `git-lfs` authenticate
without tokens in URLs.

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

**Size limits.** Git pushes are only limited by the platform's request body
limit unless `MAX_PUSH_BYTES` is set; single LFS
objects by `MAX_LFS_OBJECT_BYTES` (default 100 MiB, the request body limit of
Cloudflare's Free and Pro plans), enforced in the batch API and on `PUT`.

## 9. Git over SSH

Not supported, by decision. Serverless functions accept only HTTP; SSH would
need an always-on host or a TCP-capable container platform, and SSH over
WebSocket needs client-side configuration. Git uses HTTPS with tokens, made
convenient by `git forge auth login` (credential helper, device flow, §8).

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
| Releases, Pages | Bucket + CDN (release assets are LFS objects behind the media URL, §16) |
| CI | Actions service emulating GHES for the official `actions/runner`; compute adapter starts one runner per job (§15) |

Every building block is an interface; Cloudflare is the first implementation.

**Cloudflare deployment.** One Worker serves the web UI (§18), Git, LFS, media
and raw URLs, the JSON API and the well-known federation documents, and runs
mirror sync from a Cron Trigger. It binds one R2 bucket (`BUCKET`) and one D1 database (`DB`).
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
| Email | Amazon SES v2 HTTP API (`@git-forge/ses`, SigV4 via `aws4fetch`, runs on Workers and Node) | SMTP for the Node deployment (later); a console adapter for development |
| Compute for CI | Containers | external per-minute providers via the GHES API (WarpBuild, AWS CodeBuild, RunsOn), Fly Machines, a local process |

**Jobs:** the core defines `JobQueue<J>` (`enqueue(job, { delaySeconds })`),
`jobRetryDelaySeconds` (10 s doubling, capped at 1 h) and `PermanentJobError`.
`@git-forge/cloudflare` implements it on Queues (`QueueJobs`, `consumeJobs`
with `max_batch_size: 1`, so every job is its own invocation with its own
CPU budget); `createMemoryJobQueue` runs jobs in process (Node, tests), with
an optional `concurrency` limit, `keepHistory: false` for long-running
processes and an `onOutcome` callback for logging. Jobs are plain JSON
(repository, remote, callback), so a retry re-reads current state instead of
replaying old data. In-process jobs are not durable: whatever is queued when
the process stops is lost. Every job kind tolerates that: mirror state is
re-derived by the next notification or scheduled run, and an abandoned import
is taken over after 30 minutes (§7).

**Node deployment (`apps/forge-node`).** The same router as the Worker
(`createForge` from `apps/forge-worker/src/app.ts`, imported as
`forge-worker/app`; it contains no Cloudflare types) in one process: `serve`
from `@git-forge/node` adapts it to `node:http` with streaming request and
response bodies; `FsStorage` or `S3Storage` hold repository data; the SQLite
file is opened with `@git-forge/accounts-node` (`node:sqlite`, WAL);
`nodeDigests` hashes with `node:crypto`; background jobs and import steps run
in two `createMemoryJobQueue`s with the Worker's job handler and retry policy;
a cron scheduler (five-field expressions in UTC) calls the same `scheduled`
as the Worker's Cron Trigger. Configuration uses the Worker's variable names
plus `PORT`, `HOST`, `TRUST_PROXY`, `DATA_DIR`, `DATABASE_PATH`, `STORAGE`,
`STORAGE_DIR`, `S3_*`, `SCHEDULE` and `JOB_CONCURRENCY`. Like the Worker it
never migrates implicitly: `git-forge-node migrate` applies the bundled
`MIGRATIONS` (the same SQL files as `migrations_dir`, kept in sync by a test
in `@git-forge/accounts`), and `serve` refuses to start while
`pendingMigrations` is not empty. It runs on Node 22 and, compiled with
`bun build --compile`, as a single executable for `linux-x64` and
`linux-arm64` (Bun implements `node:http`, `node:sqlite` and `node:crypto`);
a Dockerfile builds a distroless image and `deploy/` has systemd units. The
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
| Runner container | `apps/forge-worker` (`runner-container.ts`, `runner-launcher.ts`, `runner/Dockerfile`), declared in `apps/forge-worker/wrangler.jsonc` (opt-in snippet in `templates/instance`) | Cloudflare Containers; the only Cloudflare-specific part. A plain Durable Object class on `ctx.container`, so the release bundle stays one module without imports. |

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

`paths` filters are rejected as unsupported until they are implemented.

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
runners, secrets and environments need admin access. Pure functions for signed `workflow_job` webhooks
(`X-Hub-Signature-256`) exist; delivering them to providers, GitHub App auth
(JWT → installation token) and org-level runners come with the provider work
package.

#### Tokens and permissions

All CI credentials are random opaque tokens, stored only as SHA-256 hashes in
`actions_tokens`, with an expiry and a kind:

| Kind | Holder | Grants |
|---|---|---|
| `registration` | `config.sh` | Register one runner for one repository (1 h). |
| `runner` | Runner listener | Its own sessions, messages and job requests (1 h, renewed via OAuth). |
| `runtime` | Runner worker (`SystemVssConnection`) | Timeline, logs and completion of exactly one job (plan id checked on every call). Revoked when the job completes. |
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

- **Cloudflare Containers (first backend):** billed per 10 ms, scale to
  zero, up to 4 vCPU / 12 GiB, rootless Docker-in-Docker (needed later for
  `container:` and `services:`). `RunnerContainer` is a Durable Object
  container class, one instance per job (`env.RUNNER.idFromName(jobId)`),
  that starts its container with the entrypoint `run.sh --jitconfig <config>`
  and keeps the object alive until the container exits. The image
  (`runner/Dockerfile`, in the app and in the instance template) is the
  official `ghcr.io/actions/actions-runner` image plus Git and Node.js. Like
  every other resource it comes from the wrangler config (`containers`, the
  `RUNNER` Durable Object binding and its migration, in every environment of
  `apps/forge-worker`; in the instance template it is a documented opt-in and
  `ACTIONS` is off by default until image builds in Workers Builds are
  verified): `wrangler deploy` builds the image and pushes it to the
  Cloudflare registry, so the deploy environment needs Docker. Durable Object
  containers cannot pull external images by reference, only digest-pinned
  images from the Cloudflare registry or a local Dockerfile. The release
  bundle is built with `wrangler deploy --dry-run --containers-rollout=none`,
  which skips the image. The runner is ephemeral: it exits after one job, the
  container stops and is discarded. Deployment is untested so far.
- **Local process:** the integration test copies the downloaded runner into a
  temporary directory per job and starts it with `--jitconfig`. The same works
  on a Pi or against `wrangler dev`.
- **External providers (later):** WarpBuild Enterprise, AWS CodeBuild and
  RunsOn call `generate-jitconfig` / `registration-token` themselves after a
  `workflow_job` webhook; the forge only has to deliver signed webhooks and
  accept GitHub App or PAT authentication on `/api/v3`.

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

- SQLite, migrations `packages/accounts/migrations/0005_actions.sql` and
  `0009_actions_workflows.sql`, applied by `wrangler d1 migrations apply`
  like every other migration and shipped in the release's
  `migrations.tar.gz`: `actions_runners`, `actions_tokens`,
  `actions_sessions`, `actions_runs` (plus definition, attempt, trusted,
  concurrency group, cancellation, completion), `actions_jobs` (plus
  attempt, `expanded`, matrix, outputs, environment, approval,
  cancellation, launches, check run), `actions_timeline_records`,
  `actions_logs`, `actions_secrets`, `actions_environments`,
  `actions_schedules`. `0009` only adds columns and tables,
  so the previous release keeps working on the new schema.
- Bucket, append-only, written with `If-None-Match: *`:
  `repos/<owner>/<repo>/actions/jobs/<jobId>/logs/<logId>/<chunk>`,
  `…/console/<recordId>/<startLine>` and
  `…/attachments/<recordId>/<type>/<name>`. Like the rest of the bucket
  layout this is a durable format.

#### Status and known gaps

- The real runner runs in CI (`packages/actions/test/runner.integration.test.ts`):
  `actions/checkout@v4` from a mirror of `github.com/actions/checkout` on
  the forge, a matrix with job outputs through `needs`, a masked secret,
  `wrangler deploy --dry-run`, and the cancellation of a running job.
- Not deployed on Cloudflare Containers yet.
- Not supported yet: `container:`, `services:`, reusable workflows,
  job-level `concurrency`, `paths` filters, `vars` (configuration
  variables, the context is empty), `hashFiles` server-side, wait timers and
  branch policies of environments, re-running single matrix legs.
- Broker / run service (v2 flow), results service, cache, artifacts, OIDC
  tokens, message encryption with the session key.
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
  routes (custom domains) are declared there as well. The `BOOTSTRAP_TOKEN`
  secret is deliberately not `secrets.required`: a secret can only be set on an
  existing Worker, so requiring it would block the very first deploy. It is set
  after the first deploy; until then `/api/bootstrap` answers `503`.
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
  smoke test and a page request against `wrangler dev` running the template.
- The same bundle may additionally be published to npm later; the template
  never depends on it.
- **Without Cloudflare:** every release also carries
  `git-forge-node-linux-x64` and `git-forge-node-linux-arm64` (single
  executables of `apps/forge-node`, built with Bun, version from
  `release/VERSION`) and `NODE-SHA256SUMS`. They need no template: install the
  executable, run `migrate`, start `serve` (systemd units and a Dockerfile in
  `apps/forge-node`).

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
production). SES uses the v2 `SendEmail` API with a simple message (subject,
text, HTML, `List-Unsubscribe` and auto-reply suppression headers), signed
with SigV4; `4xx` answers are permanent (`EmailRejectedError`), throttling
and `5xx` are retried by the job queue. SMTP for the Node deployment is
another adapter of the same interface, not built yet (Workers cannot open TCP
connections to arbitrary SMTP servers without `connect()`, and SES covers
the Cloudflare deployment).

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
  --no-ff`, `git merge --squash` and `git rebase --force-rebase`. Rename
  detection is not implemented; to stay safe, situations where git's rename
  or directory-rename detection could change the outcome (a file deleted on
  both sides while a similar file was added on one side, a directory removed
  on one side while the other adds to it) are reported as conflicts. The
  merge is therefore never clean where git conflicts, and identical where
  both are clean.
- **Branch protection on merge.** The merge calls the same
  `evaluateBranchUpdate(rule, actor, update, { via: 'pull-request', … })` as
  receive-pack, with approvals from reviewers with write access (the
  author's own reviews never count), requested changes, the last-push
  approval, the strict up-to-date flag and the latest statuses and check
  runs of the head. `require_code_owner_reviews` is only satisfiable while
  the base has no `CODEOWNERS` file. Required status checks on direct pushes
  still see no statuses (the push policy is synchronous); the pull request
  is the path that satisfies them.
- **Statuses and check runs** are stored here and written by CI (directly
  through `recordCommitStatus` / `recordCheckRun`) or by anyone with write
  access through the API.
- **Hooks.** After a merge the host's `onBranchUpdated` runs the same
  pipeline as a push (CI dispatch, mirror notifications, `push` events).
  Every mutation reports an activity (`onActivity`) that the Worker turns
  into notification events (§16: `issues`, `issue_comment`,
  `pull_request`, `pull_request_review`, `pull_request_review_comment`);
  the collaboration package itself does not depend on the notifications
  package.
- **Limits of v1.** Same-repository pull requests only (forks later),
  computing mergeability and file lists loads the involved objects through
  the in-memory object database, no reactions, no search,
  no CODEOWNERS parsing, no in-browser conflict resolution.

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
- Reserved first path segments: `api`, `explore`, `login`, `settings`, `-`
  (assets) and the other page routes. Account names must not use them.

### Permissions

Pages get `Astro.locals.forge` (`ForgeServices`: storage, accounts store,
`authenticate`, `repositoryAccess`, `isInstanceAdmin`) and
`Astro.locals.principal`, set by the middleware from the verified credential
of the request: the session cookie (`readActiveSession`) or, without one,
the `Authorization` header, as for the API. Repository pages call `repositoryAccess(principal,
repo, role)`, the same function the JSON API uses for its admin checks, which
wraps `checkRepositoryAccess` from `@git-forge/accounts` and adds instance
admins. Private repositories answer 404 to visitors who may not read them,
like the Git endpoints. Lists (home, explore, profiles) filter with the same
function.

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

### Rendering

- Tailwind CSS with daisyUI, themes `light` (default) and `dark`
  (`prefers-color-scheme`). The stylesheet is compiled at build time
  (`?inline`) and served by the Worker at `/-/style.css?v=<hash>` with an
  immutable cache header, so pages stay small and the release needs no asset
  directory.
- Syntax highlighting is server-side with shiki's JavaScript regex engine (no
  WebAssembly) and a fixed set of grammars; tokens carry light and dark
  colours as CSS variables. Files above 256 KiB or with unknown types are
  shown unhighlighted.
- Markdown (README, `.md` files) goes through remark/rehype with GFM and
  `rehype-sanitize` (GitHub's schema); relative links point to the blob view,
  relative images to the raw endpoint.
- LFS files are previewed through the media URL (images, video, audio, PDF),
  binary files through the raw URL at the commit id.
- No client-side framework. Interactive bits use native elements
  (`<details>` dropdowns); islands are added only where a page needs them
  (passkey ceremonies, diff line comments).

### Tests

- `packages/core/test/browse.test.ts`: read model against a real pushed
  repository.
- `apps/forge-worker/test/unit/ui.test.ts`: routing split, origin check,
  Markdown sanitizing and link rewriting, highlighting.
- `apps/forge-worker/test/pages/`: pages rendered with Astro's container API
  against a Node forge (SQLite, memory storage) with a pushed repository
  (`vitest.pages.config.ts`).
- `apps/forge-worker/test/browser/`: Playwright (desktop and mobile Chromium)
  against `wrangler dev` running the built bundle, with a repository pushed by
  the real `git` and `git-lfs` clients, and a passkey sign-up from an invite
  with Chromium's virtual WebAuthn authenticator (settings, token create and
  revoke, sign-out, passkey sign-in).
- `apps/forge-worker/test/e2e/headless.e2e.test.ts`: the same bundle with
  `UI=false` serves only the forge.
- The release test requests a page from the template instance.

## 19. Backups

Decision: backups are made at the bucket and database level with the
providers' own tools; the forge has no backup code of its own. Mirrors (§4)
are the federated copies; a backup is the operator's copy of their own
instance, kept somewhere that cannot be rewritten.

- **Repository data.** The bucket is append-only by design (§6): packs, idx
  files and LFS objects are written once under their hash, only a few small
  files (`refs.json`, `objects/info/packs`, `info/refs`, `HEAD`, mirror
  status) are rewritten. Copy it to a second bucket with Object Lock
  (compliance mode, versioning on), so every rewritten file keeps its old
  versions for the retention period and nothing can be deleted early, not
  even with the backup credentials. `tmp/` is not needed.
- **Database.** D1 Time Travel restores any minute of the last 30 days
  (Workers Paid; 7 days on Free). For longer retention export the database
  daily and put the dump into the same locked bucket. On Node, take an online
  copy of the SQLite file.
- **Consistency.** Copy the database first, then the bucket: every row
  refers only to objects that exist by then, and objects are never removed.
- **Confidentiality.** The backup provider sees what the forge stores. For a
  provider that should only see ciphertext, use an `rclone crypt` remote as
  the target; its keys stay with the operator.

Commands (Cloudflare instance; `lock:` is an rclone S3 remote for B2,
Hetzner or any S3 bucket with Object Lock, `r2:` one for the instance's R2
bucket):

```sh
# once: a bucket with Object Lock and 90 days default retention
aws s3api create-bucket --bucket forge-backup --object-lock-enabled-for-bucket --endpoint-url "$S3_ENDPOINT"
aws s3api put-object-lock-configuration --bucket forge-backup --endpoint-url "$S3_ENDPOINT" \
  --object-lock-configuration '{"ObjectLockEnabled":"Enabled","Rule":{"DefaultRetention":{"Mode":"COMPLIANCE","Days":90}}}'

# daily (cron, CI): database first, then the repositories
npx wrangler d1 export git-forge --remote --output "d1-$(date -u +%F).sql"
rclone copy "d1-$(date -u +%F).sql" lock:forge-backup/d1/
rclone copy r2:git-forge lock:forge-backup/bucket/ --exclude 'tmp/**' --checksum

# Node instance (apps/forge-node)
sqlite3 /data/git-forge.sqlite ".backup /tmp/git-forge-$(date -u +%F).sqlite"
rclone copy /tmp/git-forge-$(date -u +%F).sqlite lock:forge-backup/db/
rclone copy /data/objects lock:forge-backup/bucket/ --exclude 'tmp/**' --checksum
```

Restore: `npx wrangler d1 time-travel restore git-forge --timestamp <iso>`
within the Time Travel window, otherwise `npx wrangler d1 execute <new db>
--remote --file d1-<date>.sql` into a freshly created database; then
`rclone copy lock:forge-backup/bucket/ r2:<new bucket>/` (an older state with
`--s3-version-at <time>`). A repository can also be cloned straight from the
copied bucket over dumb HTTP or after `rclone copy` to a directory, without
any git-forge software (§2).
