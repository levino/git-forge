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

- [ ] Batch API with presigned URLs (in progress)
- [ ] Verify step (size, SHA-256) before an object counts as present
- [ ] Reject pushes referencing missing LFS objects
- [ ] Media URLs `/{owner}/{repo}/media/{oid}` and raw endpoint resolving LFS pointers
- [ ] Optional: publish public LFS objects to a CDN bucket on push

## M3 — Accounts and federation

- [ ] Users, organizations, teams, roles, PATs, apps in SQLite (in progress)
- [ ] Login: OIDC (ZITADEL etc.), passkeys
- [ ] Git over HTTPS with PATs and app tokens
- [ ] Instance keys (Ed25519), `/.well-known/openid-configuration`, `/.well-known/jwks.json` (in progress)
- [ ] Short-lived instance JWTs, trust table "issuer X may read repo Y", optional pinned thumbprint
- [ ] Device flow (`gh auth login`-style)
- [ ] Break-glass key
- [ ] SAML, SCIM

## M4 — Mirrors

- [ ] Sync Git content into `refs/upstream/{remote}/heads|tags/*` (in progress)
- [ ] Sync LFS objects
- [ ] Per-repository auto/manual sync, detach
- [ ] Archive and alarm on rewritten upstream history
- [ ] Mirror overview

## M5 — Deployment and adapters

- [ ] Cloudflare Worker app (in progress)
- [ ] S3 storage adapter (in progress)
- [ ] Local S3 test environment (in progress; MinIO discontinued — Garage, SeaweedFS, RustFS, versitygw evaluated)
- [ ] Headless deployment on a Raspberry Pi (Bun/Node + SQLite file + filesystem or S3)

## M6 — Web UI (Astro SSR)

- [ ] File tree, commits, diffs, Markdown rendering
- [ ] LFS previews (images, video, audio, PDF)
- [ ] Account, organization and repository settings
- [ ] Mirror settings and alarms

## M7 — Collaboration

- [ ] Issues
- [ ] Pull requests, reviews, conflict-free merge
- [ ] Discussions
- [ ] Submit via form

## M8 — CI (GitHub Actions compatible)

Design: [design.md §12](design.md#12-ci). Spike: real `actions/runner` via JIT
config, run steps, logs, `needs`, Cloudflare Container definition.

- [x] YAML subset parser and workflow/job model in core (pure), push filters
- [x] Actions service, legacy flow: connectionData, OAuth client assertion, sessions, message long-poll, job renew/finish, timeline, logs, console lines, attachments
- [x] GHES REST subset: `generate-jitconfig`, `registration-token`, `runner-registration`, list/get/delete runners, runs, jobs, job logs
- [x] Dispatch on push: one ephemeral JIT runner per job via `RunnerLauncher`, `needs` with skip on failure
- [x] Job tokens (`GITHUB_TOKEN` read access over Git HTTP, runtime token per job), instance secrets
- [x] Cloudflare Container definition for the runner (Dockerfile, `wrangler.jsonc`), deployment untested
- [ ] Run the end-to-end test with the real runner where GitHub downloads are allowed; fix protocol gaps it finds
- [ ] Deploy the runner container on Cloudflare and run a `wrangler deploy` job from our own CI
- [ ] `uses:` actions: `ActionDownloadInfo` with tarballs from mirrored action repositories (`actions/checkout`, `actions/setup-node`, …)
- [ ] Expressions server-side: job-level `if`, `runs-on` expressions, `strategy`/`matrix`, job outputs across `needs`
- [ ] Cancellation, job timeouts, reaper for expired locks and dead runners, re-runs
- [ ] Per-repository and per-environment secrets (encrypted in SQLite), environments with required reviewers, no secrets for fork runs
- [ ] `workflow_dispatch`, `pull_request`, `schedule` triggers
- [ ] Commit statuses / check runs, web UI for runs and live logs
- [ ] Broker and run service (v2 flow), results service, message encryption
- [ ] Cache, artifacts, OIDC id tokens (`id-token: write`) for cloud deployments without long-lived secrets
- [ ] External providers: signed `workflow_job` webhooks, GitHub App auth (JWT → installation token, manifest flow), org-level runners; try WarpBuild Enterprise, AWS CodeBuild, RunsOn
- [ ] `container:` and `services:` (needs Docker inside the runner container)

## Later

- [ ] Branch protection
- [ ] Notifications, email, webhooks
- [ ] Releases
- [ ] Encrypted full backups, partial visibility
- [ ] External mirror verification
- [ ] SSH-to-HTTPS gateway
- [ ] Pages
