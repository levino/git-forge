# @git-forge/accounts

Identity, access control and instance federation for git-forge: users,
organizations, teams, repository roles, personal access tokens, apps, an
append-only audit log, and server-to-server trust between instances via
short-lived EdDSA JWTs.

Everything in `src/` uses only web-standard APIs (WebCrypto, `fetch`,
Streams) and runs unchanged on Cloudflare Workers, Deno, Bun and Node. The
node:sqlite adapter lives in the Node-only package
[`@git-forge/accounts-node`](../accounts-node).

## Why a separate package

`@git-forge/core` is the Git engine and knows nothing about who is asking; it
only exposes the `authorize` hook of `handleGitRequest`. Accounts bring a
database, a schema with migrations and a security-sensitive surface (tokens,
JWT verification) with a different change cadence. Keeping them apart means
the core stays usable as a plain Git-over-object-storage library (e.g. for a
read-only backup without accounts) and the accounts layer can be reviewed and
versioned on its own. `accounts` depends on `core` only for the `Authorize`
type and repository-name validation, so both agree on the same names.

## Database adapter

```ts
interface Database {
  all<T>(statement: Statement): Promise<T[]>
  run(statement: Statement): Promise<{ changes: number }>
  batch(statements: readonly Statement[]): Promise<{ changes: number }[]>
}
const statement = sql('SELECT * FROM accounts WHERE login = ?', login)
```

`batch` is the only transaction primitive and must be atomic. This is the
lowest common denominator: D1 has no interactive transactions but an atomic
`batch`, Durable Object SQLite has `transactionSync`, libSQL has `batch`, and
node:sqlite wraps the statements in `BEGIN IMMEDIATE … COMMIT`. Every
mutation in the store writes its rows and its audit entry in one batch, so a
change never exists without its audit record. Reads that precede a write
(e.g. "is this user an org member?") are checks for good error messages; the
schema's constraints are the real guard.

Adapters:

- `d1Database(env.DB)` — Cloudflare D1, typed against a minimal structural
  interface (`D1DatabaseLike`), so no Cloudflare types are needed.
- `nodeSqliteDatabase(new DatabaseSync(path))` / `openSqliteDatabase(path)` in
  `@git-forge/accounts-node` — Node 22 `node:sqlite` (tests, Raspberry Pi).
- Durable Object SQLite and libSQL are a few lines each against the same
  interface (`sql.exec(...).toArray()` inside `transactionSync`, resp.
  `client.batch(..., 'write')`).

Only SQLite SQL is used (`ON CONFLICT … DO UPDATE`, `COLLATE NOCASE`,
triggers with `RAISE`), all of which D1, Durable Objects and libSQL support.

## Migrations

- Hand-written files `migrations/NNNN_name.sql`. Statements are separated by
  a line `--> statement-breakpoint` (the drizzle convention), because a
  trigger body contains semicolons and D1 needs single statements in a batch.
- Applied files never change: `applyMigrations` stores the SHA-256 of every
  applied file in `schema_migrations` and refuses to start if a file was
  edited, a known migration is missing, or names are out of order. Fix
  mistakes with a new migration.
- Each migration plus its `schema_migrations` row is one atomic batch.
- Workers cannot read files, so `src/migrations.generated.ts` embeds the SQL.
  Regenerate it with `pnpm --filter @git-forge/accounts migrations:bundle`; a
  test fails if it is out of sync with `migrations/`.
- Ledgers: on Cloudflare the files are applied by
  `wrangler d1 migrations apply` (ledger `d1_migrations`): the instance
  template's `deploy.sh` runs it before the upload, `apps/forge-worker` points
  `migrations_dir` at this directory, and the Worker never migrates at
  runtime. Everywhere else (node:sqlite, libSQL, tests) use
  `applyMigrations(db, MIGRATIONS)` (ledger `schema_migrations`). One database
  uses one of the two, never both.

## Data model

| Table | Purpose |
|---|---|
| `accounts` | users and organizations share one login namespace (like GitHub); `default_repository_role` is an organization's base permission for members |
| `external_identities` | `(issuer, subject)` → user, the OIDC link |
| `organization_members` | role `member` or `owner` |
| `teams`, `team_members` | teams belong to one organization; members must be org members |
| `repositories` | owner is a user or an organization; `visibility` public/private |
| `repository_collaborators` | per-user role: `read`, `triage`, `write`, `maintain`, `admin` |
| `repository_teams` | per-team role on repositories of the team's organization |
| `apps`, `app_repositories` | machine accounts with explicit per-repository roles |
| `tokens` | personal and app tokens: SHA-256 hash only, display prefix, scopes, optional repository restriction, expiry, last use, revocation |
| `trusted_instances`, `instance_repositories` | federation trust: issuer (+ optional pinned key thumbprint) may read specific repositories |
| `mirror_subscriptions` | upstream side: which trusted instance wants a notification for which repository at which callback URL (migration `0004`) |
| `audit_log` | append-only; `UPDATE` and `DELETE` are rejected by triggers |
| `branch_protection_rules` | one rule per `(repository, pattern)`: force push, deletion, admin enforcement, push restriction, pull request reviews, status checks (migration `0002`) |
| `branch_protection_push_allowances` | who may push when a rule restricts pushes: `user`, `team`, `app` (by ID) or `role` (minimum role) |
| `branch_protection_status_checks` | required status check names per rule |
| `instance_admins` | users who administer the instance (create users and tokens, trust other instances, act as admin on every repository)  (migration `0003`) |
| `sessions` | browser sessions: SHA-256 of the session id, user, method (`oidc`, `passkey`, `break-glass`), expiry, last use, revocation (migration `0006`) |
| `webauthn_credentials` | passkeys: credential id, user handle, COSE algorithm (`-7`, `-8`, `-257`), public key as JWK, signature counter, AAGUID, revocation |
| `login_challenges` | one-time state of OIDC logins, WebAuthn ceremonies and used break-glass `jti`s, keyed by the hash of their handle, with expiry |
| `device_authorizations` | device flow: hash of the device code, user code, status (`pending`, `approved`, `denied`, `consumed`), poll interval, issued token |
| `invites` | hash of the invite code, fixed login or existing user, expiry, redemption |
| `actions_*` | CI state of `@git-forge/actions`: runners, hashed CI tokens, sessions, runs, jobs, timeline records, log index (migration `0005`; the schema lives here so that all D1 migrations come from one directory) |
| `collaboration_settings`, `repository_numbers`, `issues`, `issue_*`, `labels`, `milestones`, `pull_requests`, `pull_request_reviews`, `review_comments`, `review_requests`, `commit_statuses`, `check_runs`, `discussion*` | collaboration data of `@git-forge/collaboration` (migration `0008`); integer IDs for GitHub compatibility, never synced to mirrors |

Timestamps are Unix milliseconds. IDs are random UUIDs. Logins and repository
names are case-insensitive (`COLLATE NOCASE`).

## Permissions

`resolveAccess(principal, repo, grants)` is a pure function returning
`'none' | 'read' | 'triage' | 'write' | 'maintain' | 'admin'`. The store loads
the `grants` for one principal and repository (`store.grantsFor`); HTTP, UI,
LFS and sync all call the same function.

- Public repositories are readable by everyone, including anonymous callers.
- A user-owned repository: the owner is admin; others need a collaborator role.
- An organization-owned repository: org owners are admin; members get the
  organization's base role; team roles count only for org members;
  collaborator roles count for anyone (outside collaborators). The highest
  role wins.
- Apps get exactly their `app_repositories` role.
- Instances get `read` if the trust table grants the repository *and* the
  token names it.
- Tokens narrow, never widen: scopes cap access (`repo:read` → read,
  `repo:write` → write, `repo:admin` → admin, none → public only) and an
  optional repository list restricts the token to those repositories.

`decide(principal, access, required)` turns this into GitHub's HTTP
semantics: allowed; `401` with `WWW-Authenticate: Basic realm="git-forge"`
for anonymous callers (so `git` asks for credentials, also for pushes to
public repositories); `404` for authenticated callers who cannot see the
repository (private repositories look like missing ones); `403` for callers
who can see but not do.

## Tokens

- Personal: `gfp_` + 43 base64url characters (256 bits); app: `gfa_…`.
- Only `SHA-256(token)` is stored. A slow password hash is unnecessary for
  256-bit random secrets and would cost CPU on every Git request.
- `createPersonalAccessToken` / `createAppToken` return the token once.
- App tokens live at most one hour; personal tokens may have no expiry.
- `last_used_at` is updated at most once per minute per token.
- Tokens of disabled accounts or apps stop working immediately.

## Login

Interactive login for the web UI and the CLI, as pure functions plus thin
stores; the HTTP routes (`createLoginHandler`) and the coming web UI call the
same functions. Only `fetch` and WebCrypto are used.

| Module | Contents |
|---|---|
| `cbor.ts` | Minimal CBOR decoder (definite lengths, integer/text keys) for attestation objects and COSE keys. |
| `jose.ts` | Public JWKs (`RSA`, `EC` P-256, `OKP` Ed25519), compact JWS verification for `RS256`, `ES256`, `EdDSA` (never `none` or HMAC, `crit` rejected, `kid` and `alg` must match), DER → raw ECDSA signatures. |
| `webauthn.ts` | Creation/request options (attestation `none`, resident key and user verification required), `verifyRegistration`, `verifyAuthentication`: `clientDataJSON` type, challenge and origin, no cross-origin, RP ID hash, UP and UV flags, COSE key → JWK, signature over `authData ‖ SHA-256(clientDataJSON)`, increasing counter. Attestation statements are not verified: whatever format the authenticator sends counts as `none`. |
| `oidc.ts` | Discovery (issuer must match exactly, PKCE `S256`), authorization URL, code exchange (`client_secret_basic` or public client), ID token verification against the JWKS (re-fetched once per minute on an unknown key): `iss`, `aud`, `azp`, `exp`, `iat`, `nbf`, `nonce`, 60 s clock skew. |
| `sessions.ts` | Session tokens (`gfs_…`, 256 bits), cookie formatting and parsing, CSRF tokens derived from the session id, safe `return_to`. |
| `device.ts` | User codes (8 letters from `BCDFGHJKLMNPQRSTVWXZ`, shown as `XXXX-XXXX`), device codes, poll outcomes (`slow_down` adds 5 s). |
| `break-glass.ts` | Offline Ed25519 key: `signBreakGlassToken` (for the operator), `verifyBreakGlassToken` (purpose, audience = instance origin, at most 10 minutes). |
| `login-store.ts` | SQLite store for sessions, challenges, passkeys, device authorizations and invites. All one-time items are claimed with a conditional `UPDATE`, so a second use fails even under concurrency. |
| `login.ts` | The flows: `beginOidcLogin`/`completeOidcLogin`, `beginPasskeyRegistration`/`completePasskeyRegistration`, `beginPasskeyLogin`/`completePasskeyLogin`, `startDeviceAuthorization`/`decideDeviceAuthorization`/`pollDeviceToken`, `breakGlassLogin`, `startSession`. Errors are `LoginError` with a code and an HTTP status. |
| `login-http.ts`, `login-pages.ts` | `createLoginHandler` (routes in `apps/forge-worker/README.md`), `checkSession` (cookie + CSRF + same origin for unsafe methods) and the default HTML pages, replaceable through a `LoginPageRenderer`. |

Account rules:

- An OIDC identity is the pair `(issuer, sub)` in `external_identities`. An
  existing link signs in. Otherwise an invite links it (to the invited
  existing user, or to a new account), `SELF_SIGNUP` creates an account, and
  without either the login is refused. New logins come from
  `preferred_username`, the email's local part or the name, made to fit the
  login pattern, with `-2`, `-3`, … when taken. Email addresses are only
  taken over when `email_verified` is true.
- A passkey-only account needs no OIDC: an invite or `SELF_SIGNUP` lets a new
  user register a passkey, which creates the account in the same step. A
  signed-in user adds more passkeys (CSRF token required). The user handle is
  random and the same for all passkeys of a user.
- The device flow issues a personal access token with `repo:write` (Git and
  LFS read and write, no admin API), 90 days, named after the client.
- A break-glass token only works for an existing, enabled instance admin,
  once (`jti`), and gives a one-hour session.

Test support for other packages: `test/support/mock-oidc.ts` (an OIDC
provider as a fetch handler, `RS256`/`ES256`/`EdDSA`, checks PKCE and client
authentication) and `test/support/soft-authenticator.ts` (an ES256 passkey
authenticator that builds attestation objects and assertions byte by byte).
The unit tests verify WebAuthn against the registration and assertion vectors
of py_webauthn (ES256, RS256, EdDSA) and JWS against RFC 7515 A.2/A.3 and
RFC 8037 A.4, and PKCE against RFC 7636 appendix B.

## Git authorization

```ts
import { createAccountsStore, createGitAuthorizer, createInstanceVerifier, createJwksCache } from '@git-forge/accounts'

const store = createAccountsStore(db)
const authorize = createGitAuthorizer({
  directory: store,
  verifyInstance: createInstanceVerifier({ audience: 'https://a.example', trust: store.lookupTrustedIssuer, jwks: createJwksCache() }),
})
await handleGitRequest(request, { storage, authorize })
```

Credentials are read from `Authorization: Basic` (password = token, username
ignored, as with GitHub) or `Authorization: Bearer` (for
`git -c http.extraHeader=...`). A value shaped like a JWT goes to the
instance verifier, anything else is looked up as a token. Invalid credentials
always yield `401`. The core passes the request surface (`'git'` or `'lfs'`)
to the hook, and `createGitAuthorizer` hands it to
`checkRepositoryAccess(directory, principal, repo, role, surface)`: an instance
token only counts for Git routes with the scope `git:read` and for LFS routes
with `lfs:read`. Without the scope the instance is treated like a caller
without grants (public repositories stay readable, private ones answer `404`).

## Instance admins and bootstrap

`store.bootstrapInstanceAdmin({ login, email? })` creates the first user and
makes it an instance admin in one atomic batch, but only while
`instance_admins` is empty; it returns `null` afterwards, so concurrent or
repeated bootstrap calls cannot create a second admin. Further admins are
managed with `store.setInstanceAdmin(userId, admin)`; `store.isInstanceAdmin`
ignores disabled accounts. `store.listRepositories()` lists the repositories
of enabled owners, e.g. for scheduled mirror sync.

## Branch protection

Modelled on GitHub's classic branch protection rules. A repository has any
number of rules, each with a branch name pattern; exactly one rule applies to
a branch.

### Patterns and rule selection

Patterns are `fnmatch` with `FNM_PATHNAME`, as on GitHub: `*` and `?` never
match `/`, `**/` matches any number of directories (`release/**/*`),
`[a-z]`, `[!x]`/`[^x]` and `\` escapes work. A rule whose pattern names the
branch exactly (no `*`, `?`, `[`, `]`, `\`) wins; otherwise the oldest
matching wildcard rule applies. Rules never combine. Patterns match the branch
name without `refs/heads/`; tags and all other refs are not protected.

### Settings

| Setting | Default | Effect on a direct push |
|---|---|---|
| `allowForcePushes` | `false` | non-fast-forward updates are rejected |
| `allowDeletions` | `false` | deleting the branch is rejected |
| `enforceAdmins` | `false` | when `false`, actors with `admin` access bypass every rule |
| `restrictions` | `null` | when set, only the listed users, teams (of the repository's organization), apps, or actors with at least one of the listed roles may push, create or delete matching branches |
| `requiredPullRequestReviews` | `null` | when set, direct pushes are rejected; the PR feature checks `requiredApprovingReviewCount` (0–6), `dismissStaleReviews`, `requireCodeOwnerReviews`, `requireLastPushApproval` |
| `requiredStatusChecks` | `null` | when set, the new commit needs every listed context in a passing state (`success`, `neutral`, `skipped`); `strict` additionally requires the PR branch to be up to date |

Creating a branch that matches a rule is a fast-forward and allowed unless
push restrictions, required reviews or required status checks forbid it.

### Checking an update

`evaluateBranchUpdate(rule, actor, update, evidence)` is a pure function and
the only place the rules are interpreted. It returns every unmet requirement
as a list of strings (empty = allowed):

```ts
evaluateBranchUpdate(rule, actor, { ref, oldId, newId, fastForward }, { via: 'push' })
evaluateBranchUpdate(rule, actor, update, {
  via: 'pull-request',
  approvals, changesRequested, codeOwnerApproved, lastPushApproved, upToDate,
  statuses: { ci: 'success' },
})
```

`actor` (`ProtectionActor`) carries the principal's kind and ID, its resolved
repository `access` and its team IDs, all derived from the verified token by
`protectionActor(store, principal, repository, access)`. Pull request merges
(once they exist) call the same function with `via: 'pull-request'`;
push restrictions and admin bypass apply to merges exactly as to pushes.
`selectProtectionRule(rules, branch)` picks the applicable rule.

### Enforcement in receive-pack

```ts
const access = createGitAccess({ directory: store, verifyInstance })
await handleGitRequest(request, { storage, authorize: access.authorize, pushPolicy: access.pushPolicy })
```

`createGitAccess` authenticates each request once (shared between
`authorize` and `pushPolicy`), loads the repository's rules and the actor
before the refs are updated, and returns a synchronous `RefPolicy` for
`receivePack`. A violation rejects only that ref with
`ng <ref> protected branch: <reason>`, which `git push` prints as
`! [remote rejected] main -> main (protected branch: force push is not allowed)`;
with `--atomic` the whole push fails. Rejected force pushes archive nothing.
`refs/upstream/*` and `refs/archive/*` are refused before the policy runs
(`invalid ref name`) and stay governed by the mirror rules; mirror sync
writes `refs/upstream/*` directly and is not subject to branch protection.

`delegatedBranches(principal, repository)` (optional) grants access a role
does not: when it returns refs for a principal without the required access,
`authorize` allows reads and writes of that repository and `pushPolicy`
rejects every ref outside the returned list (then applies the repository's
branch protection). The Worker uses it for pull requests from forks that
allow edits from maintainers (`maintainerPushBranches` of the collaboration
package).

Forks: `createFork`, `forkInfo`, `listForks`, `forkNetwork` and
`findRepositoryById` keep the fork tree in `repository_forks` (parent and
root per fork, migration `0010_forks`); `organizationRole` answers whether a
user owns an organization.

### API

`handleBranchProtectionRequest(request, { store, verifyInstance?, prefix = '/api' })`
serves GitHub's REST shape under the prefix. All routes need `admin` access
(`401` anonymous, `404` not visible, `403` otherwise).

| Method and path | Meaning |
|---|---|
| `GET /api/repos/{owner}/{repo}/branches/{pattern}/protection` | the rule with exactly this pattern, `404 Branch not protected` otherwise |
| `PUT /api/repos/{owner}/{repo}/branches/{pattern}/protection` | create or replace the rule |
| `DELETE /api/repos/{owner}/{repo}/branches/{pattern}/protection` | remove the rule (`204`) |
| `GET /api/repos/{owner}/{repo}/branch-protection` | all rules in creation order (not in GitHub's REST API) |

`{pattern}` may contain `/` and wildcards, URL-encoded or not
(`release%2F*`). The `PUT` body is GitHub's:

```json
{
  "required_status_checks": { "strict": true, "contexts": ["ci"] },
  "enforce_admins": true,
  "required_pull_request_reviews": { "required_approving_review_count": 2, "dismiss_stale_reviews": true },
  "restrictions": { "users": ["rita"], "teams": ["releasers"], "apps": [], "roles": ["maintain"] },
  "allow_force_pushes": false,
  "allow_deletions": false
}
```

Missing or `null` sections are disabled; `restrictions.roles` is an
extension. Users, teams and apps are given by login/slug and stored by ID.
Responses follow GitHub (`enforce_admins.enabled`, `allow_force_pushes.enabled`,
disabled sections omitted) plus `pattern`. Invalid bodies yield `422`. Every
change is written with an audit entry (`branch_protection.create`,
`.update`, `.delete`).

## Instance federation

Each instance has an Ed25519 signing key and publishes, under its issuer URL,
`/.well-known/openid-configuration` and `/.well-known/jwks.json`. To read a
private repository on instance A, instance B mints a JWT; A verifies it
against B's published keys and its own trust table. The trust anchor is B's
domain via TLS, optionally hardened by pinning B's key thumbprint.

### Minting (used by the mirror/sync side)

```ts
import { generateSigningKey, importSigningKey, mintInstanceToken } from '@git-forge/accounts'

const { privateJwk } = await generateSigningKey()
const key = await importSigningKey(JSON.parse(env.INSTANCE_KEY))

const token = await mintInstanceToken({
  key,
  issuer: 'https://b.example',
  audience: 'https://a.example',
  repositories: ['village/archive'],
  scopes: ['git:read', 'lfs:read'],
  ttlSeconds: 300,
})
```

`generateSigningKey()` is a one-time setup step; store `privateJwk` as a
secret (`INSTANCE_KEY`). Use the token as a Bearer header or Basic password:

```sh
git -c "http.extraHeader=Authorization: Bearer $TOKEN" fetch https://a.example/village/archive.git
```

`mintInstanceToken(options): Promise<string>`

| Option | Meaning |
|---|---|
| `key` | `SigningKey` from `generateSigningKey()` or `importSigningKey(privateJwk)` |
| `issuer` | this instance's base URL; must equal what it serves the well-known documents under |
| `audience` | base URL of the instance being read |
| `repositories` | `owner/name` list the token is good for (lowercased) |
| `scopes` | subset of `git:read`, `lfs:read` (default both) |
| `ttlSeconds` | 1–300, default 300 |
| `now` | milliseconds, for tests |

Claims: `iss`, `aud`, `sub: "instance"`, `iat`, `nbf`, `exp`, `jti`,
`repositories`, `scope` (space separated). Header: `alg: EdDSA`, `typ: JWT`,
`kid` = RFC 7638 JWK thumbprint of the public key.

The private key is configuration (a secret holding the private JWK), not
database content. Rotation: generate a new key, publish both public keys in
`keys` of `handleWellKnownRequest`, switch minting to the new key, drop the
old public key after its tokens expired (5 minutes plus cache time).

### Serving discovery

```ts
const response = handleWellKnownRequest(request, { issuer: 'https://b.example', keys: [key.publicJwk] })
```

### Verifying

`verifyInstanceToken(token, { audience, trust, jwks, now?, clockSkewSeconds? })`
returns `{ ok: true, claims, principal, keyThumbprint }` or
`{ ok: false, reason }`. Checks, in order: JWT shape, `alg` = EdDSA, `kid`;
`iss` must be a trusted, enabled issuer (looked up before any network
access, so untrusted tokens cannot make the server fetch arbitrary URLs);
`aud`; `sub`; `exp`/`nbf`/`iat` with 30 s skew; lifetime at most 300 s; key
by `kid`, refetching the JWKS once on an unknown `kid`; pinned thumbprint;
signature.

`createJwksCache({ fetch?, cacheSeconds = 300, minRefreshSeconds = 30, allowInsecureHttp = false })`
fetches the discovery document, requires `issuer` to match and `jwks_uri` to
be on the issuer's origin, refuses plain HTTP and redirects (requests use
`redirect: 'manual'` and treat any 3xx as an error, because Workers do not
implement `redirect: 'error'`), limits documents
to 64 KiB, and refetches at most every 30 s on unknown key ids.

Trust is managed with `store.trustInstance({ issuer, pinnedThumbprint? })`,
`store.grantInstanceRepository(issuer, repositoryId)`,
`store.revokeInstanceRepository`, and `store.distrustInstance`.

`verifyFederationToken(token, options, subject, validate)` holds the checks
above for any federation JWT; instance tokens and mirror notifications only
differ in `sub` and in their claim validation.

## Mirror notifications

A mirror learns about new upstream data through a signed notification
instead of polling. Design and flow: `docs/design.md` §4.

- **Subscribing:** the mirror sends `POST /api/federation/subscriptions`
  with an instance token (`Authorization: Bearer`, audience = upstream) and
  `{ "repository": "owner/name", "callback": "<url>" }`.
  `authorizeSubscription(principal, repository, callback)` requires the
  scope `git:read`, the repository in the token's `repositories` claim and a
  callback below the subscriber's own issuer URL (`validateCallback`), so an
  upstream can never be made to POST to third-party hosts. Only trusted
  issuers can present a valid token at all. `DELETE` on the same path with
  the same body unsubscribes. Stored with `store.subscribeMirror`,
  `store.unsubscribeMirror`, read with `store.mirrorSubscriptions(repository)`,
  which skips distrusted issuers.
- **Notifying:** `mintMirrorNotification({ key, issuer, audience, repository, refs })`
  signs an EdDSA JWT with `sub: "mirror-notification"`, at most 300 s
  lifetime, the repository and its ref state (`refs/heads/*`, `refs/tags/*`,
  `refs/upstream/*`; omitted above `MAX_NOTIFIED_REFS` = 1000 refs). It
  carries no content. It is POSTed as `application/jwt` to the callback.
- **Verifying:** `verifyMirrorNotification(token, { audience, trust, jwks })`
  runs the same checks as instance tokens (trusted issuer before any network
  access, audience, lifetime, key, pinned thumbprint, signature). Because
  the subjects differ, a notification is never accepted as an access token
  and an access token never as a notification.
- **Matching:** `isMirrorOf(mirrorUrl, issuer, repository)` decides whether a
  local mirror follows the notifying repository;
  `parseUpstreamUrl(url, issuer?)` splits a mirror URL into issuer and
  `owner/name` (an issuer with a path, e.g. `https://host/forge`, works).
