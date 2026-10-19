# git-forge instance

A deployment of [git-forge](https://github.com/levino/git-forge), a serverless
Git forge, on Cloudflare Workers with R2, D1 and Queues. This directory
contains no forge code: its `wrangler.toml` pins a release of git-forge and
configures one instance.

| File | Purpose |
|---|---|
| `wrangler.toml` | The whole instance: Worker name, the pinned release in the `[build]` command, R2 bucket, D1 database, queues, cron, vars, domain. |
| `.dev.vars.example` | The secret the Deploy button asks for (`BOOTSTRAP_TOKEN`), and the template for `.dev.vars` in local development. |
| `runner/Dockerfile` | Image for CI jobs, used only when [CI is enabled](#ci-opt-in): `FROM` the runner image of the release (`RUNNER_IMAGE`). Never changes. |
| `.github/workflows/update-git-forge.yml` | Optional: opens a pull request with the new pin when a release comes out (see [Update](#update)). Delete it if you do not want it. |

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
Provisioning picks no region, so create them yourself first (see
[Region](#region)).
The Worker applies pending database migrations itself when it starts, so
there is no migration step in the deploy.

A Workers **Paid** plan is required (indexing a push needs more than the 10 ms
CPU of the Free plan, and `limits.cpu_ms` cannot be set on Free).

## Create an instance

Requires Workers Paid ($5/month) and R2 enabled (card on file); typical
small instances stay at $5/month.

### Region

Resources without a location land wherever Cloudflare puts them (often
another continent), and every request then pays the round trip. A resource
cannot be moved later, only recreated under a new name. With the Deploy
button, set the location of the database and the bucket (e.g. Western
Europe) and the jurisdiction of both queues (e.g. EU) on the deploy page. By
hand, create them before the first deploy with the names from
`wrangler.toml`:

```sh
npx wrangler@4 d1 create git-forge --location weur
npx wrangler@4 r2 bucket create git-forge --location weur
npx wrangler@4 queues create git-forge-imports --jurisdiction eu
npx wrangler@4 queues create git-forge-jobs --jurisdiction eu
```

Locations: `wnam`, `enam`, `weur`, `eeur`, `apac`, `oc`. Queues take no
location, only the jurisdiction `eu`; without it their consumers (mirror
syncs, notifications) may run on another continent. `[placement] mode =
"smart"` moves requests next to the data once it has seen some traffic; after
the first deploy (Cloudflare refuses it on the one that creates the Worker)
add `hint = "weur"` (your location) for immediate effect; Cloudflare refuses
the hint on Workers with a runner container (`ACTIONS`).

### With the Deploy button

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/levino/git-forge/tree/main/templates/instance)

The button copies this directory into a new repository in your GitHub or
GitLab account (this directory becomes its root), lets you rename the Worker,
the database, the bucket and the queues (set their [region](#region); the jobs
queue must end in `-jobs`), asks for `BOOTSTRAP_TOKEN`, connects
the repository to Workers Builds and deploys it. Every later push to the
default branch deploys again. Leave the build command of Workers Builds empty
and the deploy command at `npx wrangler deploy`; the `[build]` command in
`wrangler.toml` does the build. Then set [the first admin](#first-admin).

### By hand

1. Copy this directory into a new repository.
2. Adjust `wrangler.toml`: `name`, `bucket_name`, `database_name`, the queue
   names (the jobs queue must end in `-jobs`) and, for your own domain,
   `routes` (see [Domain](#domain)).
3. Create the resources in your [region](#region).
4. In the Cloudflare dashboard, open **Workers & Pages → Create → Import a
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

### Pages

Repository sites (like GitHub Pages) are off until `PAGES_HOST` is set. Use
a domain of its own, add the wildcard as a route on its zone and, per
repository, custom domains:

```toml
routes = [
  { pattern = "git.example.com", custom_domain = true },
  { pattern = "*.pages.example.net/*", zone_name = "example.net" },
  { pattern = "docs.example.com", custom_domain = true },
]

[vars]
PUBLIC_URL = "https://git.example.com"
PAGES_HOST = "{owner}.pages.example.net"
PAGES_DOMAINS = '{"docs.example.com": "acme/handbook"}'
```

Then enable a site with `POST /api/v3/repos/{owner}/{repo}/pages`
(`{"source": {"branch": "main", "path": "/"}}`). Details:
[forge-worker README, Pages](https://github.com/levino/git-forge/blob/main/apps/forge-worker/README.md#pages).

### Public LFS bucket

To copy the LFS objects of public repositories into a public bucket on push
(keyed by oid), add a second bucket and optionally set `LFS_PUBLISH_PREFIX`
under `[vars]`. A pull-zone CDN in front of the media URLs needs none of this.

```toml
[[r2_buckets]]
binding = "CDN_BUCKET"
bucket_name = "git-forge-cdn"
```

### Backups

Add a second bucket to `wrangler.toml`; the next deploy creates it:

```toml
[[r2_buckets]]
binding = "BACKUP"
bucket_name = "git-forge-backup"
```

Every cron run then copies a database dump and every repository object into
it, verified by SHA-256, in small queued steps. Status, lag, size, errors,
"Run now" and "Verify a sample" are under **Backup** on `/-/admin`
(`GET|POST /api/admin/backup`, `POST /api/admin/backup/verify`).

Lock it so nothing can delete or overwrite a backup, not even this Worker:
in the dashboard, **R2 → git-forge-backup → Settings → Bucket lock rules →
Add rule**, all objects, retention e.g. 90 days. The backup only writes new
keys, so it works with the lock.

Restore into a new instance: see
[design §19](https://github.com/levino/git-forge/blob/main/docs/design.md#19-backups)
(`git-forge-node restore` and `restore-sql` with R2's S3 API, then
`npx wrangler@4 d1 execute DB --remote --file restore.sql`).

## First admin

Open `https://<your-instance>/-/setup` (the home page links to it while the
instance has no admin), enter `BOOTSTRAP_TOKEN` and your login, then open
the invite it shows to register a passkey or link your OIDC account. The same
page then configures OIDC and checks the deployment (database and bucket
location, presigned LFS, queues, Actions).

`BOOTSTRAP_TOKEN` works once. The Deploy button asks for it; otherwise add it
as a secret under the Worker's **Settings → Variables and Secrets** (or
`openssl rand -base64 32 | npx wrangler@4 secret put BOOTSTRAP_TOKEN`).
Without a browser, `POST /api/bootstrap` does the same and returns a token:

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
`PATCH /api/repos/{owner}/{name}` changes that). This admin has only the
token; to sign in on the web, open an invite for it
(`POST /api/admin/invites` with `{"user":"alice"}`, see [Login](#login)) and
link an OIDC identity or register a passkey. Further users, tokens and
collaborators are described in the
[forge-worker README](https://github.com/levino/git-forge/tree/main/apps/forge-worker#api).

## Federation

Mirrors between instances, push notifications and attestations need, on both
instances, the var `PUBLIC_URL` and an instance key:

```sh
node -e "crypto.subtle.generateKey('Ed25519',true,['sign']).then(k=>crypto.subtle.exportKey('jwk',k.privateKey)).then(({kty,crv,x,d})=>console.log(JSON.stringify({kty,crv,x,d})))" | npx wrangler@4 secret put INSTANCE_KEY
```

`https://<your-instance>/.well-known/jwks.json` then shows its public key.
Trust is mutual: an instance admin on each side trusts the other one
(**Admin → Trust an instance**, or `POST /api/admin/instances`
`{"issuer":"https://<other-instance>"}`). For a private repository, its admin
on the upstream grants the mirror read access (**Settings → Federation**, or
`POST /api/repos/{owner}/{name}/instances` `{"issuer":"https://<mirror>"}`).
On the mirror, create a repository and add the mirror (**Settings → Mirrors**,
authentication "instance token", or `POST /api/repos/{owner}/{name}/mirrors`
`{"url":"https://<upstream>/{owner}/{name}.git","auth":"instance"}`). It syncs
Git and LFS, subscribes to push notifications, follows each push within
seconds and attests its state to the upstream (`GET
/api/repos/{owner}/{name}/mirrors/overview` there). Details:
[forge-worker README, Federation](https://github.com/levino/git-forge/tree/main/apps/forge-worker#federation).

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
| `MEMBERSHIP_SOURCE` | `forge` | `idp`: organization and team memberships come only from the identity provider (claim below, SCIM at `/scim/v2` with a token from `POST /api/admin/scim/tokens`). |
| `OIDC_GROUPS_CLAIM` | `groups` | Claim with `org`, `org:owner`, `org/team` values; for ZITADEL `urn:zitadel:iam:org:project:roles`. |
| `PASSKEYS` | `true` | `false`: passkey sign-in and registration are off (OIDC-only instance; break-glass keeps working). |
| `BREAK_GLASS_PUBLIC_KEY` | | Public half of the offline break-glass key, see the [forge-worker README](https://github.com/levino/git-forge/tree/main/apps/forge-worker#break-glass-key). |
| `UI` | `true` | `false` for a headless instance (for example a backup mirror): Git, LFS and the API only. |
| `MAX_LFS_OBJECT_BYTES`, `MIRROR_INTERVAL_MINUTES`, `MIRROR_DEEP_CHECK_DAYS` | see the forge-worker README | Limits and mirror schedule. |
| `R2_S3_ENDPOINT`, `R2_BUCKET_NAME` | none: LFS through the Worker | Presigned uploads straight to R2, see [Large LFS objects](#large-lfs-objects). |
| `EMAIL_PROVIDER`, `EMAIL_FROM` | `cloudflare` with an `EMAIL` binding, else `none`; `Forge <forge@<PUBLIC_URL host>>` | `none`, `ses` or `console`, see [Email](#notifications-email-and-webhooks). |
| `PAGES_HOST`, `PAGES_DOMAINS`, `PAGES_MAX_AGE` | none: no Pages; `60` | Pages hosts, custom domains and cache lifetime, see [Pages](#pages). |
| `LFS_PUBLISH_PREFIX` | | Key prefix in `CDN_BUCKET`, see [Public LFS bucket](#public-lfs-bucket). |

## Login

People sign in at `https://<your-instance>/login` with passkeys (built in),
with an OIDC provider, or, as last resort, with the break-glass key. The
command line uses `git forge auth login https://<your-instance>`, after which
plain `git clone` and `git push` work without tokens in URLs. Only the OIDC
client secret is a secret, and only for a confidential client:
`npx wrangler@4 secret put OIDC_CLIENT_SECRET`. Instead of vars, OIDC can be
set on `/-/setup`; the client secret is then stored encrypted in D1 with
`ACTIONS_SECRETS_KEY`, or without it a key derived from `BOOTSTRAP_TOKEN`, so
changing that secret means entering it again. Vars win when set.

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
vars `R2_S3_ENDPOINT` (`https://<account id>.r2.cloudflarestorage.com`, or
the jurisdiction endpoint), `R2_BUCKET_NAME` and raise `MAX_LFS_OBJECT_BYTES`
(up to about 5 GiB).

Uploads from the browser (upload form) go to the same presigned URLs and
need CORS on the bucket for your forge origin:

```sh
echo '{"rules":[{"allowed":{"origins":["https://<your domain>"],"methods":["PUT"],"headers":["*"]},"maxAgeSeconds":3600}]}' > cors.json
npx wrangler@4 r2 bucket cors set <bucket_name of BUCKET> --file cors.json
```

## Imports

`POST /api/repos/<owner>/<name>/import` creates or updates a repository by
pulling it from another Git server, without the request body limit of a push.
Its steps run on the imports queue.

## Notifications, email and webhooks

Notifications (`/api/v3/notifications`), webhooks
(`/api/v3/repos/<owner>/<name>/hooks`) and releases
(`/api/v3/repos/<owner>/<name>/releases`) work without further setup; their
jobs run on the jobs queue (its name must end in `-jobs`).

Emails (notification digests, mentions, review requests, invites) go
through Cloudflare Email Service (`[[send_email]]` binding `EMAIL`). Until the
sender domain is onboarded, deploys work and sends are rejected and logged.
Onboard it (the domain must use Cloudflare DNS) once:

```sh
npx wrangler@4 email sending enable git.example.com
```

Mail goes out from `EMAIL_FROM` or `Forge <forge@<PUBLIC_URL host>>`; test
with **Send test email** on `/-/admin`. Onboarding also works in the
dashboard (Compute > Email Service > Email Sending > Onboard Domain) or with
the API: `POST /zones/{zone_id}/email/sending/subdomains`, then the
records from `GET …/subdomains/{id}/dns`. It adds MX, SPF and DKIM on
`cf-bounce.<domain>` and DMARC on `_dmarc.<domain>`.

Sending to arbitrary recipients needs the Workers Paid plan (3,000 emails a
month included, then $0.35 per 1,000; daily limits per account). On the free
plan only addresses verified in Email Routing receive mail; others are
rejected and logged.

To send through Amazon SES instead, verify the sender address or
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

`/-/admin` shows the running version and the latest release. Three ways to
move the pin (`V` and `S` at the start of the `[build]` command):

- **One click:** connect the instance repository on `/-/admin` with a
  fine-grained GitHub token (this repository only, *Contents: Read and
  write*; stored encrypted like the OIDC secret). **Update** commits the new
  pin to `wrangler.toml`; Workers Builds deploys it.
- **GitHub Action:** `.github/workflows/update-git-forge.yml` checks daily
  and opens a pull request with the new pin; merging deploys it. It needs
  *Settings → Actions → General → Allow GitHub Actions to create and approve
  pull requests*; no stored token.
- **By hand:** copy the pin from `/-/admin` or the
  [release notes](https://github.com/levino/git-forge/releases), or compute
  `S` with
  `curl -fsSL https://github.com/levino/git-forge/releases/download/v0.9.0/SHA256SUMS | sha256sum`,
  then commit.

With CI, all three also move `RUNNER_IMAGE` (release notes, or the
release's `runner-image` asset).

Instances that enabled CI with the full image in `runner/` migrate once, in
the commit with the new pin: replace `runner/Dockerfile` with the one of this
template, delete `runner/hook.js` and add the `image_vars` line from the
release notes to every `[[containers]]` entry.

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
by default, because it makes every deploy pull the runner image (a few
minutes; Workers Builds has Docker, so nothing else is needed). Each release
publishes the image as `ghcr.io/levino/git-forge-runner:<V>` (the official
`ghcr.io/actions/actions-runner` image plus Git, Node.js and a container hook
for `container:` and `services:`); `RUNNER_IMAGE` pins it by digest. To enable
CI, add to `wrangler.toml`:

```toml
[vars]
ACTIONS = "true"
ACTIONS_GITHUB_FALLBACK = "true"

[triggers]
crons = ["17 3 * * *", "*/5 * * * *"]

[[containers]]
class_name = "RunnerContainer"
image = "./runner/Dockerfile"
image_vars = { RUNNER_IMAGE = "ghcr.io/levino/git-forge-runner:0.9.0@sha256:0000000000000000000000000000000000000000000000000000000000000000" }
instance_type = "basic"
max_instances = 2

[[durable_objects.bindings]]
name = "RUNNER"
class_name = "RunnerContainer"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["RunnerContainer"]

[dev]
enable_containers = false
```

(merge the vars into an existing `[vars]` table and replace the existing
`[triggers]`) and push. `wrangler deploy` builds `runner/Dockerfile`, pushes
it to your account's Cloudflare registry and creates the container
application. Every CI job then starts one container with the runner and a
JIT config; the container stops when the job is done, and you pay only while
it runs.

| Setting | Meaning |
|---|---|
| `instance_type` | Size of each job's container: `basic` (1/4 vCPU, 1 GiB, 4 GB disk, the cheapest that holds the image), `standard-1` (1/2 vCPU, 4 GiB, 8 GB), `standard-2` (1 vCPU, 6 GiB), `standard-3` (2 vCPU, 8 GiB), `standard-4` (4 vCPU, 12 GiB). |
| `max_instances` | Jobs that run at the same time; further jobs wait. |
| `ACTIONS_RUNNER_LABELS` | Comma-separated labels the container serves, e.g. `self-hosted,linux,ubuntu-latest`; jobs with other `runs-on` labels wait for your own runners or a provider. Default: all labels. |
| `ACTIONS_GITHUB_FALLBACK` | `true`: `uses:` actions without a repository on the instance (for example `actions/checkout`) are downloaded from github.com. Without it, mirror them on the instance, e.g. a mirror of `github.com/actions/checkout` named `actions/checkout` (`ACTIONS_REPOSITORIES` maps other names). |

Jobs with `container:`, `services:` or `docker://` steps start Docker in the
runner container; all containers share its network (no iptables on Cloudflare),
so services answer on their own ports under their names. To give these jobs a
bigger instance, add a second class (the image is built once more):

```toml
[[containers]]
class_name = "DockerRunnerContainer"
image = "./runner/Dockerfile"
image_vars = { RUNNER_IMAGE = "ghcr.io/levino/git-forge-runner:0.9.0@sha256:0000000000000000000000000000000000000000000000000000000000000000" }
instance_type = "standard-2"
max_instances = 2

[[durable_objects.bindings]]
name = "RUNNER_DOCKER"
class_name = "DockerRunnerContainer"

[[migrations]]
tag = "v2"
new_sqlite_classes = ["DockerRunnerContainer"]
```

Jobs whose `runs-on` labels match a runner you registered (`config.sh --url
https://<your domain>/<owner>[/<repo>] --token …`, token from
`POST /api/v3/repos/…/actions/runners/registration-token` or `/api/v3/orgs/…`)
go to it instead of a container. External providers subscribe to the
`workflow_job` webhook of a repository or organization and call
`generate-jitconfig`.

With `ACTIONS` set but without the container entries, workflows are queued
and picked up by runners you register yourself
(`/api/v3/repos/…/actions/runners/generate-jitconfig`). The second cron runs
scheduled workflows and cleans up timed-out jobs and dead runners.
Instance-wide workflow secrets go into the `ACTIONS_SECRETS` secret, a JSON
object such as `{"CLOUDFLARE_API_TOKEN": "…"}`. For repository and
environment secrets set the `ACTIONS_SECRETS_KEY` secret to 32 random bytes
(`openssl rand -base64 32`); they are stored encrypted with it in D1.
`actions/cache` and `actions/upload-artifact`/`download-artifact` store their
data in the bucket. For OIDC ID tokens (`permissions: id-token: write`) set the
`ACTIONS_OIDC_KEY` secret to a P-256 private JWK (`git-forge-node oidc-key`);
the issuer is `https://<your domain>/_services/token`.
