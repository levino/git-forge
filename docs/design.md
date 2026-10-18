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
