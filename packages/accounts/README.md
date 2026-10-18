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
- Use `applyMigrations(db, MIGRATIONS)` on every platform (including D1)
  instead of `wrangler d1 migrations apply`, so there is one migration ledger.

## Data model

| Table | Purpose |
|---|---|
| `accounts` | users and organizations share one login namespace (like GitHub); `default_repository_role` is an organization's base permission for members |
| `external_identities` | `(issuer, subject)` → user, ready for OIDC login |
| `organization_members` | role `member` or `owner` |
| `teams`, `team_members` | teams belong to one organization; members must be org members |
| `repositories` | owner is a user or an organization; `visibility` public/private |
| `repository_collaborators` | per-user role: `read`, `triage`, `write`, `maintain`, `admin` |
| `repository_teams` | per-team role on repositories of the team's organization |
| `apps`, `app_repositories` | machine accounts with explicit per-repository roles |
| `tokens` | personal and app tokens: SHA-256 hash only, display prefix, scopes, optional repository restriction, expiry, last use, revocation |
| `trusted_instances`, `instance_repositories` | federation trust: issuer (+ optional pinned key thumbprint) may read specific repositories |
| `audit_log` | append-only; `UPDATE` and `DELETE` are rejected by triggers |
| `instance_admins` | users who administer the instance (create users and tokens, trust other instances, act as admin on every repository) |

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
