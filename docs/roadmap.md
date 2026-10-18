# Roadmap

Design and rationale: [design.md](design.md). Order: core first (Git, LFS,
accounts, mirrors), then the web UI, then issues, pull requests and
discussions.

## M1 — Git core

- [x] Pack parsing and writing, including thin packs
- [x] Pack index v2, byte-identical to `git index-pack`
- [x] Refs via compare-and-swap
- [x] `receive-pack` (smart HTTP), streamed; size bounded by the platform's request body limit
- [x] `upload-pack` protocol v2, streaming stored packs; `packfile-uris`
- [x] Dumb HTTP
- [x] Archive under `refs/archive/{timestamp}/...` on force push and deletion
- [x] Streaming pack indexing with bounded memory (staging chunks, LRU cache, range reads)
- [x] Geometric pack compaction (append-only, swaps the current pack set)

## M2 — Git LFS

- [x] Batch API (presigned URLs where the storage can sign, upload through the function otherwise)
- [x] Verify step (size, SHA-256) before an object counts as present
- [x] Reject pushes referencing missing LFS objects
- [x] Per-object size limit (`MAX_LFS_OBJECT_BYTES` in the Worker)
- [x] Media URLs `/{owner}/{repo}/media/{oid}` and raw endpoint `/{owner}/{repo}/raw/{ref}/{path}` resolving LFS pointers (CDN pull-zone friendly: immutable caching, ETag, Range, HEAD)
- [ ] Optional: publish public LFS objects to a CDN bucket on push

## M3 — Accounts and federation

- [x] Users, organizations, teams, roles, PATs, apps in SQLite
- [x] Instance admins, one-time bootstrap of the first admin
- [x] Private repositories by default, per-repository visibility
- [ ] Login: OIDC (ZITADEL etc.), passkeys
- [x] Git over HTTPS with PATs and app tokens
- [x] Git and LFS as separate authorization surfaces (`git:read` / `lfs:read`)
- [x] Instance keys (Ed25519), `/.well-known/openid-configuration`, `/.well-known/jwks.json`
- [x] Short-lived instance JWTs, trust table "issuer X may read repo Y", optional pinned thumbprint
- [ ] Device flow (`gh auth login`-style)
- [ ] Break-glass key
- [ ] SAML, SCIM
- [x] Branch protection rules (patterns, force push, deletion, push restrictions, admin bypass) enforced in `receive-pack`, API under `/api/repos/{owner}/{repo}/branches/{branch}/protection`
- [ ] Branch protection API and push policy wired into the Worker app (needs accounts on D1 there)

## M4 — Mirrors

- [x] Sync Git content into `refs/upstream/{remote}/heads|tags/*`
- [x] Sync LFS objects
- [x] Per-repository auto/manual sync, detach
- [x] Archive and alarm on rewritten upstream history (tested across three instances)
- [x] Push-notified sync: signed notifications (EdDSA JWT, ref state only) to subscribed mirrors, subscriptions via authenticated federation call, job queue with exponential backoff, idempotent duplicates, chains of mirrors; the Cron Trigger is only a daily safety net
- [x] Copy-only sync: copy upstream packs and indexes as stored (byte-identical), verify index consistency and pack trailer while streaming; deep check (re-hash everything, recompute indexes, walk refs) on demand or every 30 days
- [ ] Native streaming hashes (`crypto.DigestStream`) and one job per pack / LFS object, so a mirror fits the Workers Free plan beyond small pushes (see design §12)
- [ ] Mirror overview

## M5 — Deployment and adapters

- [x] Cloudflare Worker app with accounts (D1), federation and scheduled mirror sync
- [x] Wrangler environments `alpha`, `beta`, `gamma` and a three-instance E2E test
- [x] S3 storage adapter (`@git-forge/s3`, presigned PUTs bound to length and SHA-256)
- [x] File system storage adapter (`@git-forge/node`)
- [x] Shared storage conformance suite for all adapters
- [x] Local S3 test environment (versitygw; Garage, SeaweedFS, RustFS evaluated)
- [ ] Headless deployment on a Raspberry Pi (Bun/Node + SQLite file + filesystem or S3)

## M5a — Large pushes

- [x] Streaming receive-pack and upload-pack with bounded memory, `packfile-uris`, geometric compaction
- [x] Server-side import: create or update a repository by pulling from a URL (no request body limit), in resumable steps driven by a queue
- [x] Chunked push helper: `git forge push` splits history into pushes below the platform body limit, using the unmodified git client; single executables per platform from the release workflow
- [x] Import and mirror sync: stream fetched packs into the streaming indexer (via `ingestPack`)
- [ ] Remote helper `git-remote-forge`: resumable multipart pack upload directly to object storage via presigned URLs, then a finalize call that indexes the pack and updates refs

## M5b — CI and distribution

- [ ] Spike: official `actions/runner` registers via JIT config, runs one job in a Cloudflare Container and deploys a hello-world Worker with `wrangler`
- [ ] Actions service: sessions, jobs, timeline, logs; then cache, artifacts, OIDC
- [ ] Workflow parsing and job scheduling, secrets
- [ ] GHES-style `/api/v3` runner API and `workflow_job` webhooks for external providers (WarpBuild, CodeBuild, RunsOn)
- [x] "Deploy to Cloudflare" button in the README pointing at the instance template; template wired to accounts (`BOOTSTRAP_TOKEN`)
- [x] Release artifact (bundled worker + migrations + checksums) and instance template with pinned version
- [ ] Create `levino/git-forge-instance`, add the deploy key secret `INSTANCE_TEMPLATE_DEPLOY_KEY`, cut the first release
- [ ] Verify the Deploy button, Workers Builds settings and automatic provisioning of D1/R2 of the template against a real Cloudflare account

## M6 — Web UI (Astro SSR)

- [ ] File tree, commits, diffs, Markdown rendering
- [ ] LFS previews (images, video, audio, PDF)
- [ ] Account, organization and repository settings
- [ ] Mirror settings and alarms

## M7 — Collaboration

- [ ] Branch protection (in progress, v1)
- [ ] Issues
- [ ] Pull requests, reviews, conflict-free merge
- [ ] Enforce required reviews and status checks on merge via `evaluateBranchUpdate(..., { via: 'pull-request' })`
- [ ] Discussions
- [ ] Submit via form

## Later

- [ ] Notifications, email, webhooks
- [ ] Releases
- [ ] Encrypted full backups, partial visibility
- [ ] External mirror verification
- [ ] Pages
