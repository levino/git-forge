# forge-worker

The Cloudflare Worker deployment of git-forge. It serves the web UI, Git over
HTTPS (smart HTTP protocol v2 for fetch, `receive-pack` for push, dumb HTTP for
protocol v0 clients) and Git LFS straight from an R2 bucket, keeps accounts,
tokens and federation trust in D1, and keeps mirrors current through signed
push notifications, a job queue and a daily Cron Trigger as safety net.

`src/app.ts` is platform-neutral: `createForge({ storage, db, ... })` takes a
core `Storage` and an accounts `Database` and returns `{ fetch, services,
scheduled, runJob }`. `src/cloudflare.ts` wires the Cloudflare bindings
(`R2Storage`, `d1Database`, `QueueJobs` and the queue consumer) and parses the
vars (`src/config.ts`). The same app runs in Node for the unit tests and the
benchmark, and as a deployment of its own without Cloudflare and without the
web UI in [apps/forge-node](../forge-node) (which imports `forge-worker/app`
and `forge-worker/config`).

The Worker entry is `src/worker.ts`, an Astro SSR app (`@astrojs/cloudflare`,
`astro.config.ts`): the middleware (`src/middleware.ts`) hands Git, LFS, media,
raw, API, Actions and well-known paths to `createForge` and renders every
other path as a page from `src/pages`. With `UI=false` the entry skips Astro
and serves only the forge. Pages use the view models in `src/ui` on top of the
read functions of `@git-forge/core` and check access with the same
`repositoryAccess` as the API (`docs/design.md` §18).

## Configuration

| Name | Kind | Purpose |
|---|---|---|
| `BUCKET` | R2 binding | Repository data in the bucket layout of `docs/design.md` (`repos/<owner>/<name>/…`). |
| `DB` | D1 binding | Accounts, tokens, repository roles, branch protection, instance trust, audit log (`@git-forge/accounts`). Migrations come from `packages/accounts/migrations`; the Worker applies pending ones on start (also adopting those applied with `wrangler d1 migrations apply` through `migrations_dir`). |
| `JOBS` | Queue binding, optional | Queue `git-forge-jobs` (`git-forge-<env>-jobs` per environment) for background jobs: mirror syncs, mirror notification deliveries, subscription renewals, deep checks (`src/mirror-federation.ts`), event fan-out, webhook deliveries and email digests (`@git-forge/notifications`). Without it, fan-out and deliveries run inline in the request. One message per invocation (`max_batch_size: 1`), retried with exponential backoff. With `JOBS`, `INSTANCE_KEY` and `PUBLIC_URL` set, push notifications are on. |
| `IMPORTS` | Queue binding, optional | Queue `git-forge-imports` (`git-forge-<env>-imports` per environment), produced and consumed by this Worker. Each message is one step of a server-side import in its own invocation. Without it the import endpoint answers `503`. |
| Cron `17 3 * * *` | trigger | Daily safety net: with `JOBS`, enqueues a sync (and a subscription renewal) for every due auto mirror and the periodic deep checks; without `JOBS`, syncs due mirrors inline. It also re-dispatches stuck webhook deliveries and due email digests. |
| `BOOTSTRAP_TOKEN` | secret | Allows exactly one claim of the first instance admin, on `/-/setup` or with `POST /api/bootstrap`. Also the key (via HKDF) for secrets stored in the admin area. |
| `INSTANCE_KEY` | secret, optional | Ed25519 private JWK of this instance. Needed to mirror private repositories from other instances; also publishes `/.well-known/openid-configuration` and `/.well-known/jwks.json`. Generate with `pnpm --filter forge-worker instance-key`. |
| `PUBLIC_URL` | var, optional | Base URL of the instance, used as its issuer (when minting) and audience (when verifying instance tokens). Defaults to the origin of the request; scheduled sync with instance tokens needs it set. |
| `MAX_PUSH_BYTES` | var, optional | Largest accepted push request. Unset by default: pushes are streamed, so only Cloudflare's request body limit applies (see Large pushes). |
| `R2_S3_ENDPOINT`, `R2_BUCKET_NAME`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | vars/secrets, optional | All four or none. `https://<account>.r2.cloudflarestorage.com`, the `BUCKET` bucket name and a bucket-scoped R2 key (token id, hex SHA-256 of the token value; see the instance README). `git-remote-forge` parts and LFS objects go directly to R2 via presigned URLs (LFS verify re-hashes through the binding). |
| `PACKFILE_URI_BASE` | var, optional | Base URL for `packfile-uris` (e.g. a CDN in front of the forge). Defaults to the origin of the request. Pack URIs are only offered for repositories anyone may read. |
| `COMPACT_MAX_BYTES` | var, optional | Largest pack compaction run after a push through `waitUntil`, default 128 MiB; `0` disables it. |
| `MAX_LFS_OBJECT_BYTES` | var | Largest accepted LFS object, default 100 MiB (Cloudflare's request body limit on the Free and Pro plans). Larger objects get a per-object error in the batch API and `413` on `PUT`. With presigned R2 URLs up to about 5 GiB. |
| `MIRROR_INTERVAL_MINUTES` | var | Minimum time between two scheduled syncs of a mirror, default 30; `wrangler.jsonc` sets 1440 (daily) because notifications carry the real-time updates; `0` syncs on every cron tick. |
| `MIRROR_UNIT_BYTES` | var | `0` (default): a mirror sync copies all new packs and LFS objects in one job. Otherwise a byte budget per invocation: one job per pack and per LFS object, a final job moves the refs, units above the budget stay pending (`docs/design.md` §12). For a mirror on the Workers Free plan. |
| `MIRROR_DEEP_CHECK_DAYS` | var | Every how many days a mirror gets the full re-verification (re-hash every object, recompute every index), default 30, `0` = only on demand. |
| `ALLOW_INSECURE_FEDERATION` | var | `true` lets the instance fetch other instances' JWKS over plain HTTP. Only for local tests. |
| `ACTIONS` | var | `true` (default in every environment): CI is on. Pushes queue workflow runs, `/_services/actions` (Actions service for `actions/runner`) and `/api/v3` (GHES-style runner, run, job, secrets, environments and tarball API) are served. The CI tables come from `packages/accounts/migrations/0005_actions.sql` and `0009_actions_workflows.sql`. The `*/5 * * * *` cron runs scheduled workflows and the reaper (timeouts, dead runners, expired tokens); it needs `PUBLIC_URL` to launch runners. |
| `ACTIONS_SECRETS` | secret, optional | JSON object of instance secrets for workflows, e.g. `{"CLOUDFLARE_API_TOKEN":"…"}`. Sent only to the runner of a job of a trusted run, as secret variables. |
| `ACTIONS_SECRETS_KEY` | secret, optional | 32 random bytes, base64 or hex (`openssl rand -base64 32`). Encrypts repository and environment secrets in D1 (AES-256-GCM). Without it the secrets API answers `503`. Changing it makes stored secrets unreadable. |
| `ACTIONS_REPOSITORIES` | var, optional | Where `uses: owner/repo@ref` is looked up on this forge, as JSON, e.g. `{"actions/*": "mirrors/*"}`. Without a mapping, `actions/checkout` is looked up as the repository `actions/checkout`. |
| `ACTIONS_GITHUB_FALLBACK` | var, optional | `true` (or an API base URL): actions that have no repository on this forge are downloaded from `api.github.com` tarballs. Default: off, unresolved actions fail the job. |
| `ACTIONS_INSTANCE_ID` | var, optional | Stable GUID reported by the Actions location service. |
| `UI` | var | `false` turns the web UI off: every request goes to the forge and `/` answers the health JSON. For headless instances such as backup mirrors. Default: on. |
| `ALLOW_INSECURE_WEBHOOKS` | var | `true` allows webhook URLs over plain HTTP and to local or private hosts. Only for local tests. |
| `EMAIL_PROVIDER` | var | `none` (default, no emails), `console` (logs each email as a JSON line; the default of the test environments) or `ses` (Amazon SES v2, `@git-forge/ses`). |
| `EMAIL_FROM` | var | Sender address, e.g. `Forge <forge@example.org>`; required with a provider. |
| `SES_REGION` | var | SES region, e.g. `eu-central-1`. |
| `SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY` | secrets | IAM credentials with `ses:SendEmail`. |
| `SES_ENDPOINT`, `SES_CONFIGURATION_SET` | var, optional | Override of `https://email.<region>.amazonaws.com` (tests) and a configuration set. |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID` | vars, optional | OIDC login (authorization code + PKCE) against this issuer, e.g. a ZITADEL project. Both or neither; `https` only (`http` only on loopback, for tests). Register `<PUBLIC_URL>/login/oidc/callback` as redirect URI at the provider. |
| `OIDC_CLIENT_SECRET` | secret, optional | Client secret (`client_secret_basic`). Without it the instance is a public client and sends only `client_id` with the PKCE verifier. |
| `OIDC_NAME` | var, optional | Name of the provider on the login page, e.g. `Dorf-ID`. |
| `OIDC_SCOPES` | var, optional | Default `openid profile email`. |
| `SELF_SIGNUP` | var | `true` lets unknown OIDC identities and new passkeys create accounts. Default `false`: an invite (`POST /api/admin/invites`) or an existing link is needed. |
| `PASSKEYS` | var | `false` turns passkeys off for an OIDC-only instance: the passkey login, registration and `/api/user/passkeys` endpoints answer `404`, and the sign-in, invite and settings pages show no passkey buttons. Stored passkeys stay in the database but cannot be used. Break-glass is unaffected. Default `true`. |
| `BREAK_GLASS_PUBLIC_KEY` | var, optional | Ed25519 public JWK of the offline break-glass key (see [Login](#login)). Empty: break-glass login is off. |
| `PAGES_HOST` | var, optional | Host pattern of Pages sites, e.g. `{owner}.pages.example.org` (optionally with `http://`/`https://` and a port; default `https`). Project sites are served at `https://<owner>.pages.example.org/<repo>/`, the repository named like the host (`<owner>.pages.example.org`) at the root. Empty: Pages hosts are off. Needs a Workers route for the wildcard host, see [Pages](#pages). |
| `PAGES_DOMAINS` | var, optional | Custom domains per repository as JSON, e.g. `{"docs.example.com": "acme/handbook"}`. Each domain must also be declared as a Workers custom domain in `routes`. |
| `PAGES_MAX_AGE` | var | `Cache-Control` max-age of public Pages responses in seconds, default 60. |
| `CDN_BUCKET` | R2 binding, optional | Public bucket for [LFS publish](#lfs-publish): LFS objects of public repositories are copied there on push, keyed by oid. |
| `LFS_PUBLISH_PREFIX` | var, optional | Key prefix inside `CDN_BUCKET`, e.g. `lfs/`. Default: none. |
| `RUNNER` | Durable Object + Container | `RunnerContainer` (`src/runner-container.ts`, image `runner/Dockerfile`): one container per CI job with the official `actions/runner` and a JIT config. Declared in every environment; without the binding, jobs wait for a runner registered by hand. |

Repositories are **private by default**; visibility is set per repository.
There is no global "public read" switch any more.

## Authentication

- **Git and LFS** use personal access tokens (`gfp_…`) as HTTP Basic password
  (any user name) or as `Authorization: Bearer`, e.g.
  `https://git:<token>@forge.example/acme/site.git`. The token's scopes cap the
  access (`repo:read`, `repo:write`, `repo:admin`); the repository role decides
  the rest (`@git-forge/accounts`).
- **Other instances** present a short-lived EdDSA JWT. The core tells the
  authorizer whether a request is Git or LFS, so the token scopes `git:read`
  and `lfs:read` are checked separately.
- **The JSON API** needs a token with `repo:admin`, or a browser session
  (cookie) plus the CSRF token from `GET /api/session` in `X-CSRF-Token` for
  every state-changing request from the same origin.
- **People** sign in interactively with OIDC, passkeys or the break-glass key;
  the CLI gets a token with the chosen scope through `git forge auth login`. See
  [Login](#login).

## API

| Route | Who | Purpose |
|---|---|---|
| `POST /api/bootstrap` `{login, email?}` | `Bearer <BOOTSTRAP_TOKEN>` | Creates the first instance admin and returns `{login, token}` (a `repo:admin` token without expiry). `409` once an admin exists. |
| `POST /api/admin/users` `{login, email?, admin?}` | instance admin | Creates a user. |
| `POST /api/admin/users/{login}/tokens` `{name?, scopes?, expiresAt?}` | instance admin | Issues a personal access token (shown once). |
| `GET /api/admin/instances` | instance admin | Trusted instances: `[{issuer, pinnedThumbprint, createdAt}]`. |
| `POST /api/admin/instances` `{issuer, pinnedThumbprint?}` | instance admin | Trusts another instance (`422` for an issuer that is not an http(s) URL). |
| `DELETE /api/admin/instances/{issuer}` | instance admin | Stops trusting an instance (issuer URL-encoded). `204`. |
| `GET /api/admin/admins` | instance admin | Instance admins: `[{id, login}]`. |
| `PUT\|DELETE /api/admin/admins/{login}` | instance admin | Makes a user an instance admin or removes them; the last admin cannot be removed (`422`). `204`. |
| `GET /api/admin/mirrors` | instance admin | Every mirror of the instance: `[{repository, config, status}]`. |
| `GET /api/admin/overview` | instance admin | `{update, imports, failures, usage, cost}`: version and latest release, recent imports, failed jobs, bytes per repository, monthly cost estimate. |
| `GET /api/admin/setup` | instance admin | `{checks, oidc, canSeal}`: deployment checks and the OIDC source. |
| `PUT\|DELETE /api/admin/oidc` `{issuer, clientId, clientSecret?, name?}` | instance admin | OIDC in the database (secret sealed); `409` while the `OIDC_*` vars are set. |
| `GET\|POST /api/admin/update` | instance admin | Checks for a release; `POST` commits its pin to the connected instance repository. |
| `PUT\|DELETE /api/admin/update/repository` `{repository, token}` | instance admin | Connects the GitHub instance repository with a token that can write `wrangler.toml`. |
| `POST /api/admin/jobs/{id}/retry` | instance admin | Queues a failed job again. `202`. |
| `POST /api/admin/usage/recount` | instance admin | Recounts the stored bytes of every repository in background jobs. `202`. |
| `POST /api/orgs` `{login}` | signed-in user (session or `repo:admin` token) | Creates an organization; the caller becomes its first owner. Reserved names (`api`, `explore`, `settings`, `orgs`, …) answer `422`. |
| `GET /api/orgs/{org}` | members, instance admins | `{organization, membership, canAdminister, members, teams}`; `404` for everyone else. |
| `PUT\|DELETE /api/orgs/{org}/members/{login}` `{role}` | organization owner, instance admin | Adds a member, changes the role (`member`, `owner`) or removes them; the last owner stays (`422`). `204`. |
| `POST /api/orgs/{org}/teams` `{slug, name?}` | organization owner, instance admin | Creates a team. |
| `GET /api/orgs/{org}/teams/{slug}` | members, instance admins | Team with members and repository roles. |
| `PUT\|DELETE /api/orgs/{org}/teams/{slug}/members/{login}` `{role}` | organization owner, instance admin | Team membership (`member`, `maintainer`); only organization members can join. `204`. |
| `PUT\|DELETE /api/orgs/{org}/teams/{slug}/repos/{name}` `{role}` | organization owner, instance admin | Role of the team on a repository of the organization. `204`. |
| `POST /api/repos` `{owner, name, visibility?, defaultBranch?}` | the owner, or an instance admin | Creates a repository in R2 and D1 (`visibility` defaults to `private`). |
| `PATCH /api/repos/{owner}/{name}` `{visibility}` | repository admin | Changes visibility. |
| `PUT /api/repos/{owner}/{name}/collaborators/{login}` `{role}` | repository admin | Sets a collaborator role. |
| `POST /api/repos/{owner}/{name}/instances` `{issuer}` | repository admin | Lets a trusted instance read this repository (Git and LFS). |
| `GET /api/repos/{owner}/{name}/mirrors` | repository admin | Mirror configs and status (last run, alarms, pending LFS objects). |
| `POST /api/repos/{owner}/{name}/mirrors` `{url, remote?, mode?, namespace?, lfs?, lfsUrl?, auth?}` | repository admin | Configures a mirror. `auth: "instance"` presents an instance token to the upstream and, with jobs enabled, subscribes to its push notifications. The first sync is enqueued. |
| `POST /api/repos/{owner}/{name}/mirrors/{remote}/sync` | repository admin | Syncs now; `502` with the error if the sync failed. |
| `POST /api/repos/{owner}/{name}/mirrors/{remote}/verify` | repository admin | Runs the deep check now and stores the result in the mirror status. |
| `POST\|DELETE /api/federation/subscriptions` `{repository, callback}` | trusted instance (instance JWT) | Subscribes to push notifications for a repository it may read; the callback must be below its own issuer URL. |
| `POST /api/federation/notify/{owner}/{name}/{remote}` | trusted upstream (signed body, `application/jwt`) | Push notification. `401` for an untrusted issuer, unknown key, bad signature, wrong audience or expired token; `403` if this mirror does not follow that repository; `200 up-to-date` for a duplicate; `202 queued` otherwise. |
| `POST /api/repos/{owner}/{name}/mirrors/{remote}/detach` | repository admin | Stops syncing. |
| `GET /api/repos/{owner}/{name}/mirrors/overview` | read access | Mirror overview for the UI (`docs/design.md` §10): this repository's ref checksum, every mirror known from subscriptions or attestations with `state` (`current`, `behind`, `diverged`, `unknown`, `stale`, `unattested`), `lagSeconds`, `alarms`, the last signed attestation and spot check, and the repository's own upstreams. With an instance key, `signed` is the same summary as a JWT signed by this instance. |
| `POST /api/federation/attestations` | trusted mirror (signed body, `application/jwt`) | A mirror's signed ref checksum after a sync. `401` for an untrusted issuer or invalid token, `404` if the issuer may not read the repository, `202` when recorded (and a spot check is enqueued at most once a day). |
| `POST /api/repos/{owner}/{name}/import` `{url, token?, username?, lfs?, lfsUrl?, commitsPerStep?, visibility?, defaultBranch?}` | repository admin or instance admin; for a new repository the owner or an instance admin | Imports from a Git URL (smart HTTP v2 or dumb HTTP) without a request body limit, creating the repository first if needed (as `POST /api/repos`). `token` is sent as HTTP Basic password with `username` (default `git`), travels only in the queue messages and is never stored. Refs land in `refs/heads/*` and `refs/tags/*`; rewritten refs are archived, local refs missing upstream are kept. Without `lfsUrl` the LFS endpoint comes from `.lfsconfig` (git-lfs precedence); LFS objects of any size are imported. `202` with the state and a `Location`, `409` while an import runs; an import without progress for 30 minutes (its worker or process died) is taken over and continues from its last step. |
| `GET /api/repos/{owner}/{name}/import` | repository admin | Import state: `phase` (`discover`, `graph`, `fetch`, `lfs`, `refs`, `done`, `failed`), progress, ref updates, missing LFS objects, last error. Starting a failed import again with the same URL resumes it. |
| `POST /api/admin/invites` `{login?, user?, email?, expiresInDays?}` | instance admin | Invite for a new account (`login` fixed or chosen by the invitee) or for an existing `user` (to add a passkey or link OIDC). Returns `{code, url, expiresAt}`; the URL is `/login/invite/{code}`, valid once, 7 days by default. |
| `GET /api/user` | token or session | The authenticated user: `{id, login, admin, via, ceiling}`. |
| `GET /api/health` | anyone | `{"ok": true}` |

Instance admins count as admins of every repository.

### Notifications, webhooks and releases

GitHub-compatible endpoints under `/api/v3` (any user token for the user's
own notifications; hooks need `repo:admin` and repository admin or
organization owner; releases need read or write access):

- Notifications: `GET|PUT /api/v3/notifications`,
  `/api/v3/notifications/threads/{id}[/subscription]`,
  `/api/v3/repos/{owner}/{name}/notifications`, watching with
  `GET|PUT|DELETE /api/v3/repos/{owner}/{name}/subscription`, settings with
  `GET|PATCH /api/v3/user/notification-settings`
  (`packages/notifications/README.md`).
- Webhooks: `/api/v3/repos/{owner}/{name}/hooks…` and
  `/api/v3/orgs/{org}/hooks…` including deliveries and redelivery.
- Releases: `/api/v3/repos/{owner}/{name}/releases…`, uploads at
  `/api/uploads/repos/{owner}/{name}/releases/{id}/assets?name=`, downloads at
  `/{owner}/{name}/releases/download/{tag}/{name}` (`packages/releases/README.md`).

Pushes, mirror alarms, CI completions and releases are emitted as events
(`docs/design.md` §18); links in payloads and emails use `PUBLIC_URL`, or the
request origin when it is unset.

Branch protection rules use the GitHub-style API of `@git-forge/accounts`
(`GET /api/repos/{owner}/{name}/branch-protection`,
`GET|PUT|DELETE /api/repos/{owner}/{name}/branches/{pattern}/protection`) and
are enforced on every push and every pull request merge. The rules live in
D1 (`DB`); the API accepts `repo:admin` tokens, instance JWTs and browser
sessions (CSRF token and same origin on `PUT` and `DELETE`), and
`receive-pack` asks `createGitAccess(...).pushPolicy` before every ref
transaction. `forge-node` runs the same `createForge` and gets the same
wiring over its SQLite file.

Issues, pull requests, reviews, statuses, check runs and discussions are
served under `/api/v3/repos/{owner}/{name}/…` with GitHub-compatible shapes
(routes in the [collaboration README](../../packages/collaboration/README.md#rest-api-apiv3));
the GHES subset of the CI package keeps `/api/v3/repos/{owner}/{name}/actions/…`.
Every successful push refreshes the repository's open pull requests (head
sha, stale-review dismissal, merges done with plain `git push`) and closes
issues referenced with a closing keyword by commits on the default branch.
A merge through the API runs the push pipeline (CI, mirror notifications,
`push` webhooks). Issue, comment, pull request and review activity becomes
notification events (webhooks, inbox, digests). Browser sessions work on
`/api/v3` the same way as on the other APIs (CSRF token required).

## Login

Routes of `createLoginHandler` (`@git-forge/accounts`), mounted by
`createForge` before the JSON API. Pages are minimal server-rendered HTML; the
web UI (`src/pages/-/login.astro`) replaces them through `createForge({
renderLoginPage })` and calls the same core functions. Signed-in users manage
their tokens and passkeys at `/settings`.

| Route | Purpose |
|---|---|
| `GET /login?return_to=/path` | Sign-in page: OIDC button, passkey sign-in, passkey sign-up (with `SELF_SIGNUP`), break-glass link. |
| `GET /login/oidc?return_to=…&invite=…&link=1` | Starts OIDC: PKCE (S256), `state` and `nonce` stored as a one-time challenge, `state` also bound to the browser in a 10-minute cookie. `link=1` links the identity to the signed-in account. |
| `GET /login/oidc/callback` | Checks the bound `state`, exchanges the code, verifies the ID token (JWKS, `RS256`/`ES256`/`EdDSA`, `iss`, `aud`, `azp`, `exp`, `iat`, `nonce`) and signs in, links, redeems an invite or (with `SELF_SIGNUP`) creates the account. |
| `POST /login/passkey/options`, `POST /login/passkey` | WebAuthn authentication (discoverable credentials, user verification required). |
| `POST /login/passkey/register/options` `{invite?, login?}`, `POST /login/passkey/register` `{handle, credential, name?}` | WebAuthn registration, attestation `none`. With a session (and CSRF token) it adds a passkey to that account; with an invite or `SELF_SIGNUP` it creates the account. |
| `GET /login/invite/{code}` | Invite page (OIDC or passkey). |
| `POST /login/cli/start` | Starts a CLI login (PKCE S256, scope, `redirect_uri` out-of-band or loopback); returns `authorization_url` `/login/cli/{id}`. |
| `GET\|POST /login/cli/{id}` | Consent page; approve shows a one-time code or redirects to the loopback URI. |
| `POST /login/cli/token` | Redeems the code once with the PKCE verifier for a token with the granted scope. |
| `POST /login/device/code` `client_id=git-forge-cli&client_host=…&scope=…` | RFC 8628 device authorization, 15 minutes, interval 5 s. |
| `GET /login/device?user_code=…`, `POST /login/device` | Consent page (session, CSRF). |
| `POST /login/device/token` | Polling: `authorization_pending`, `slow_down`, `access_denied`, `expired_token`, or a 90-day token with the granted scope. |
| `GET\|POST /login/break-glass` | Paste a token signed with the offline break-glass key; opens a one-hour session for an instance admin. |
| `POST /logout` | Revokes the session (CSRF token required). |
| `GET /api/session` | `{login, userId, method, expiresAt, csrfToken, admin}` or `401`. |
| `GET /api/user/passkeys`, `DELETE /api/user/passkeys/{id}` | The signed-in user's passkeys. |

Login endpoints are rate-limited per `CF-Connecting-IP` (`429`); the cron
purges expired login state (design §8).

Session cookies are `HttpOnly`, `SameSite=Lax`, `Path=/`, 30 days (break-glass
one hour), and on `https` origins `Secure` with the `__Host-` prefix
(`__Host-gf_session`); on plain `http` (local development) the name is
`gf_session`. Only the SHA-256 of the session id is stored. Every
state-changing request under `/login`, `/logout` and the JSON API that relies
on the cookie must come from the instance's own origin (`Origin` header) and
carry the CSRF token, which is derived from the session id
(`SHA-256("git-forge csrf\n" + id)`), so it needs no storage and is useless
without the cookie.

### Break-glass key

Generate the key pair offline, keep the private key off the instance (e.g. on
paper or a hardware-encrypted stick) and put only the public key into
`wrangler.jsonc`:

```sh
pnpm --filter forge-worker break-glass keygen > break-glass.private.jwk
# prints BREAK_GLASS_PUBLIC_KEY={"kty":"OKP","crv":"Ed25519","x":"…"} on stderr
```

When OIDC is down, sign a token for an existing instance admin (valid at most
10 minutes, default 5, usable once) and paste it at `/login/break-glass`:

```sh
pnpm --filter forge-worker break-glass sign --key break-glass.private.jwk \
  --url https://forge.example --login alice
```

## Media and raw URLs

- `GET|HEAD /<owner>/<name>/media/<oid>[/<filename>]` serves an LFS object by
  its SHA-256 oid, immutable and with Range support (authorized as LFS read).
- `GET|HEAD /<owner>/<name>/raw/<ref>/<path>` serves a file from a branch, tag,
  `HEAD` or full commit id; LFS pointers redirect to the media URL (authorized
  as Git read). Details in `docs/design.md` §7.

### Putting a CDN in front (e.g. Bunny)

The media and raw URLs are made for a pull-zone CDN; it fetches from the
Worker on a cache miss, nothing is uploaded.

1. Create a pull zone with the Worker URL (or its custom domain) as origin.
2. Leave caching to the origin headers: media URLs and raw URLs with a full
   commit id are `immutable` for a year, raw URLs on branches and tags are
   cached for 60 seconds. Query strings are not used, so the cache may ignore
   them.
3. For private repositories, create a user for the CDN (`POST
   /api/admin/users`), give it the `read` role on the repositories
   (`PUT /api/repos/{owner}/{name}/collaborators/{login}`), issue it a token
   with the scope `repo:read`, and let the pull zone send it with every origin
   request. In Bunny add an Edge Rule with the action "Set Request Header"
   (applied to origin requests) `Authorization: Bearer <token>`. The token can
   read but cannot push. Whatever the CDN has cached is readable by anyone who
   can reach the pull zone, so protect the pull zone itself (Bunny token
   authentication) unless the content is meant to be public.

Then `https://<zone>.b-cdn.net/acme/site/raw/main/photos/a.jpg` redirects to
`https://<zone>.b-cdn.net/acme/site/media/<oid>/a.jpg`, which the CDN keeps.

## Pages

Static sites per repository, like GitHub Pages, served by the same Worker
under `PAGES_HOST` and `PAGES_DOMAINS` (design: `docs/design.md` §20).

- **Branch source** (`build_type: legacy`): the files of a branch, at `/` or
  `/docs`, are deployed when Pages is enabled and on every push to that
  branch. No Jekyll build: the files are served as they are.
- **Workflow source** (`build_type: workflow`): `POST
  /api/v3/repos/{owner}/{repo}/pages/deployments` with `artifact_id` (what
  `actions/deploy-pages` sends) once the instance can read workflow
  artifacts, or today with the site as a tar body (`Content-Type:
  application/x-tar`, gzip allowed; the format `actions/upload-pages-artifact`
  produces) from any CI:

```sh
tar -czf site.tar.gz -C dist .
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/x-tar' \
  --data-binary @site.tar.gz "https://git.example.org/api/v3/repos/acme/site/pages/deployments?pages_build_version=$(git rev-parse HEAD)"
```

| Route | Access |
|---|---|
| `GET /api/v3/repos/{owner}/{repo}/pages` | read |
| `POST\|PUT\|DELETE /api/v3/repos/{owner}/{repo}/pages {build_type?, source?: {branch, path}}` | admin |
| `GET /api/v3/repos/{owner}/{repo}/pages/builds`, `…/builds/latest`, `…/builds/{id}` | read |
| `POST /api/v3/repos/{owner}/{repo}/pages/builds` | write; redeploys the source branch |
| `POST /api/v3/repos/{owner}/{repo}/pages/deployments` | write, or the `GITHUB_TOKEN` of a trusted, non-pull-request run of the repository |
| `GET /api/v3/repos/{owner}/{repo}/pages/deployments/{id}`, `POST …/{id}/cancel` | read / write |

Every deployment is immutable and content-addressed; the newest successful
one becomes active in one database update. Paths resolve like GitHub Pages
(`/dir/` → `dir/index.html`, `/page` → `page.html`, `404.html` for misses),
`Content-Type` comes from the extension (HTML is `text/html` here, unlike the
raw URLs), and every file has its SHA-256 as `ETag`. LFS files of public
repositories redirect to the immutable media URL on `PUBLIC_URL`.

**Hosts.** Use a separate registrable domain for Pages (like `github.io`),
not a subdomain of the forge, so that site scripts cannot set cookies for
the forge. On Cloudflare declare the wildcard as a route on its zone and
custom domains as custom domains:

```jsonc
"routes": [
  { "pattern": "git.example.com", "custom_domain": true },
  { "pattern": "*.pages.example.net/*", "zone_name": "example.net" },
  { "pattern": "docs.example.com", "custom_domain": true }
],
"vars": { "PAGES_HOST": "{owner}.pages.example.net", "PAGES_DOMAINS": "{\"docs.example.com\": \"acme/handbook\"}" }
```

plus a proxied wildcard DNS record `*.pages` and an edge certificate that
covers it (Advanced Certificate Manager for a second-level wildcard).

**Private sites** are readable for users with read access only. A visitor
without a Pages session is sent to `<PUBLIC_URL>/_pages/authorize`; with a
forge session (after signing in if needed) the forge hands a one-time code
(two minutes) to `/__pages/callback` on the Pages host, which sets an
`HttpOnly` cookie for that host only (twelve hours). Tokens work too
(`Authorization: Bearer`), e.g. for a pull-zone CDN. Private responses are
`private, no-cache`; public ones `public, max-age=<PAGES_MAX_AGE>`, so a
pull-zone CDN can sit in front of the Pages host the same way as in front of
the media URLs. Private sites need `PUBLIC_URL`.

## LFS publish

With a `CDN_BUCKET` binding, every push to a **public** repository copies
the LFS objects it references to that bucket under `<LFS_PUBLISH_PREFIX><oid>`
(a job per 100 objects; inline without `JOBS`). Objects are never
overwritten or deleted, so a CDN (or anything else) can be refilled from
hashes alone, and the bucket outlives the forge. `POST
/api/repos/{owner}/{repo}/lfs/publish` (repository admin) backfills all LFS
objects of a public repository, e.g. after it was made public. Private
repositories are never published.

```jsonc
"r2_buckets": [
  { "binding": "BUCKET", "bucket_name": "git-forge" },
  { "binding": "CDN_BUCKET", "bucket_name": "git-forge-public" }
]
```

Make the bucket public (custom domain or `r2.dev`) and fetch
`https://cdn.example.org/<oid>`. With an external pull-zone CDN such as
Bunny you do not need this: point the pull zone at the media URLs (see
above); it fills itself on cache misses from `/{owner}/{repo}/media/{oid}`,
which is immutable as well. Publishing is for setups that want the bytes
outside the forge (a static bucket, a second CDN, a mirror that serves from
hashes), or a CDN that should never reach the Worker.

## Deploying to Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/levino/git-forge/tree/main/templates/instance)

New instances are deployed from the
[instance template](../../templates/instance): the button copies that
self-contained subdirectory into a new repository, connects Workers Builds,
asks for `BOOTSTRAP_TOKEN` and creates the R2 bucket, the D1 database and the
queues from its `wrangler.toml`. The template deploys a pinned, checksummed
release bundle of this Worker, which migrates its database on start
(`docs/design.md` §15). A button pointing at this directory would not work:
Cloudflare requires a subdirectory to be self-contained, and this Worker
builds from the workspace packages.

A Workers **Paid** plan is required for an instance that receives pushes:
the Free plan allows 10 ms of CPU per request, which is not enough to index
even a small push (see the measurements below), and `limits.cpu_ms` cannot be
set on it. A pure mirror can follow small pushes on the Free plan once it has
been seeded (see "A pure mirror on the Workers Free plan").

From a checkout of this repository (for development instances):

```sh
pnpm install
cd apps/forge-worker
npx wrangler login
openssl rand -base64 32 | npx wrangler secret put BOOTSTRAP_TOKEN
pnpm run deploy
npx wrangler d1 migrations apply DB --remote
```

Pushes larger than one staging chunk (4 MiB) are staged under `tmp/` while
they are indexed (`docs/design.md` §6). The forge never deletes anything, so
let the bucket expire that prefix:

```sh
npx wrangler r2 bucket lifecycle add git-forge expire-staging tmp/ --expire-days 1
```

The first `wrangler deploy` creates the bucket, the database and the import
queue from the binding names; no IDs need to be filled in. The Worker applies
pending migrations itself when it starts; `wrangler d1 migrations apply DB
--remote` before `wrangler deploy` still works and is adopted.

### First admin

```sh
curl -X POST https://git-forge.<account>.workers.dev/api/bootstrap \
  -H "Authorization: Bearer $BOOTSTRAP_TOKEN" -H 'Content-Type: application/json' \
  -d '{"login":"alice"}'
# {"login":"alice","token":"gfp_…"}
```

Keep the returned token; it is shown once. Afterwards the bootstrap token is
useless and may be deleted (`npx wrangler secret delete BOOTSTRAP_TOKEN`).

```sh
curl -X POST https://git-forge.<account>.workers.dev/api/repos \
  -H "Authorization: Bearer $TOKEN" -d '{"owner":"alice","name":"site"}'
git push https://git:$TOKEN@git-forge.<account>.workers.dev/alice/site.git main
```

### Federation

To mirror private repositories of other instances, give the instance a key and
its public URL:

```sh
pnpm --filter forge-worker instance-key | npx wrangler secret put INSTANCE_KEY
pnpm run deploy --var PUBLIC_URL:https://git-forge.<account>.workers.dev
```

(or set `PUBLIC_URL` under `vars`). On the upstream an instance admin trusts
the mirror's URL (`POST /api/admin/instances`), and a repository admin grants
it the repository (`POST /api/repos/{owner}/{name}/instances`). The mirror then
configures `POST /api/repos/{owner}/{name}/mirrors` with
`{"url": "https://upstream.example/owner/name.git", "auth": "instance"}`.
Upstream refs land under `refs/upstream/origin/*`; clients additionally see
them as `refs/heads/*` and `refs/tags/*` with `HEAD` on the upstream default
branch, so a plain `git clone` of the mirror checks out what the upstream
would (own branches pushed to the mirror take precedence, detach turns the
view into real branches; `docs/design.md` §4). To mirror a mirror, use
`"namespace": "upstream/origin/"`. For push notifications the mirror must
also trust the upstream (`POST /api/admin/instances` on the mirror), because
it verifies the upstream's signature; the subscription itself is made by the
mirror when the mirror is configured and renewed by the daily cron. After a
push the upstream enqueues one notification per subscriber, the mirror
enqueues a copy-only sync (`docs/design.md` §4, §7), and a mirror whose refs
moved notifies its own subscribers, so chains propagate without cron.
After every successful sync a mirror with `auth: "instance"` sends a signed
attestation of the ref state it holds to the upstream, which checks it
against its own ref checksum history and spot-checks random byte ranges of
packs and LFS objects on the mirror (`GET …/mirrors/overview`). Spot checks
of a private mirror need the mirror to grant the upstream read access too.

To use your own domain, add a `routes` entry with `custom_domain: true` to
`wrangler.jsonc` or attach the domain in the dashboard.

## CI

Architecture, protocol and gaps: `docs/design.md` §15 and
[`@git-forge/actions`](../../packages/actions). In short: a push that adds or
changes `.github/workflows/*.yml` queues a run; each job gets an ephemeral
JIT runner, started in a `RunnerContainer` or by hand:

```sh
curl -sX POST https://forge.example/api/v3/repos/acme/site/actions/runners/generate-jitconfig \
  -H "Authorization: Bearer $ADMIN_PAT" \
  -d '{"name":"laptop","runner_group_id":1,"labels":["self-hosted","linux"]}' | jq -r .encoded_jit_config > jit
./run.sh --jitconfig "$(cat jit)"
```

Jobs can use actions with `uses:`: the runner asks the forge for a tarball,
which the forge serves from a repository on the forge, typically a mirror of
the action's GitHub repository. With `ACTIONS_REPOSITORIES` set to
`{"actions/*": "mirrors/*"}`, `actions/checkout@v4` is served from a public
mirror `mirrors/checkout`:

```sh
curl -sX POST https://forge.example/api/admin/users -H "Authorization: Bearer $ADMIN_PAT" -d '{"login":"mirrors"}'
curl -sX POST https://forge.example/api/repos -H "Authorization: Bearer $ADMIN_PAT" -d '{"owner":"mirrors","name":"checkout","visibility":"public"}'
curl -sX POST https://forge.example/api/repos/mirrors/checkout/mirrors -H "Authorization: Bearer $ADMIN_PAT" -d '{"url":"https://github.com/actions/checkout.git","lfs":false}'
```

Jobs may use action repositories of their own owner and public ones.

Secrets, environments, cancellation and re-runs use the GitHub REST paths
under `/api/v3` (`actions/secrets/{name}` with `{"value": "…"}`,
`environments/{name}`, `actions/runs/{id}/cancel`, `…/rerun-failed-jobs`,
`actions/workflows/{file}/dispatches`); see
[`@git-forge/actions`](../../packages/actions).

The runner container is declared in `wrangler.jsonc` for every environment
(`containers`, the `RUNNER` Durable Object binding, its migration), so
`wrangler deploy` builds `runner/Dockerfile` (the official
`ghcr.io/actions/actions-runner` image plus Git and Node.js) and pushes it to
the Cloudflare registry; Docker must be available where you deploy, and
Containers need the Workers Paid plan. Workers Builds has Docker, so a
Git-connected deploy builds the image as well. `release/build-release.sh`
bundles with `--containers-rollout=none`, which skips the image.
`RunnerContainer` starts the container with the entrypoint
`run.sh --jitconfig <config>` and an inactivity timeout of 6 hours; the runner
is ephemeral and the container stops after its job. The instance type is
`basic` (1/4 vCPU, 1 GiB, 4 GB disk); the image does not fit `lite`. Pin
`RUNNER_VERSION` in the Dockerfile to a runner release you have tested.
`wrangler dev` runs with `dev.enable_containers: false`.

## Several instances: `alpha`, `beta`, `gamma`

`wrangler.jsonc` defines three environments, each with its own Worker name,
R2 bucket and D1 database (`git-forge-alpha`, …). Every Cloudflare resource
comes from the config, nothing is created in the dashboard: buckets and
databases have names but no IDs and queues are declared by name, so the
first `wrangler deploy` provisions them; migrations come from `migrations_dir`; cron and vars are declared as well
(`BOOTSTRAP_TOKEN` is set after the first deploy, see below). An environment goes from
nothing to running with:

```sh
pnpm run deploy --env alpha
npx wrangler d1 migrations apply DB --env alpha --remote
npx wrangler secret put BOOTSTRAP_TOKEN --env alpha
```

Later deployments apply migrations first, then deploy. For federation each
environment also needs `INSTANCE_KEY` (secret) and `PUBLIC_URL` (var). Locally:

```sh
npx wrangler d1 migrations apply DB --env beta --local
pnpm run build
npx wrangler dev dist/server/entry.mjs --config wrangler.jsonc --env beta --port 8788
```

## Large pushes

The Worker no longer caps pushes itself (`MAX_PUSH_BYTES` is optional), so the
limit is Cloudflare's request body size for the zone's plan: 100 MB on Free
and Pro, 200 MB on Business and 500 MB by default on Enterprise (check the
current Workers limits). A push larger than that fails with HTTP 413 before it
reaches the Worker. Ways around it:

- **Git LFS for large files.** With the `R2_*` key, LFS objects go straight to
  the bucket through presigned URLs; without it they are proxied.
- **The remote helper.** `git push forge::https://forge.example/acme/site main`
  (`git-remote-forge`, `packages/cli`) uploads resumable parts; finalize is
  bounded by `limits.cpu_ms`, not the body limit.
- **Chunked pushes.** `git forge push` from `packages/cli` splits a push into
  several pushes below a budget: `git forge push --max-bytes 90MiB <url> main`.
  Each push only carries the objects the forge does not have yet.
- **Server-side import.** Import the repository from where it already lives
  with `POST /api/repos/{owner}/{name}/import`. Each step runs as one queue
  message with its own CPU budget (`limits.cpu_ms`), fetches about
  `commitsPerStep` commits and at most 32 MiB of pack, and streams it into the
  same indexer as a push (`docs/design.md` §7, Import); larger commits and
  blobs are split, so imports have no size limit. Mirrors fetch the same way.

Every staging chunk is one R2 write and is read back once when the final pack
is written, so a 500 MB push performs a few hundred R2 operations.

## Local development

```sh
cp .dev.vars.example .dev.vars
npx wrangler d1 migrations apply DB --local
pnpm --filter forge-worker dev
```

`astro dev` runs the Worker in workerd through the Cloudflare Vite plugin,
with a local R2 bucket and D1 database (Miniflare) persisted under
`.wrangler/`, and reloads pages on change. `pnpm --filter forge-worker
preview` builds the bundle and runs it with `wrangler dev` exactly as it is
deployed. `.dev.vars` is gitignored.

Deploying from a checkout is `pnpm --filter forge-worker run deploy` (`astro
build`, then `wrangler deploy dist/server/entry.mjs`); environments take
`-- --env alpha`. Because the entry is built by Astro, plain `wrangler dev`
and `wrangler deploy` need the built `dist/server/entry.mjs` as script
argument.

## Tests

- `pnpm --filter forge-worker test` runs the unit tests, the page rendering
  tests, the end-to-end suites and the browser tests (about two minutes, part
  of the root `pnpm test`). The end-to-end and browser suites build the bundle
  once (`astro build`) and run `wrangler dev` on `dist/server/entry.mjs`. Each
  `wrangler dev` start applies the D1 migrations with
  `wrangler d1 migrations apply --local` first, as a deployment does.
- `test/unit/ui.test.ts`: which paths go to the forge and which to the UI,
  the cross-site write check, Markdown sanitizing and link rewriting,
  highlighting and formatting.
- `test/pages` (`vitest.pages.config.ts`): pages rendered with Astro's
  container API against a Node forge with a repository pushed by the real
  `git`: file tree, README, private repositories as 404, empty repositories,
  branches with slashes and tags, highlighted and escaped file contents,
  Markdown files, image previews, commit lists with path history, commit
  diffs, explore, home and profiles.
- `test/browser` (Playwright, `playwright.config.ts`, desktop and mobile
  Chromium): against `wrangler dev` with a repository pushed by `git` and
  `git-lfs`: navigation from the home page to a file and its history and
  diff, the LFS image preview, relative README links, 404 for private
  repositories, light and dark colour schemes and the cached stylesheet. CI
  installs Chromium with `playwright install`; elsewhere the version of
  `@playwright/test` must match the installed browsers.
- `test/pages/collaboration.test.ts`: issue, pull request and discussion pages
  against the real collaboration backend (create, comment, close, permission
  refusals, review, line comment, merge, answers).
- `test/pages/settings.test.ts`: repository settings as admin and non-admin
  (visibility, collaborators, branch protection read back through the API,
  mirrors, federation grants).
- `test/pages/organizations.test.ts`: creating an organization, people,
  teams and team members as owner, member and outsider; sessions on the
  account page.
- `test/pages/actions.test.ts`: workflow runs and jobs from a real push, the
  live job log (escape codes removed, polling URL), runs of other
  repositories hidden, the workflow filter, cancel and re-run (refused to
  readers and visitors, refused while the run is still in progress).
- `test/pages/admin.test.ts`: the instance admin page (404 for others, the
  last admin stays, trusting and distrusting instances, mirror overview).
- `test/unit/admin-api.test.ts`: the organization and team JSON API and the
  instance admin API (admins, trusted instances, mirrors, reserved names).
- `test/browser/collaboration.spec.ts`: a passkey user comments on a diff line
  through the inline form and opens an issue.
- `test/browser/settings.spec.ts`: creating an organization and a team, the
  session list, repository settings (visibility, collaborator, branch
  protection), cancelling and re-running a workflow run, and the instance
  admin page (trust an instance, mirror overview).
- `test/browser/login.spec.ts`: an invited user signs up with a passkey
  (Chromium's virtual authenticator), creates and revokes a token at
  `/settings`, signs out and signs in with the passkey again; a cross-site
  settings form is refused.
- `test/browser/pages.spec.ts`: an invited user signs up with a passkey,
  gets read access to a private repository with a Pages site and opens it on
  `octo.pages.localhost`: the forge session is handed to the Pages host and
  the host-only cookie is set; a visitor without a session lands on the
  sign-in page.
- `test/e2e/pages.e2e.test.ts`: Pages on `wrangler dev` with repositories
  pushed by `git` and `git-lfs`: a branch deployment with types, redirects,
  `404.html` and `ETag`, LFS files redirected to the media URL, redeploy on
  push through the job queue, an uploaded tar deployment, and private sites
  (sign-in redirect, token access, streamed LFS bytes).
- `test/unit/pages.test.ts`: Pages and LFS publish in the Node forge with
  real `git`/`git-lfs` pushes over HTTP: publish on push only for public
  repositories, backfill, redeploy on push, private sites.
- `test/e2e/headless.e2e.test.ts`: the same bundle with `UI=false` serves only
  the forge; with the UI, pages and the API answer and cross-site form posts
  are refused.
- Unit tests (`test/unit`) run the app in Node with `MemoryStorage` and
  `node:sqlite`: settings, media/raw authorization, branch protection API and
  push policy with the real `git` client, bootstrap, admin API, PAT authorization, private
  defaults, visibility and collaborators, the LFS size limit, presigned R2 LFS URLs, the import
  endpoint's authorization and validation, federation and
  scheduled sync between two in-process instances over real HTTP, and the
  shape of the wrangler environments. `test/unit/login.test.ts` drives every
  login flow through `createForge` with a software authenticator (ES256
  passkeys built byte by byte) and the mock OIDC provider of
  `@git-forge/accounts`: invite and self-signup, phishing origin, missing user
  verification, replayed counters, CSRF and origin checks, OIDC without
  invite, unbound and forged callbacks, the device flow (pending, slow_down,
  approve, deny, one token per approval, scope cap), the CLI login (paste,
  loopback), rate limits, purging and break-glass (replay, non-admin, foreign
  key).
- `test/e2e/login.e2e.test.ts` starts `wrangler dev` against a mock OIDC
  provider (ES256) on a local HTTP server: an unknown identity is refused, an
  invite links it to the bootstrapped admin, the session creates a
  repository with its CSRF token; then the real CLI runs
  `git forge auth login --scopes repo:admin` (code pasted from the consent
  page), `git forge repo create --remote origin`, and plain `git push` and
  `git clone` with an LFS file work through the configured credential helper
  alone; `--browser-redirect` (loopback) and `--device` log in too; a passkey-only account is created from
  an invite and signs in again; the break-glass key opens an admin session
  once.
- `test/browser/cli-login.spec.ts`: CLI consent in Chromium (code page,
  loopback redirect under the CSP).
- `test/unit/events.test.ts` pushes with
  the real `git` client into a forge without a job queue and checks the push
  webhook (commits read from the object database), watcher notifications and
  emails, a release that creates its tag through the push pipeline, and a
  mirror alarm that reaches the mirror's admin.
- `test/e2e/events.e2e.test.ts` runs `wrangler dev` with a local webhook
  receiver and an HTTP mock of the SES API (`SES_ENDPOINT`): a signed `ping`
  on hook creation, a signed push webhook after a real `git push`, an inbox
  entry and a SigV4-signed `SendEmail` call for a watching collaborator, a
  redelivery with the same delivery id, and a release whose asset is uploaded
  to R2, redirected from `browser_download_url` and served by the media URL,
  with the tag visible to `git ls-remote`.
- `test/e2e/protection.e2e.test.ts` starts `wrangler dev` with a fresh D1
  database, protects `main` and `release/*` through the API (only the
  repository admin may), and checks with the real `git` client that a writer's
  force push and deletion of `main` are rejected as `[remote rejected]`
  (also with `--atomic`), that `release/*` allows force pushes but no
  deletion, that fast-forwards still work, and that the admin bypasses the
  rule until `enforce_admins` is set.
- `test/e2e/forge.e2e.test.ts` starts `wrangler dev` with a fresh local R2
  bucket and D1 database, bootstraps an admin, creates repositories, pushes a
  generated history of 120 commits with the real `git` client, clones it with
  protocol v2 and with `git -c protocol.version=0` (dumb HTTP), checks that
  repositories are private by default, pushes incrementally, force-pushes and
  checks the previous tip under `refs/archive/`, imports the generated
  repository from a local token-protected `git http-backend` server stepped
  through the local queue, pushes a 12 MiB pack that is staged in R2 while it
  is indexed, checks that pushes trigger compaction through `waitUntil` and
  clones with `packfile-uris`, pushes 24 MiB with `git forge push` against a
  16 MiB `MAX_PUSH_BYTES` (standing in for the platform limit), and fires the
  Cron Trigger through `/__scheduled`.
- `test/e2e/federation.e2e.test.ts` starts the `alpha`, `beta` and `gamma`
  environments as three `wrangler dev` processes with their own keys. It
  pushes a private repository with Git LFS objects to alpha with the real
  `git` and `git-lfs`; beta mirrors it from alpha, first failing with `401`,
  then succeeding once alpha trusts beta and grants the repository; gamma
  mirrors beta's `refs/upstream/origin/*` and may not read alpha directly. A
  force push on alpha must be archived on alpha, beta and gamma, raise a
  `history-rewritten` alarm on both mirrors, and bring its new LFS object down
  the chain. Those syncs are started by the Cron Trigger (which now
  enqueues them on the local Queue). Finally beta and gamma trust their
  upstreams, and a new push to alpha must reach beta and gamma through push
  notifications and the job queues alone, without any cron tick.
- `test/e2e/notify.e2e.test.ts` runs alpha → beta → gamma as three
  `createForge` instances in one Node process (own HTTP servers, SQLite,
  in-memory job queue, real keys): mirrors subscribe at their upstream; a push
  with an LFS object to alpha reaches gamma through notifications alone (the
  scheduled handler is never called; the first delivery is made to fail to
  exercise the retry); packs are byte-identical on all three; duplicate
  notifications are no-ops; notifications from untrusted issuers, with
  foreign keys, for other audiences or about other repositories are
  rejected; subscriptions from untrusted instances or with foreign callbacks
  are refused; a force push is archived with an alarm on both mirrors; the
  deep check passes; and a push still succeeds when the job queue is down.
- `test/e2e/actions.e2e.test.ts` stores a repository secret, pushes a
  matrix workflow to a private repository, checks that the run is queued in
  D1, registers a JIT runner through `/api/v3`, takes the job over the
  Actions protocol (OAuth assertion, session, message, renew) with instance
  and repository secrets, checks the check runs through the collaboration
  API, clones the repository with
  the job's `GITHUB_TOKEN` and cancels the run (the runner receives a
  `JobCancellation` message, the queued leg is cancelled).
- `test/e2e/media.e2e.test.ts` starts an instance, issues a `repo:read`
  token, uploads a JPEG to a private repository with the real `git lfs push`
  and reads it back through the media and raw URLs (headers, Range, HEAD,
  `304`, redirect).
- `test/e2e/presigned-lfs.e2e.test.ts`: real `git` and `git-lfs` against
  presigned URLs to a stand-in bucket, verify through the binding in workerd.
- `pnpm --filter forge-worker bench` measures CPU time and memory per
  operation (below); `pnpm --filter forge-worker bench:mirror` measures a pure
  mirror per invocation (further below).

The R2 adapter itself is tested inside workerd in `packages/cloudflare`.

## CPU time and memory

`pnpm --filter forge-worker bench [small medium large xl xxl]` runs the same
request handler in Node.js (the same V8 engine as workerd) with `FsStorage`
from `@git-forge/node` (so stored data does not count as memory), drives it
with the real `git` client and records process CPU time per operation. Process
CPU time includes V8's garbage-collector threads and the file system calls of
`FsStorage`, so these are upper bounds; the Worker also spends no CPU time
while waiting for R2. Measured on the development container (Node 22.22,
git 2.43, 4 vCPUs) with the default budgets (16 MiB object cache, 4 MiB
staging chunks):

| operation | requests | CPU total (ms) | CPU max per request (ms) | wall (ms) | peak JS memory (MiB) |
|---|---|---|---|---|---|
| push small (120 commits, 1047 objects, 0.9 MiB pack) | 3 | 451 | 441 | 259 | 17 |
| clone v2 small | 3 | 49 | 36 | 89 | 0 |
| clone v2 with packfile-uris small | 4 | 19 | 7 | 98 | 3 |
| clone dumb small | 8 | 16 | 3 | 87 | 2 |
| push incremental small (20 commits) | 3 | 245 | 240 | 159 | 7 |
| fetch incremental small | 3 | 156 | 142 | 134 | 5 |
| clone v2 small (2 packs) | 3 | 63 | 54 | 94 | 6 |
| compact small (2 packs into 1) | 0 | 172 | 172 | 131 | 8 |
| push medium (500 commits, 4382 objects, 14.1 MiB pack) | 4 | 1418 | 1411 | 873 | 37 |
| clone v2 medium | 3 | 132 | 119 | 413 | 0 |
| clone v2 with packfile-uris medium | 4 | 47 | 29 | 340 | 14 |
| clone dumb medium | 8 | 73 | 63 | 346 | 10 |
| push incremental medium (20 commits) | 3 | 320 | 315 | 169 | 11 |
| fetch incremental medium | 3 | 274 | 260 | 255 | 10 |
| clone v2 medium (2 packs) | 3 | 356 | 350 | 443 | 18 |
| compact medium (2 packs into 1) | 0 | 751 | 751 | 515 | 24 |
| push large (600 commits, 5272 objects, 32.0 MiB pack) | 4 | 2290 | 2279 | 1589 | 44 |
| clone v2 large | 3 | 309 | 293 | 778 | 0 |
| clone v2 with packfile-uris large | 4 | 120 | 102 | 671 | 20 |
| clone dumb large | 8 | 107 | 96 | 740 | 23 |
| push incremental large (20 commits) | 3 | 327 | 323 | 187 | 13 |
| fetch incremental large | 3 | 327 | 319 | 326 | 11 |
| clone v2 large (2 packs) | 3 | 729 | 718 | 799 | 22 |
| compact large (2 packs into 1) | 0 | 1131 | 1131 | 849 | 22 |
| push xl (400 commits, 1680 objects, 200.6 MiB pack) | 4 | 9154 | 9145 | 7469 | 37 |
| clone v2 xl | 3 | 1483 | 1473 | 3524 | 26 |
| clone v2 with packfile-uris xl | 4 | 720 | 702 | 3052 | 31 |
| clone dumb xl | 8 | 719 | 707 | 3079 | 32 |
| push incremental xl (20 commits) | 3 | 218 | 213 | 123 | 11 |
| fetch incremental xl | 3 | 177 | 168 | 841 | 17 |
| clone v2 xl (2 packs) | 3 | 3140 | 3131 | 3659 | 29 |
| compact xl (2 packs into 1) | 0 | 3278 | 3278 | 2702 | 36 |
| push xxl (1000 commits, 4200 objects, 1025.6 MiB pack) | 4 | 50048 | 50022 | 44300 | 38 |
| clone v2 xxl | 3 | 5943 | 5922 | 26543 | 24 |
| clone v2 with packfile-uris xxl | 4 | 2698 | 2672 | 20113 | 33 |
| clone dumb xxl | 8 | 2792 | 2766 | 21155 | 34 |
| push incremental xxl (20 commits) | 3 | 193 | 185 | 137 | 6 |
| fetch incremental xxl | 3 | 211 | 200 | 472 | 0 |
| clone v2 xxl (2 packs) | 3 | 13188 | 13181 | 24937 | 38 |
| compact xxl (2 packs into 1) | 0 | 14425 | 14425 | 12918 | 35 |

`small`, `medium` and `large` are text-heavy histories with some binary
files; `xl` and `xxl` mostly consist of incompressible 5 and 10 MiB blobs. The
"incremental" rows push 20 more commits and pull them into an existing clone;
"2 packs" clones before compaction, "compact" then merges both packs. The
peak memory column samples the JS heap plus array buffers every 5 ms without
forcing garbage collection, so it includes garbage that V8 has not collected
yet and short peaks can be missed. `packages/node/test/streaming-memory.test.ts`
checks the bound with a 64 MiB push under a 4 MiB budget and a 96 MiB heap
limit.

Before the streaming core (same container, measured with in-memory storage
whose data counted as memory), a 32 MiB push cost 2.7 s of CPU and a protocol
v2 clone of it 10.1 s; the core buffered whole requests and response packs,
pushes were capped at 16 MiB and clones beyond about 15 MiB risked running out
of memory.

Conclusions for the configuration:

- **Memory no longer grows with the pack.** A push keeps a byte-budgeted
  object cache (16 MiB), one staging chunk (4 MiB) and about 60–100 bytes of
  metadata per object (id, offset, CRC, type, delta base, hash table slots)
  — the same order as the `.idx` file itself. Peaks stayed below 50 MiB for
  every size up to 1 GiB. The 128 MB isolate therefore limits a single push
  to roughly half a million objects, not to a number of bytes. Objects that
  are delta bases are materialized whole, so a single huge, delta-compressed
  file can still need a few times its own size; such objects are limited to
  64 MiB and large files belong in LFS anyway.
- **Push** costs about 45–75 ms of CPU per MiB for large packs (inflating,
  hashing and CRC-ing every object, writing staging chunks and the final
  pack) and up to 0.15 s per MiB for packs of many small text objects, whose
  inflated size is several times the pack size. A 1 GiB pack needs about 50 s
  of CPU, well within the maximum `limits.cpu_ms` of 300 000; `wrangler.jsonc`
  sets 60 000, which covers about 1 GiB of incompressible or 400 MiB of
  text-heavy pack. Raise it if you expect larger initial pushes.
- **Clone over protocol v2** streams the stored pack verbatim when there is
  one pack (about 6 ms of CPU per MiB, mostly for the side-band framing), and
  concatenates several packs with a recomputed header and trailer otherwise
  (about 13–16 ms per MiB, dominated by SHA-1). Compaction after each push keeps
  the number of packs logarithmic in the number of pushes. With
  `packfile-uris` (clients that set `fetch.uriProtocols`, e.g.
  `git -c fetch.uriProtocols=https clone …`) the client downloads the stored
  packs directly; behind a CDN (`PACKFILE_URI_BASE`) those downloads cost the
  Worker nothing.
- **Incremental fetches** walk the commits the client has, the new commits and
  the trees of the boundary commits, then copy stored entries (including
  deltas, sent as thin-pack deltas when the client has the base) instead of
  recompressing them.
- **Clone over dumb HTTP** remains the cheapest path for public repositories
  and could also be served directly from a public R2 bucket.

## A pure mirror on the Workers Free plan

`pnpm --filter forge-worker bench:mirror` runs an upstream instance in a
child process and a mirror in the measuring process (`createForge` with
SQLite, the in-memory job queue and an in-memory bucket that, like R2, spends
no JavaScript CPU on ETags or on joining chunks). It pushes generated
histories to the upstream with the real `git` client and records, for every
invocation on the mirror, process CPU time, storage operations and outbound
fetches. Each push leads to one notification request, one copy-only sync job
and one delivery job to a subscriber of the mirror. The "replay" rows repeat
the notification handling, the sync job and the delivery in process against
a snapshot of the mirror's bucket and the recorded upstream responses. They
exclude Node's JavaScript HTTP client and server (workerd's `fetch` is
native) and SQLite (D1 is remote I/O, not CPU) and are the better estimate
for the Worker; the live rows are upper bounds. The sync job is replayed
twice: with the JavaScript hashes and with a native streaming hash
(`node:crypto` in the benchmark, standing in for `crypto.DigestStream`,
which the Worker uses). Median and range of three runs on the development
container, Node 22.22:

| scenario | invocation | CPU ms, median | range | storage ops | fetches |
|---|---|---|---|---|---|
| small repo, initial push (120 commits, 1047 objects, 0.9 MiB pack) | notification request | 8.6 | 8.1–10.4 | 3 | 2 (JWKS, cold) |
| | sync job | 38.6 | 32.4–42.0 | 23 | 5 |
| | delivery job | 3.1 | 3.0–5.0 | 1 | 1 |
| | replay: notification handler | 1.7 | 1.4–1.8 | | |
| | replay: copy-only sync job | 19.7 | 19.0–21.4 | | 5 |
| | replay: the same, native streaming hash | 10.2 | 8.5–10.6 | | 5 |
| | replay: delivery job | 1.1 | 1.0–1.6 | | 1 |
| small repo, incremental push (1 commit, 2 files), 3 pushes | notification request | 4.3–4.8 | 3.9–6.3 | 3 | 0 |
| | sync job | 8.9–14.1 | 8.4–17.4 | 24–26 | 5 |
| | delivery job | 1.6–2.1 | 1.3–7.2 | 1 | 1 |
| | replay: notification handler | 1.3–1.5 | 1.1–2.2 | | |
| | replay: copy-only sync job | 4.7–10.2 | 4.6–11.8 | | 5 |
| | replay: the same, native streaming hash | 4.5–5.7 | 3.3–9.5 | | 5 |
| | replay: delivery job | 0.7 | 0.5–0.8 | | 1 |
| medium repo, initial push (500 commits, 4382 objects, 14.1 MiB pack) | notification request | 4.1 | 3.3–5.0 | 3 | 0 |
| | sync job | 178.5 | 165.2–192.0 | 22 | 5 |
| | replay: copy-only sync job | 140.0 | 105.6–217.5 | | 5 |
| | replay: the same, native streaming hash | 64.9 | 64.3–80.2 | | 5 |
| medium repo, incremental push (1 commit, 2 files), 3 pushes | notification request | 7.0–10.0 | 6.7–10.4 | 3 | 0 |
| | sync job | 10.6–14.9 | 8.4–17.1 | 23–25 | 5 |
| | replay: notification handler | 1.1–2.5 | 1.1–2.7 | | |
| | replay: copy-only sync job | 4.1–5.0 | 3.2–8.4 | | 5 |
| | replay: the same, native streaming hash | 3.5–5.0 | 2.6–6.7 | | 5 |
| | replay: delivery job | 0.6–0.8 | 0.5–0.8 | | 1 |
| for comparison: re-indexing sync (fetch strategy, protocol v2) into an empty mirror | small / medium | 215 / 851 | | | |
| deep check | small / medium | 574 / 2 651 | | | |
| hashing in JavaScript (`@noble/hashes`) | SHA-1 / SHA-256 per MiB | 5.9 / 6.7 | 5.5–12.4 | | |
| hashing natively (WebCrypto) | SHA-1 / SHA-256 per MiB | 1.8 / 1.2 | 1.2–1.9 | | |

Process CPU time includes V8's garbage-collector threads, and the container
is noisy (single values vary by up to ±50 %); read these as estimates.
A profile of the native replay of the 14 MiB copy shows the remaining
~4 ms per MiB mostly in Node's JavaScript implementation of web streams and
`Blob` reads, which workerd implements natively, so the Worker should do
better; Workers Logs show the real CPU time per invocation.

**Does a pure mirror fit the Free plan?** Workers Free allows 10 ms CPU per
invocation, 50 subrequests per invocation (calls to R2, KV and D1 count),
100 000 requests per day and five Cron Triggers per account; Queues are
included with 10 000 operations per day (about three per message) and
Workflows with 10 ms CPU per step (sources in `docs/design.md` §12).

- **Yes for the steady state:** a small push costs the mirror about 1.5 ms
  for the notification, 5 ms for the copy-only sync and under 1 ms per
  delivery to its own subscribers, each in its own invocation, with about 30
  subrequests per sync. Idle, the mirror runs one cron invocation per day.
- **Bulk data in units:** set `MIRROR_UNIT_BYTES` (start with `1048576`).
  Every pack and every LFS object is then copied in its own invocation,
  hashed natively with `crypto.DigestStream`; the refs move in a final job
  once all packs are present. Packs and LFS objects above the budget stay
  pending (`pendingPacks` with `oversized: true`, `lfsPending`) and the refs
  are not moved past a missing pack, so the mirror stays consistent; a
  sync on Workers Paid, a Node instance or a Pi with the same bucket picks
  them up (seed large repositories there once).
- The deep check and the re-indexing sync (mirrors of non-forge servers)
  need Workers Paid or a Node instance. A Free-plan deployment must drop
  `limits.cpu_ms` from `wrangler.jsonc`.

## Cost notes

Prices as published by Cloudflare at the time of writing; check the current
Workers and R2 pricing pages before relying on them.

- **Workers Paid:** 5 USD per month, including 10 million requests and
  30 million CPU milliseconds; beyond that 0.30 USD per million requests and
  0.02 USD per million CPU milliseconds. With the measurements above, the
  included CPU time covers about 60 000 pushes of a 1 MiB pack or about
  20 000 protocol v2 clones of a 200 MiB repository per month.
- **R2:** 0.015 USD per GB-month after 10 GB free, 4.50 USD per million
  Class A operations (writes, lists) after 1 million free, 0.36 USD per
  million Class B operations (reads) after 10 million free, and no egress
  fees. A push performs about six writes (pack, index, pack list, refs, server
  info) plus one write and one read per 4 MiB staging chunk, and a few reads;
  a clone a handful of reads. For a 100 GB archive
  storage dominates: about 1.35 USD per month.
- **D1** holds accounts, tokens, trust and the audit log: a few row reads
  per Git request, well within the free allowance for small instances.
- **Queues:** a notification, a sync and a delivery are three messages per
  push and mirror; idle instances send none.
