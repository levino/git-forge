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
- [x] S3 storage adapter (`@git-forge/s3`, presigned PUTs bound to length and SHA-256)
- [x] File system storage adapter (`@git-forge/node`)
- [x] Shared storage conformance suite for all adapters
- [x] Local S3 test environment (versitygw; Garage, SeaweedFS, RustFS evaluated)
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

## Later

- [ ] Branch protection
- [ ] Notifications, email, webhooks
- [ ] Releases
- [ ] Encrypted full backups, partial visibility
- [ ] External mirror verification
- [ ] SSH-to-HTTPS gateway
- [ ] Actions, Pages
