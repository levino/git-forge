# git-forge instance

A deployment of [git-forge](https://github.com/levino/git-forge), a serverless
Git forge, on Cloudflare Workers with R2, D1 and Queues. This directory
contains no forge code: its `wrangler.toml` pins a release of git-forge and
configures one instance.

| File | Purpose |
|---|---|
| `wrangler.toml` | The whole instance: Worker name, the pinned release in the `[build]` command, R2 bucket, D1 database, queues, cron, vars, domain. |
| `.dev.vars.example` | The secret the Deploy button asks for (`BOOTSTRAP_TOKEN`), and the template for `.dev.vars` in local development. |
| `runner/Dockerfile` | Image for CI jobs, used only when [CI is enabled](#ci-opt-in): the official `ghcr.io/actions/actions-runner` image plus Git and Node.js. |

There is no `package.json`, no lockfile and no script. Nothing from npm ends
up in the Worker: it runs the bundled `git-forge-worker.mjs` from the release,
byte for byte, verified against the checksum pinned in `wrangler.toml`.

## How it deploys

`wrangler deploy` (the default deploy command of Workers Builds) first runs
the `[build]` command. It downloads the release's `SHA256SUMS` and
`git-forge-worker.mjs` into `dist/`, checks `SHA256SUMS` against the pinned
`S` and the bundle against `SHA256SUMS`, and fails the deploy on any mismatch.
It needs only `sh`, `curl` and `sha256sum`.

```toml
[build]
command = "V=0.8.0 S=baa0866b… && U=… && mkdir -p dist && cd dist && curl … && sha256sum -c …"
```

`V` is the release version, `S` the SHA-256 of the release's `SHA256SUMS`.

Every Cloudflare resource is declared in `wrangler.toml` by name only, without
ids: the first deploy creates the D1 database, the R2 bucket and the two
queues (automatic resource provisioning), later deploys find them by name.
The Worker applies pending database migrations itself when it starts, so
there is no migration step in the deploy.

A Workers **Paid** plan is required (indexing a push needs more than the 10 ms
CPU of the Free plan, and `limits.cpu_ms` cannot be set on Free).

## Create an instance

### With the Deploy button

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/levino/git-forge/tree/main/templates/instance)

The button copies this directory into a new repository in your GitHub or
GitLab account (this directory becomes its root), lets you rename the Worker,
the database, the bucket and the queues, asks for `BOOTSTRAP_TOKEN`, connects
the repository to Workers Builds and deploys it. Every later push to the
default branch deploys again. Leave the build command of Workers Builds empty
and the deploy command at `npx wrangler deploy`; the `[build]` command in
`wrangler.toml` does the build. Then set [the first admin](#first-admin).

### By hand

1. Copy this directory into a new repository.
2. Adjust `wrangler.toml`: `name`, `bucket_name`, `database_name`, the queue
   names (the jobs queue must end in `-jobs`) and, for your own domain,
   `routes` (see [Domain](#domain)).
3. In the Cloudflare dashboard, open **Workers & Pages → Create → Import a
   repository**, pick your repository, leave the build command empty and keep
   the deploy command `npx wrangler deploy`. Or run `npx wrangler@4 deploy`
   locally.

### Domain

Without `routes` the instance is reachable at
`https://<name>.<account>.workers.dev`. For your own domain declare it as a
custom domain at the top of `wrangler.toml`; Wrangler creates the DNS record
and the certificate on deploy (the zone must be on the same Cloudflare
account):

```toml
routes = [{ pattern = "git.example.com", custom_domain = true }]
```

and set the var `PUBLIC_URL` to `https://git.example.com`.

## First admin

**With OIDC** (see [Login](#login)): open the instance once (any page, so the
Worker creates its tables), then store a one-time claim for your verified
email address or OIDC subject in D1, from the repository directory:

```sh
npx wrangler@4 d1 execute DB --remote --command "INSERT INTO instance_admin_claims (identity, created_at) VALUES ('you@example.org', unixepoch() * 1000)"
```

The first OIDC sign-in with that identity creates the account (even without
self-signup), makes it an instance admin and deletes the claim. Nothing stays
in the config.

**Without OIDC:** the secret `BOOTSTRAP_TOKEN` allows exactly one call that
creates the first instance admin; without it `/api/bootstrap` answers `503`.
The Deploy button asks for it. Otherwise set it after the first deploy (a
secret can only be set on an existing Worker):

```sh
openssl rand -base64 32 | npx wrangler@4 secret put BOOTSTRAP_TOKEN
```

or in the dashboard under the Worker's **Settings → Variables and Secrets**.
Then create the admin, a repository, and push:

```sh
curl -X POST https://<your-instance>/api/bootstrap \
  -H "Authorization: Bearer $BOOTSTRAP_TOKEN" -H 'Content-Type: application/json' \
  -d '{"login":"alice"}'
# {"login":"alice","token":"gfp_…"}  keep this token, it is shown once
curl -X POST https://<your-instance>/api/repos \
  -H "Authorization: Bearer $TOKEN" -d '{"owner":"alice","name":"site"}'
git push https://git:$TOKEN@<your-instance>/alice/site.git main
```

Repositories are private by default (`"visibility": "public"` on creation or
`PATCH /api/repos/{owner}/{name}` changes that). Further users, tokens,
collaborators, instance federation and mirrors are described in the
[forge-worker README](https://github.com/levino/git-forge/tree/main/apps/forge-worker#api).
To mirror private repositories of other instances, also set the secret
`INSTANCE_KEY` and the var `PUBLIC_URL` (see there).

## Vars

All settings are optional `[vars]` in `wrangler.toml`; without them the
defaults apply. For example:

```toml
[vars]
PUBLIC_URL = "https://git.example.com"
OIDC_ISSUER = "https://id.example.com"
OIDC_CLIENT_ID = "1234567890"
OIDC_NAME = "Example ID"
```

| Var | Default | Value |
|---|---|---|
| `PUBLIC_URL` | | `https://<your-instance>`: origin for passkeys, OIDC redirect URI, break-glass tokens and links in payloads and emails. Set it when the instance has a custom domain. |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID` | none: no OIDC | Issuer URL and client id of the OIDC application. |
| `OIDC_NAME` | | Button label, e.g. `Dorf-ID`. |
| `OIDC_SCOPES` | `openid profile email` | Requested scopes. |
| `SELF_SIGNUP` | `false` | `true`: anyone who can sign in at the provider (or register a passkey) gets an account. `false`: only invited people. |
| `BREAK_GLASS_PUBLIC_KEY` | | Public half of the offline break-glass key, see the [forge-worker README](https://github.com/levino/git-forge/tree/main/apps/forge-worker#break-glass-key). |
| `UI` | `true` | `false` for a headless instance (for example a backup mirror): Git, LFS and the API only. |
| `MAX_LFS_OBJECT_BYTES`, `MIRROR_INTERVAL_MINUTES`, `MIRROR_DEEP_CHECK_DAYS` | see the forge-worker README | Limits and mirror schedule. |
| `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_S3_ENDPOINT` | none: LFS through the Worker | Presigned LFS uploads straight to R2, see [Large LFS objects](#large-lfs-objects). |
| `EMAIL_PROVIDER` | `none` | `ses` or `console`, see [Email](#notifications-email-and-webhooks). |

## Login

People sign in at `https://<your-instance>/login` with passkeys (built in),
with an OIDC provider, or, as last resort, with the break-glass key. The
command line uses `git forge auth login https://<your-instance>`, after which
plain `git clone` and `git push` work without tokens in URLs. Only the OIDC
client secret is a secret, and only for a confidential client:
`npx wrangler@4 secret put OIDC_CLIENT_SECRET`.

For ZITADEL create a **Web** application in a project with response type
`code`, grant type authorization code, authentication method `PKCE` (or
`Basic` with a client secret) and the redirect URI
`https://<your-instance>/login/oidc/callback`. Then invite people with an
admin token:

```sh
curl -X POST https://<your-instance>/api/admin/invites \
  -H "Authorization: Bearer $TOKEN" -d '{"user":"alice"}'
# {"code":"gfi_…","url":"https://<your-instance>/login/invite/gfi_…", …}
```

Opening the invite URL links the OIDC identity or registers a passkey for
`alice`. `{"login":"bob"}` invites a new account instead.

## Web UI

The instance serves a web UI from the same Worker: `https://<your-instance>/`
lists repositories, `https://<your-instance>/alice/site` shows the files, the
README, commits, diffs, branches, tags and previews of LFS images, video,
audio and PDFs. Public repositories are visible to everyone, private ones only
with access.

## Large LFS objects

Without an R2 key, LFS uploads are proxied and limited by the request body
limit (100 MB on Free/Pro). With a bucket-scoped key, clients upload straight
to R2 via presigned URLs. Create it (`CF_API_TOKEN` needs "Account API
Tokens: Edit"):

```sh
ACCOUNT_ID=<account id>; BUCKET=<bucket_name of BUCKET>
RESPONSE=$(curl -fsS "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/tokens" \
  -H "Authorization: Bearer $CF_API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"git-forge LFS '"$BUCKET"'","policies":[{"effect":"allow",
    "permission_groups":[{"id":"6a018a9f2fc74eb6b293b0c548f38b39"},{"id":"2efd5506f9c8494dacb1fa10a3e7d5b6"}],
    "resources":{"com.cloudflare.edge.r2.bucket.'"$ACCOUNT_ID"'_default_'"$BUCKET"'":"*"}}]}')
echo "$RESPONSE" | jq -r .result.id | npx wrangler@4 secret put R2_ACCESS_KEY_ID
echo "$RESPONSE" | jq -r .result.value | tr -d '\n' | sha256sum | cut -d' ' -f1 | npx wrangler@4 secret put R2_SECRET_ACCESS_KEY
```

Dashboard alternative: **R2 → Manage API tokens → Create Account API token**,
"Object Read & Write" on this bucket only, then put the shown access key id
and secret with the same two `wrangler secret put` commands. Then set the
vars `R2_ACCOUNT_ID`, `R2_BUCKET` and raise `MAX_LFS_OBJECT_BYTES` (up to
about 5 GiB). For a jurisdiction bucket replace `default` by it and set
`R2_S3_ENDPOINT`.

## Imports

`POST /api/repos/<owner>/<name>/import` creates or updates a repository by
pulling it from another Git server, without the request body limit of a push.
Its steps run on the imports queue.

## Notifications, email and webhooks

Notifications (`/api/v3/notifications`), webhooks
(`/api/v3/repos/<owner>/<name>/hooks`) and releases
(`/api/v3/repos/<owner>/<name>/releases`) work without further setup; their
jobs run on the jobs queue (its name must end in `-jobs`).

Emails are off. To send them through Amazon SES, verify the sender address or
domain in SES, create an IAM user with `ses:SendEmail`, and set

```toml
[vars]
EMAIL_PROVIDER = "ses"
EMAIL_FROM = "Forge <forge@example.org>"
SES_REGION = "eu-central-1"
```

plus the two secrets:

```sh
npx wrangler@4 secret put SES_ACCESS_KEY_ID
npx wrangler@4 secret put SES_SECRET_ACCESS_KEY
```

`EMAIL_PROVIDER = "console"` (with `EMAIL_FROM`) writes each email to the Worker logs instead,
which is handy for a first test. Users choose `instant`, `hourly`, `daily` or
`off` with `PATCH /api/v3/user/notification-settings`.

## Update

Set `V` and `S` at the start of the `[build]` command to a newer release and
push; Workers Builds deploys it. Each
[release](https://github.com/levino/git-forge/releases) states both values in
its notes, together with the complete `[build]` command line. To compute `S`
yourself:

```sh
curl -fsSL https://github.com/levino/git-forge/releases/download/v0.9.0/SHA256SUMS | sha256sum
```

To roll back, revert the commit. Migrations are only ever added, never rolled
back, and stay compatible with the previous release.

Releases are built for the `compatibility_date` in this `wrangler.toml`. When
a release note asks for a newer date, change it in the same commit.

## Local development

```sh
cp .dev.vars.example .dev.vars
npx wrangler@4 dev
```

`wrangler dev` runs the `[build]` command too and serves the release bundle in
workerd with a local R2 bucket, D1 database and queues under `.wrangler/`.

The build command downloads from
`https://github.com/levino/git-forge/releases/download/v$V/`. Set
`GIT_FORGE_RELEASE_URL` to another base URL (also `file://…`) to use a mirror
or a locally built release. In a checkout of `levino/git-forge`,

```sh
pnpm install
sh release/build-release.sh /tmp/git-forge-release
```

prints the `S` to pin (any `V` works); then
`GIT_FORGE_RELEASE_URL=file:///tmp/git-forge-release npx wrangler@4 dev`.

## CI (opt-in)

CI (GitHub Actions compatible, running the official `actions/runner`) is off
by default, because its runner container makes `wrangler deploy` build a
Docker image, and building container images in Workers Builds is not
verified yet. To enable it where Docker is available, add to
`wrangler.toml`:

```toml
[vars]
ACTIONS = "true"

[triggers]
crons = ["17 3 * * *", "*/5 * * * *"]

[[containers]]
class_name = "RunnerContainer"
image = "./runner/Dockerfile"
instance_type = "standard-1"
max_instances = 4

[[durable_objects.bindings]]
name = "RUNNER"
class_name = "RunnerContainer"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["RunnerContainer"]

[dev]
enable_containers = false
```

(merge `ACTIONS` into an existing `[vars]` table and replace the existing
`[triggers]`). Every CI job then starts one container with the runner and a
JIT config. With `ACTIONS` set but without the container entries, workflows
are queued and picked up by runners you register yourself
(`/api/v3/repos/…/actions/runners/generate-jitconfig`). The second cron runs
scheduled workflows and cleans up timed-out jobs and dead runners.
Instance-wide workflow secrets go into the `ACTIONS_SECRETS` secret, a JSON
object such as `{"CLOUDFLARE_API_TOKEN": "…"}`. For repository and
environment secrets set the `ACTIONS_SECRETS_KEY` secret to 32 random bytes
(`openssl rand -base64 32`); they are stored encrypted with it in D1. `uses:`
actions are served from repositories on the instance, for example a mirror of
`github.com/actions/checkout` named `actions/checkout`
(`ACTIONS_REPOSITORIES` maps other names, `ACTIONS_GITHUB_FALLBACK=true`
downloads unmirrored actions from GitHub).
