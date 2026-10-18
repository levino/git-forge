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

- [x] Cloudflare Worker app
- [x] S3 storage adapter (`@git-forge/s3`, presigned PUTs bound to length and SHA-256)
- [x] File system storage adapter (`@git-forge/node`)
- [x] Shared storage conformance suite for all adapters
- [x] Local S3 test environment (versitygw; Garage, SeaweedFS, RustFS evaluated)
- [ ] Headless deployment on a Raspberry Pi (Bun/Node + SQLite file + filesystem or S3)

## M5a — Large pushes

- [ ] Streaming receive-pack and upload-pack with bounded memory, `packfile-uris` (in progress)
- [ ] Server-side import: create a repository by pulling from a URL (no request body limit)
- [ ] Chunked push helper: `git forge push` splits history into pushes below the platform body limit, using the unmodified git client
- [ ] Remote helper `git-remote-forge`: resumable multipart pack upload directly to object storage via presigned URLs, then a finalize call that indexes the pack and updates refs

## M5b — CI and distribution

- [ ] Spike: official `actions/runner` registers via JIT config, runs one job in a Cloudflare Container and deploys a hello-world Worker with `wrangler`
- [ ] Actions service: sessions, jobs, timeline, logs; then cache, artifacts, OIDC
- [ ] Workflow parsing and job scheduling, secrets
- [ ] GHES-style `/api/v3` runner API and `workflow_job` webhooks for external providers (WarpBuild, CodeBuild, RunsOn)
- [ ] "Deploy to Cloudflare" button and three test instances (alpha, beta, gamma)
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
- [ ] Discussions
- [ ] Submit via form

## Later

- [ ] Notifications, email, webhooks
- [ ] Releases
- [ ] Encrypted full backups, partial visibility
- [ ] External mirror verification
- [ ] SSH-to-HTTPS gateway
- [ ] Pages
