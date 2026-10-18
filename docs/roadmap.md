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
- [ ] Media URLs `/{owner}/{repo}/media/{oid}` and raw endpoint resolving LFS pointers
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

## M4 — Mirrors

- [x] Sync Git content into `refs/upstream/{remote}/heads|tags/*`
- [x] Sync LFS objects
- [x] Per-repository auto/manual sync, detach; auto sync from the Cron Trigger
- [x] Archive and alarm on rewritten upstream history (tested across three instances)
- [ ] Mirror overview

## M5 — Deployment and adapters

- [x] Cloudflare Worker app with accounts (D1), federation and scheduled mirror sync
- [x] "Deploy to Cloudflare" button, bindings provisioned from the Wrangler config
- [x] Wrangler environments `alpha`, `beta`, `gamma` and a three-instance E2E test
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

## Later

- [ ] Branch protection
- [ ] Notifications, email, webhooks
- [ ] Releases
- [ ] Encrypted full backups, partial visibility
- [ ] External mirror verification
- [ ] SSH-to-HTTPS gateway
- [ ] Actions, Pages
