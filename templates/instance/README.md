# git-forge instance

A deployment of [git-forge](https://github.com/levino/git-forge), a serverless
Git forge, on Cloudflare Workers with R2 and D1. This repository contains no
forge code: it pins a release of git-forge and configures one instance.

| File | Purpose |
|---|---|
| `git-forge.json` | The pinned release: `version` and the `sha256` of the release's `SHA256SUMS` asset. |
| `wrangler.jsonc` | The instance: Worker name, R2 bucket, D1 database, cron, vars, domain. |
| `runner/Dockerfile` | Image for CI jobs, used only when [CI is enabled](#ci-opt-in): the official `ghcr.io/actions/actions-runner` image plus Git and Node.js. |
| `build.sh` | Downloads the pinned release, verifies every file against the pin and unpacks it into `dist/`. Needs only `sh`, `curl`, `sha256sum` and `tar`. |
| `deploy.sh` | Applies the release's D1 migrations and deploys, in the right order also on the very first deploy. |
| `renovate.json` | Lets Renovate propose updates when git-forge publishes a release. |
| `.github/workflows/pin-checksum.yml` | Fills in the `sha256` on Renovate's update PRs and checks that the pin builds (not for the all-zero placeholder pin, which has no release). |

There is no `package.json` and no lockfile. Nothing from npm ends up in the
Worker: it runs the bundled `git-forge-worker.mjs` from the release, byte for
byte, verified against the checksum committed here.

## Create an instance

A Workers **Paid** plan is required (indexing a push needs more than the 10 ms
CPU of the Free plan, and `limits.cpu_ms` cannot be set on Free).

Every Cloudflare resource of the instance is declared in `wrangler.jsonc` and
created by Wrangler, never by hand: the D1 database and the R2 bucket have a
name but no id, so the first `wrangler deploy` provisions them (automatic
resource provisioning) and later deploys find them by name. Cron, vars, routes
and the required secret are declared there too.

### With the Deploy button

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/levino/git-forge-instance)

The button copies this repository into your GitHub or GitLab account, connects
it to Workers Builds and deploys it. Then check the [build
settings](#build-settings) and set [the first admin](#first-admin).

### From the template

1. Create your own repository from this one ("Use this template" on GitHub, or
   copy the files).
2. Adjust `wrangler.jsonc`: `name`, `bucket_name`, `database_name`, `vars`
   and, for your own domain, `routes` (see [Domain](#domain)).
3. In the Cloudflare dashboard, open **Workers & Pages → Create → Import a
   repository**, pick your repository and use the [build
   settings](#build-settings) below. Every push to the default branch now
   deploys the instance; the first one creates the database and the bucket.

### Build settings

| Setting | Value |
|---|---|
| Build command | `sh build.sh` |
| Deploy command | `sh deploy.sh` |
| Root directory | `/` |

`build.sh` fetches and verifies the release. `deploy.sh` applies new D1
migrations from the release and then uploads the Worker, so new code never
runs against an old schema. On the very first deploy the database does not
exist yet; `deploy.sh` then deploys first (which provisions it) and applies
the migrations right after. `wrangler deploy` also runs `build.sh` through
`build.command` in `wrangler.jsonc`; it finds `dist/` already verified and does
nothing. `deploy.sh` runs `npx wrangler@4`; set `WRANGLER` to use another
Wrangler command.

### Domain

Without `routes` the instance is reachable at
`https://<name>.<account>.workers.dev`. For your own domain declare it as a
custom domain in `wrangler.jsonc`; Wrangler creates the DNS record and the
certificate on deploy (the zone must be on the same Cloudflare account):

```jsonc
"routes": [{ "pattern": "git.example.com", "custom_domain": true }]
```

## First admin

A fresh instance has no users. The secret `BOOTSTRAP_TOKEN` allows exactly one
call that creates the first instance admin. `wrangler.jsonc` declares it as
required (`secrets.required`); its value never goes into the repository. Set
it once (the Deploy button asks for it):

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

## Login

People sign in at `https://<your-instance>/login` with passkeys (built in),
with an OIDC provider, or, as last resort, with the break-glass key. The
command line uses `git forge auth login https://<your-instance>`, after which
plain `git clone` and `git push` work without tokens in URLs. All settings are
vars in `wrangler.jsonc`; only the OIDC client secret is a secret.

| Var / secret | Value |
|---|---|
| `PUBLIC_URL` | `https://<your-instance>`: origin for passkeys, OIDC redirect URI and break-glass tokens. Set it when the instance has a custom domain. |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID` | Issuer URL and client id of the OIDC application, e.g. `https://dorf-id.example` (ZITADEL) and the app's client id. Empty: no OIDC. |
| `OIDC_CLIENT_SECRET` (secret) | Only for a confidential client: `npx wrangler@4 secret put OIDC_CLIENT_SECRET`. A ZITADEL app with authentication method "PKCE" needs none. |
| `OIDC_NAME` | Button label, e.g. `Dorf-ID`. |
| `SELF_SIGNUP` | `true`: anyone who can sign in at the provider (or register a passkey) gets an account. `false` (default): only invited people. |
| `BREAK_GLASS_PUBLIC_KEY` | Public half of the offline break-glass key, see the [forge-worker README](https://github.com/levino/git-forge/tree/main/apps/forge-worker#break-glass-key). |

For ZITADEL create a **Web** application in a project with response type
`code`, grant type authorization code, authentication method `PKCE` (or
`Basic` with a client secret) and the redirect URI
`https://<your-instance>/login/oidc/callback`. Then invite the people you
want, or yourself (the bootstrap admin), with the admin token:

```sh
curl -X POST https://<your-instance>/api/admin/invites \
  -H "Authorization: Bearer $TOKEN" -d '{"user":"alice"}'
# {"code":"gfi_…","url":"https://<your-instance>/login/invite/gfi_…", …}
```

Opening the invite URL links the OIDC identity or registers a passkey for
`alice`. `{"login":"bob"}` invites a new account instead.

## Imports

`POST /api/repos/<owner>/<name>/import` creates or updates a repository by
pulling it from another Git server, without the request body limit of a push.
Its steps run on the Cloudflare Queue `git-forge-imports`, declared in
`wrangler.jsonc` and created by the first `wrangler deploy` like the bucket
and the database.

## Update

An update is a change of `git-forge.json`:

```json
{
  "version": "0.2.0",
  "sha256": "…"
}
```

Each [release](https://github.com/levino/git-forge/releases) states both
values in its notes. `sha256` is the SHA-256 of the release's `SHA256SUMS`
file, which lists the checksums of the bundle and the migrations, so one pin
covers all assets. To compute it yourself:

```sh
curl -fsSL https://github.com/levino/git-forge/releases/download/v0.2.0/SHA256SUMS | sha256sum
```

Commit and push; Workers Builds deploys the new version. To roll back, revert
the commit. Migrations are only ever added, never rolled back, and stay
compatible with the previous release.

Releases are built for the `compatibility_date` in this repository's
`wrangler.jsonc`. When a release note asks for a newer date, change it in the
same commit.

### With Renovate

Install the [Renovate GitHub app](https://github.com/apps/renovate) on your
repository. `renovate.json` contains a regex manager that reads `version` from
`git-forge.json` and looks up the GitHub releases of `levino/git-forge`.
Renovate can only change the version: its `github-releases` datasource knows
the commit of a tag, not the checksum of a file in the release. The
`Pin checksum` workflow therefore runs on Renovate's pull requests, downloads
the new `SHA256SUMS`, writes its SHA-256 into `git-forge.json`, pushes that
to the pull request branch with the workflow's `GITHUB_TOKEN` and runs
`build.sh` against it. Review the diff and merge.

## Local development

```sh
cp .dev.vars.example .dev.vars
sh build.sh
npx wrangler@4 d1 migrations apply DB --local
npx wrangler@4 dev
```

`wrangler dev` serves the release bundle in workerd with a local R2 bucket and
D1 database under `.wrangler/`.

`build.sh` downloads from
`https://github.com/levino/git-forge/releases/download/v<version>/`. Set
`GIT_FORGE_RELEASE_URL` to another base URL (also `file://…`) to use a mirror
or a locally built release. In a checkout of `levino/git-forge`,

```sh
pnpm install
sh release/build-release.sh /tmp/git-forge-release
```

prints the `sha256` to put into `git-forge.json` (any `version` works); then
`GIT_FORGE_RELEASE_URL=file:///tmp/git-forge-release sh build.sh`.

## CI (opt-in)

CI (GitHub Actions compatible, running the official `actions/runner`) is off
by default, because its runner container makes `wrangler deploy` build a
Docker image, and building container images in Workers Builds is not
verified yet. To enable it where Docker is available, add to
`wrangler.jsonc`:

```jsonc
  "vars": { "…": "…", "ACTIONS": "true" },
  "containers": [{ "class_name": "RunnerContainer", "image": "./runner/Dockerfile", "instance_type": "standard-1", "max_instances": 4 }],
  "durable_objects": { "bindings": [{ "name": "RUNNER", "class_name": "RunnerContainer" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["RunnerContainer"] }],
  "dev": { "enable_containers": false }
```

Every CI job then starts one container with the runner and a JIT config. With
`ACTIONS` set but without the container entries, workflows are queued and
picked up by runners you register yourself (`/api/v3/repos/…/actions/runners/generate-jitconfig`).
Workflow secrets go into the `ACTIONS_SECRETS` secret, a JSON object such as
`{"CLOUDFLARE_API_TOKEN": "…"}`.

