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
    objects/info/packs
    objects/pack/pack-<sha>.pack
    objects/pack/pack-<sha>.idx
  lfs/
    objects/<oid[0:2]>/<oid[2:4]>/<oid>
  README.txt                        # plain text: what this is, how to read it
```

- Packs are never deleted. Compaction writes a new, larger pack and removes
  old ones from `objects/info/packs` only after a grace period.
- The bucket layout is a durable format and may only change
  backwards-compatibly.

## 7. Flows

**Push** — `receive-pack` over smart HTTP. Parse and index the pack
(completing thin packs), check fast-forward or archive the old value, update
refs via CAS, `report-status`. Push size limit for Git packs: 64 MB by default;
large files belong in LFS. In v1 packs are processed in memory; streaming pack
indexing is a later optimization.

**Fetch** — public: dumb HTTP directly from the bucket/CDN. Private:
`upload-pack` (smart HTTP protocol v2) or dumb HTTP behind an authorizing
function.

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

**Cloudflare deployment.** One Worker serves Git, LFS, the JSON API and the
well-known federation documents, and runs mirror sync from a Cron Trigger. It
binds one R2 bucket (`BUCKET`) and one D1 database (`DB`); the database schema
is migrated by the Worker itself on first use, so there is a single migration
ledger on every platform. The "Deploy to Cloudflare" button deploys from the
repository root, because a button pointing at a subdirectory requires that
directory to be self-contained; the root `wrangler.jsonc` mirrors the app's
default configuration. Several instances on one account are Wrangler
environments (`alpha`, `beta`, `gamma`), each with its own Worker, bucket and
database.

| Building block | Cloudflare | Others |
|---|---|---|
| Functions | Workers | Bunny Edge Scripting, Deno Deploy, Lambda, self-hosted Node/Bun |
| Object storage | R2 | any S3: Hetzner, B2, OVH, IONOS, self-hosted (Garage, SeaweedFS, RustFS, versitygw) |
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

MinIO is discontinued; Garage, SeaweedFS, RustFS and versitygw are evaluated
as local S3 test environment.

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

- Conditional writes on B2, Hetzner, Bunny — supported?
- Compaction for dumb HTTP: frequency, grace period for old packs.
- Signed append-only log of ref/pack/LFS changes (e.g. C2SP tlog-tiles with
  cosigning instances as witnesses): still useful as audit trail, format open.
- Ref checksum à la GitHub Spokes (XOR over `hash(refname, value)`) for cheap
  mirror comparison.
- Can presigned PUTs be bound to length/checksum?
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
