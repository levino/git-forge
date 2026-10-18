# Roadmap

Design and rationale: [design.md](design.md). Order: core first (Git, LFS,
accounts, mirrors), then the web UI, then issues, pull requests and
discussions.

## M1 — Git core

- [x] Pack parsing and writing, including thin packs
- [x] Pack index v2, byte-identical to `git index-pack`
- [x] Refs via compare-and-swap
- [x] `receive-pack` (smart HTTP), push size limit (default 64 MB)
- [x] `upload-pack` protocol v2
- [x] Dumb HTTP
- [x] Archive under `refs/archive/{timestamp}/...` on force push and deletion
- [ ] Streaming pack indexing (packs are processed in memory in v1)
- [ ] Pack compaction

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
- [x] Login: OIDC (authorization code + PKCE, ZITADEL as first target), passkeys (WebAuthn, attestation none, UV required), browser sessions with CSRF protection, invites and optional self-signup
- [x] Git over HTTPS with PATs and app tokens
- [x] Git and LFS as separate authorization surfaces (`git:read` / `lfs:read`)
- [x] Instance keys (Ed25519), `/.well-known/openid-configuration`, `/.well-known/jwks.json`
- [x] Short-lived instance JWTs, trust table "issuer X may read repo Y", optional pinned thumbprint
- [x] Device flow (`git forge auth login`, RFC 8628) and git credential helper (`git forge auth git-credential`)
- [x] Break-glass key (offline Ed25519, one-hour admin session)
- [ ] Login follow-ups: OIDC groups → teams, session list and revocation in the UI, rate limits on login and device endpoints, purging expired challenges and device codes, branch protection API with sessions, device-flow scope choice
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
- [x] Native streaming hashes (`crypto.DigestStream` behind a `DigestFactory` seam) and one job per pack / LFS object with a byte budget (`MIRROR_UNIT_BYTES`), oversized units stay pending (design §12)
- [x] Plain clones of a mirror check out the upstream default branch: read-side `refs/heads/*` view of one remote, own refs win, detach materializes it
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

- [ ] Streaming receive-pack and upload-pack with bounded memory, `packfile-uris` (in progress)
- [x] Server-side import: create or update a repository by pulling from a URL (no request body limit), in resumable steps driven by a queue
- [x] Chunked push helper: `git forge push` splits history into pushes below the platform body limit, using the unmodified git client; single executables per platform from the release workflow
- [ ] Import: stream fetched packs into storage and index them with the streaming indexing job (via `ingestPack`)
- [ ] Remote helper `git-remote-forge`: resumable multipart pack upload directly to object storage via presigned URLs, then a finalize call that indexes the pack and updates refs

## M5b — CI and distribution

Design: [design.md §15](design.md#ci).

- [x] Spike, part 1: YAML subset parser and workflow/job model in core (pure), push filters
- [x] Spike, part 1: Actions service, legacy flow (connectionData, OAuth client assertion, sessions, message long-poll, job renew/finish, timeline, logs, console lines, attachments)
- [x] Spike, part 1: GHES REST subset (`generate-jitconfig`, `registration-token`, `runner-registration`, list/get/delete runners, runs, jobs, job logs)
- [x] Spike, part 1: dispatch on push, one ephemeral JIT runner per job via `RunnerLauncher`, `needs` with skip on failure; job tokens (`GITHUB_TOKEN` read over Git HTTP, runtime token per job), instance secrets
- [x] Spike, part 1: Cloudflare Container definition for the runner (Dockerfile, `wrangler.jsonc`)
- [ ] Spike, part 2: run the real-runner integration test where GitHub downloads are allowed and fix what it finds; deploy the container and deploy a hello-world Worker with `wrangler` from our own CI
- [ ] `uses:` actions: `ActionDownloadInfo` with tarballs from mirrored action repositories (`actions/checkout`, `actions/setup-node`, …)
- [ ] Expressions server-side: job-level `if`, `runs-on` expressions, `strategy`/`matrix`, job outputs across `needs`
- [ ] Cancellation, job timeouts, reaper for expired locks and dead runners, re-runs
- [ ] Per-repository and per-environment secrets (encrypted in SQLite), environments with required reviewers, no secrets for fork runs
- [ ] `workflow_dispatch`, `pull_request`, `schedule` triggers; commit statuses / check runs (feeds required status checks)
- [ ] Broker and run service (v2 flow), results service, message encryption; then cache, artifacts, OIDC id tokens
- [ ] External providers: signed `workflow_job` webhook delivery, GitHub App auth (JWT → installation token, manifest flow) and PATs on `/api/v3`, org-level runners; try WarpBuild Enterprise, AWS CodeBuild, RunsOn
- [ ] `container:` and `services:` (Docker-in-Docker in the runner container)
- [ ] Web UI for runs and live logs
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
