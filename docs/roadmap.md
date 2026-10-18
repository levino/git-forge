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
- [x] Presigned R2 URLs in the Worker (`R2_*` S3 credentials, `withPresigner` over the binding), LFS objects up to R2's single-PUT limit
- [x] Verify step (size, SHA-256) before an object counts as present
- [x] Reject pushes referencing missing LFS objects
- [x] Per-object size limit (`MAX_LFS_OBJECT_BYTES` in the Worker)
- [x] Media URLs `/{owner}/{repo}/media/{oid}` and raw endpoint `/{owner}/{repo}/raw/{ref}/{path}` resolving LFS pointers (CDN pull-zone friendly: immutable caching, ETag, Range, HEAD)
- [ ] Keyless large LFS uploads: `git forge` as a git-lfs custom transfer agent (set up by `git forge auth login`), uploading parts of at most 64 MB through the Worker into an R2 multipart upload via the binding (resumable, size and SHA-256 verified before the object counts as present); plain git-lfs keeps the single PUT up to the body limit
- [x] Optional: publish public LFS objects to a CDN bucket on push (`LfsPublisher` adapter, keyed by oid, `CDN_BUCKET` / `LFS_PUBLISH_DIR`, backfill endpoint; design §7)

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
- [x] CLI login: paste a PKCE-bound code (default), `--browser-redirect`, `--device`; `--scopes`; consent with host, IP, time, phishing warning
- [x] `git forge repo create`
- [x] Rate limits on login and device endpoints; purging expired challenges and device codes
- [x] One read / write / admin access choice for tokens and consent pages
- [x] Break-glass key (offline Ed25519, one-hour admin session)
- [x] Session list and revocation, list and unlink linked OIDC identities (account page)
- [ ] Login follow-ups: OIDC groups → teams
- [ ] SAML, SCIM
- [x] Branch protection rules (patterns, force push, deletion, push restrictions, admin bypass) enforced in `receive-pack`, API under `/api/repos/{owner}/{repo}/branches/{branch}/protection`
- [x] Branch protection API and push policy wired into the Worker app (accounts on D1), API with browser sessions and CSRF

## M4 — Mirrors

- [x] Sync Git content into `refs/upstream/{remote}/heads|tags/*`
- [x] Sync LFS objects
- [x] Per-repository auto/manual sync, detach
- [x] Archive and alarm on rewritten upstream history (tested across three instances)
- [x] Push-notified sync: signed notifications (EdDSA JWT, ref state only) to subscribed mirrors, subscriptions via authenticated federation call, job queue with exponential backoff, idempotent duplicates, chains of mirrors; the Cron Trigger is only a daily safety net
- [x] Copy-only sync: copy upstream packs and indexes as stored (byte-identical), verify index consistency and pack trailer while streaming; deep check (re-hash everything, recompute indexes, walk refs) on demand or every 30 days
- [x] Native streaming hashes (`crypto.DigestStream` behind a `DigestFactory` seam) and one job per pack / LFS object with a byte budget (`MIRROR_UNIT_BYTES`), oversized units stay pending (design §12)
- [x] Plain clones of a mirror check out the upstream default branch: read-side `refs/heads/*` view of one remote, own refs win, detach materializes it
- [x] Mirror overview API: signed attestations from mirrors, ref checksum history, state/lag/alarms, spot checks (design §10); UI in M6
- [x] Non-forge upstreams: stepped fetch shared with imports (commit ranges, split commits, across queued jobs, refs move when complete), `.lfsconfig` endpoint
- [x] GitHub backups: push webhooks per mirror (HMAC-SHA256, optional registration via the GitHub API), sealed upstream tokens, bulk "mirror all repositories of a user/org" API and form

## M5 — Deployment and adapters

- [x] Cloudflare Worker app with accounts (D1), federation and scheduled mirror sync
- [x] Wrangler environments `alpha`, `beta`, `gamma` and a three-instance E2E test
- [x] S3 storage adapter (`@git-forge/s3`, presigned PUTs bound to length and SHA-256)
- [x] File system storage adapter (`@git-forge/node`)
- [x] Shared storage conformance suite for all adapters
- [x] Local S3 test environment (versitygw; Garage, SeaweedFS, RustFS evaluated)
- [x] Headless deployment on a Raspberry Pi: `apps/forge-node` serves the Worker's router over `node:http` with an SQLite file, `FsStorage` or `S3Storage`, an in-process job queue and a cron schedule; explicit `migrate` command; single executables for `linux-x64`/`linux-arm64` (Bun) in every release, Dockerfile, systemd units; E2E with a Worker under `wrangler dev` mirroring in both directions
- [x] Publish the `apps/forge-node` image to a container registry (multi-arch) from the release workflow (`ghcr.io/levino/git-forge-node`, `linux/amd64` and `linux/arm64`)
- [x] Durable jobs for Node deployments (job table in SQLite, migration `0021_jobs`, leases so a crash re-runs), so queued mirror jobs survive a restart instead of waiting for the next notification or scheduled run

## M5a — Large pushes

- [x] Streaming receive-pack and upload-pack with bounded memory, `packfile-uris`, geometric compaction
- [x] Server-side import: create or update a repository by pulling from a URL (no request body limit), in resumable steps driven by a queue
- [x] Import from GitHub (opt-in): issues, pull requests, comments, reviews, review comments, labels, milestones, releases and assets with their numbers, authors and times (migration `0023_imports`, design §7 *metadata*)
- [x] Chunked push helper: `git forge push` splits history into pushes below the platform body limit, using the unmodified git client; single executables per platform from the release workflow
- [x] Import and mirror sync: stream fetched packs into the streaming indexer (via `ingestPack`)
- [x] Import commits, blobs and LFS objects of any size; LFS endpoint from `.lfsconfig` (#51)
- [x] Remote helper `git-remote-forge`: resumable pack upload in parts (presigned or through the function), then a finalize call that indexes the pack and updates refs
- [ ] Finalize beyond one invocation's CPU budget (queued or stepwise)

## M5b — CI and distribution

Design: [design.md §15](design.md#ci).

- [x] Spike, part 1: YAML subset parser and workflow/job model in core (pure), push filters
- [x] Spike, part 1: Actions service, legacy flow (connectionData, OAuth client assertion, sessions, message long-poll, job renew/finish, timeline, logs, console lines, attachments)
- [x] Spike, part 1: GHES REST subset (`generate-jitconfig`, `registration-token`, `runner-registration`, list/get/delete runners, runs, jobs, job logs)
- [x] Spike, part 1: dispatch on push, one ephemeral JIT runner per job via `RunnerLauncher`, `needs` with skip on failure; job tokens (`GITHUB_TOKEN` read over Git HTTP, runtime token per job), instance secrets
- [x] Spike, part 1: Cloudflare Container definition for the runner (Dockerfile, `wrangler.jsonc`)
- [x] Spike, part 2: the real-runner integration test runs in GitHub CI
- [x] Runner container on Cloudflare Containers from the instance repository: Workers Builds builds `runner/Dockerfile`, `basic` instance type by default, inactivity timeout for jobs longer than 15 minutes
- [ ] Hello-world workflow on the production instance; deploy a Worker with `wrangler` from our own CI
- [x] `uses:` actions: `ActionDownloadInfo` with tarballs streamed from repositories on the forge (mirrors of `actions/checkout`, …), name mapping, optional fallback to github.com tarballs; shallow fetch (`deepen`) for `actions/checkout`
- [x] Expressions server-side: job-level `if`, `runs-on` expressions, `strategy`/`matrix` (include/exclude, fail-fast, max-parallel), job outputs across `needs`, `env`/`defaults`, step `if`/`continue-on-error`/`timeout-minutes`, workflow `concurrency`
- [x] Cancellation (`JobCancellation`), job timeouts, reaper for expired locks, dead runners and lost launches, re-runs (all, failed, one job) as new attempts
- [x] Per-repository and per-environment secrets (AES-GCM in SQLite under an instance key), environments with required reviewers (`pending_deployments`), no secrets for untrusted runs
- [x] `workflow_dispatch` (typed inputs), `schedule` (cron table + Worker cron), `pull_request` trigger function (`queueRunsForPullRequest`, wired to collaboration's events); check runs per job through a `CheckRunSink`
- [x] `pull_request` runs from the collaboration package's pull request events; check runs written with its store
- [x] `paths`/`paths-ignore` filters; job-level `concurrency`; repository and environment variables (`vars`)
- [x] Results service without a broker: `actions/cache@v4` (v1 and v2), artifacts v4, OIDC ID tokens (ES256 or EdDSA)
- [ ] Official artifact actions v4 on non-`*.localhost` hosts (client-side GHES check in `@actions/artifact`), artifacts v3
- [ ] Verify ID token trust against real AWS / Google Cloud accounts
- [ ] Broker and run service (v2 flow), message encryption (not needed so far)
- [ ] External providers: signed `workflow_job` webhook delivery, GitHub App auth (JWT → installation token, manifest flow) and PATs on `/api/v3`, org-level runners; try WarpBuild Enterprise, AWS CodeBuild, RunsOn
- [ ] `container:` and `services:` (Docker-in-Docker in the runner container)
- [x] Web UI for runs and live logs (runs per workflow, jobs, log polling, cancel, re-run all, failed or one job)
- [x] "Deploy to Cloudflare" button in the README pointing at the instance template; template wired to accounts (`BOOTSTRAP_TOKEN`)
- [x] Release artifact (bundled worker + migrations + checksums) and instance template with pinned version
- [x] Minimal instance template: one `wrangler.toml` whose `[build]` command downloads and verifies the pinned bundle, resources provisioned from it, self-migrating Worker, first admin via a one-time `instance_admin_claims` row; Deploy button on the monorepo subdirectory; release notes print the `V`/`S` pin and the release workflow pins it in the template
- [ ] Verify the Deploy button against a real Cloudflare account

## M6 — Web UI (Astro SSR)

Design: [design.md §18](design.md#18-web-ui).

- [x] Astro SSR as the Worker entry, middleware hands non-UI paths to `createForge`, `UI=false` for headless instances, one release bundle
- [x] Home, explore, user and organization profiles
- [x] File tree, file view with server-side highlighting, sanitized Markdown (README), commits with path history, commit diff, branches, tags
- [x] LFS previews (images, video, audio, PDF) via the media URLs
- [x] Dark mode, responsive layout, page rendering tests, Playwright E2E against `wrangler dev`
- [x] Login pages (sign-in, invite, device code entry, break-glass) rendered by the UI from the login package's page models; sessions in the middleware; account menu with sign-out
- [x] Account settings: personal access tokens (create, revoke), passkeys (add, remove), linking an OIDC identity
- [x] Notifications inbox (unread/all, mark read, done, all read) and repository releases (list, tag page, notes, asset downloads)
- [x] New repository page (owner, name, visibility, default branch) and repository import with a status page; "New" in the navbar and on the dashboard
- [x] List and unlink linked OIDC identities, list and end sessions
- [x] Organizations and teams (create, members and owners, teams, team members, team repository roles)
- [x] JSON API for organizations and teams on the same operations (`/api/orgs/…`)
- [x] Instance admin page and API (admins, trusted instances, list of this instance's mirrors with their sync state and alarms, `GET /api/admin/mirrors`)
- [ ] Mirror overview UI on top of the attestation API of design §10 (lag, ref checksum history, spot checks)
- [x] Repository settings (visibility, collaborators, branch protection, federation trust)
- [x] Repository lifecycle: description, website, topics (`/api/v3` shape), rename and transfer with redirects for pages, API, Git and LFS, archive (read-only), soft delete with a 7-day grace period, account and organization renames; stable storage prefixes (migration `0024`)
- [x] Mirror settings, status and alarms (add, sync, deep check, detach)
- [x] Blame, syntax highlighting in diffs and Markdown code blocks
- [x] Explore and profile listings without one access check per repository (one SQL query, stored default branch and last commit time, sort and paging)
- [x] Search box and results page (repositories, issues and pull requests, discussions, users)
- [ ] Issue/PR UI: labels, assignees, milestones, reviewer requests, suggested changes, `#N` autolinks in rendered Markdown

## M7 — Collaboration

Design: [design.md §17](design.md#17-collaboration).

- [x] Branch protection (v1)
- [x] Issues: create/edit/close/reopen, comments, labels, assignees, milestones, locking, events and timeline, `#N` cross references, numbering shared with pull requests and discussions
- [x] Git diff and merge in core identical to git (xdiff port, tree diff, binary/LFS detection, merge bases incl. criss-cross, merge commit, squash, rebase, conflict detection)
- [x] Pull requests from branches of the same repository: files, diff, commits, mergeability, merge methods, auto-close linked issues, manual merges detected on push
- [x] Reviews (approve / request changes / comment, pending reviews, dismissal), line comments anchored to commit + path + line, requested reviewers, stale-review dismissal on push
- [x] Enforce required reviews and status checks on merge via `evaluateBranchUpdate(..., { via: 'pull-request' })`
- [x] Commit statuses and check runs (storage and API; CI writes them)
- [x] Discussions: categories, threads, answers
- [x] REST API under `/api/v3` with GitHub-compatible shapes, wired into the Worker
- [x] Web UI: issues (list, new, timeline, comment, close/reopen), pull requests (list, new, conversation with reviews, checks and merge box, commits, files with inline line comments), discussions (categories, threads, replies, answers)
- [x] Forks on the same instance (object sharing through alternates, fork network listing) and pull requests from forks (head objects and their LFS objects copied into the base, maintainers can modify, untrusted CI)
- [x] Web UI for forks: Fork button, fork list, *forked from*, pull requests from forks
- [ ] Forks across instances (fork a mirror, pull requests between instances)
- [ ] Forks keep resolving their upstream after it is renamed again over a reused name or deleted (alternates name the upstream by its name; private forks do not inherit upstream collaborators)
- [x] CODEOWNERS parsing for `require_code_owner_reviews` (owners of every changed file must approve, user owners are requested as reviewers)
- [x] Rename detection in merges (port of git's `diffcore-rename` scoring and pairing; edits follow renamed files, rename/rename and rename/delete conflicts)
- [x] Directory renames in merges: adds into a renamed directory conflict like git's default, adds into a deleted directory merge
- [ ] In-browser conflict resolution
- [x] Search (FTS5): repositories, issues, pull requests, discussions with comments, users; access-filtered; `/api/search`, `/api/v3/search/*`
- [ ] Reactions, notifications
- [ ] Submit via form

## Later

- [x] Email adapter in the core, Amazon SES v2 implementation (`@git-forge/ses`), console adapter for development
- [x] SMTP email adapter for the Node deployment (`@git-forge/smtp`: STARTTLS or implicit TLS, `AUTH PLAIN`/`LOGIN`)
- [x] Notifications: event log, watching and participating subscriptions, mentions, per-user settings, inbox API (`/api/v3/notifications`), email digests (instant, hourly, daily) via the job queue (design §16)
- [x] Event producers: push, create/delete, mirror alarms, CI job and run completion, releases
- [x] Event producers: issues, pull requests, reviews, comments, discussions and discussion comments (emitted by the collaboration package, mapped in the Worker)
- [x] Webhooks per repository and organization: GitHub-compatible payloads and headers, signatures, delivery log, retries, redelivery, ping
- [ ] Webhooks: `POST …/hooks/{id}/tests`, GitHub App installations, encrypted secrets
- [x] Releases: GitHub-compatible REST API, tags created on publish, assets stored as LFS objects behind the media URL, download redirects
- [ ] Releases: source archives (`tarball_url`, `zipball_url`), generated release notes, web UI
- [x] Built-in backups (design §19): scheduled bounded `backup` jobs copy a database dump and every object into a write-once `BACKUP` target (R2 bucket lock, S3 Object Lock) with SHA-256 verification; admin panel and API (status, run now, verify); `git-forge-node restore`, `restore-sql`, `backup-verify` (migration `0029_backups`)
- [ ] Partial visibility
- [x] External mirror verification: ref checksums, signed attestations, byte-range spot checks of packs and LFS objects, signed overview (design §10)
- [x] Pages (design §20): branch source (`/` or `/docs`, redeploy on push), tar upload deployments, GitHub's Pages REST API, `PAGES_HOST` pattern and `PAGES_DOMAINS` from config, immutable content-addressed deployments with atomic switch, LFS files via media URLs, content types, `404.html`, CDN cache headers, private sites via a session handoff to a host-only cookie
- [x] Pages: deployments from stored workflow artifacts, so `actions/deploy-pages` works unchanged
- [ ] Pages: settings in the web UI, preview deployments, `pages/health`
