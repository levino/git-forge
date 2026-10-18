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
   deletions are allowed, but the previous state is archived (§5).
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
- **Discussions:** separate from issues; categories, threads, mark answer.

**Should (soon after)**

- Branch protection (no force push, required reviews).
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
- **Sync per repository:** `auto` (scheduled) or `manual`. **Detach** stops
  syncing; the repository and its `refs/upstream/*` stay as they are.
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
- There are no push certificates. The instance signs; trust is
  server-to-server.

## 5. Refs, force pushes and archive

- Refs are updated with compare-and-swap (conditional writes).
- Force pushes and ref deletions are allowed (branch protection comes later).
  The previous value is always kept under
  `refs/archive/{timestamp}/heads/...` resp. `refs/archive/{timestamp}/tags/...`,
  so no commit becomes unreachable.
- `refs/archive/*` and `refs/upstream/*` cannot be pushed to by clients.
- Git object format stays SHA-1 (compatibility). Signatures and LFS use
  SHA-256.

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
    objects/<oid[0:2]>/<oid[2:4]>/<oid>
  README.txt                        # plain text: what this is, how to read it
tmp/<repo>/<timestamp>-<uuid>/<n>   # staging chunks of a push, expired by the bucket
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
   ref commands (object exists, branches point at commits, fast-forward or
   archive).
5. Write the final pack (the staged bytes, or for thin packs a new header, the
   staged entries, the appended bases and a new trailer) and an idx v2 built
   from compact column arrays, register the pack in `objects/info/packs`,
   update refs via CAS, `report-status`.

Memory is the cache budget (16 MiB), one staging chunk (4 MiB) and about
60–100 bytes per object, independent of the pack's size in bytes. Plain
blobs of any size are only streamed, but objects that must be materialized
(commits, trees, tags, delta bases and delta results) are limited to 64 MiB;
large files belong in LFS. The Worker sets no push size limit of its own; the platform's request
body limit applies (`apps/forge-worker/README.md`). Repositories larger than
that are pushed in slices or imported through a mirror, whose fetch uses the
same indexer.

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
(§4), fetch upstream refs, fetch missing objects via `upload-pack`, update
`refs/upstream/{remote}/*` (archive and alarm on rewrites), fetch missing LFS
objects via the Batch API and verify their hashes.

**Media URLs (LFS onto a CDN without CI)** — the forge serves
content-addressed, immutable URLs such as `/{owner}/{repo}/media/{oid}` and a
path/ref-based raw endpoint that resolves LFS pointers. Both redirect to
presigned bucket URLs or stream the object. A CDN (e.g. a Bunny pull zone) in
front caches them. Optional later: a "publish" setting that copies public LFS
objects into a public CDN bucket on push.

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

## 9. Git over SSH

Not supported: serverless functions accept only HTTP. Git uses HTTPS with
tokens, later also a device flow. An optional SSH-to-HTTPS gateway could run
on a Pi or VPS later.

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

| Building block | Cloudflare | Others |
|---|---|---|
| Functions | Workers | Bunny Edge Scripting, Deno Deploy, Lambda, self-hosted Node/Bun |
| Object storage | R2 | any S3 with conditional writes: Hetzner, B2, OVH, IONOS, self-hosted (versitygw, RustFS); a local directory |
| Database | D1 / SQLite in Durable Objects | libSQL/Turso, SQLite file (Pi) |
| Per-repository consistency | Durable Object | conditional writes (S3 CAS), single-writer process |
| Scheduling, jobs | Cron Triggers, Queues | `Deno.cron`, systemd timers, job table |
| Email | Mail service via API | SMTP |
| Compute for CI (later) | Containers | Fly Machines, Hetzner Cloud, … |

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
| Mirror compute (free tiers) | €0 |
| Pi with 1 TB SSD | one-off ~€150 |
| **Total** | **~€13–15** |

## 13. Open questions

- Conditional writes on B2, Hetzner, Bunny — supported? (Run the S3 conformance
  suite against them; see `packages/s3/README.md`.)
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
deployable unit is a release artifact, not an npm package:

- **Release artifact:** on every release tag, CI builds the worker as a single
  bundled ES module file plus the D1 migrations and publishes them with
  SHA-256 checksums as release assets.
- **Instance template** (`templates/instance`, later its own repository
  `git-forge-instance`): only `wrangler.jsonc` (own bindings, domain, vars) and
  `git-forge.json` (`version`, `sha256`). No `package.json`, no lockfile.
- **Build:** the Cloudflare build step downloads the pinned bundle, verifies the
  checksum, applies D1 migrations and runs `wrangler deploy`.
- **First install:** fork/use the template or click "Deploy to Cloudflare",
  connect the repository to Cloudflare.
- **Update:** bump `version` and `sha256` in `git-forge.json` and push.
  Renovate can propose the bump via a regex manager on releases.
- The same bundle may additionally be published to npm later; the template
  never depends on it.

### Test instances

`apps/forge-worker` defines three wrangler environments `alpha`, `beta` and
`gamma`, each with its own D1 and R2. An E2E test runs all three locally and
checks mirroring and federation across them (beta mirrors alpha, gamma mirrors
beta).
