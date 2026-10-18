# git-forge instance

A deployment of [git-forge](https://github.com/levino/git-forge), a serverless
Git forge, on Cloudflare Workers with R2 and D1. This repository contains no
forge code: it pins a release of git-forge and configures one instance.

| File | Purpose |
|---|---|
| `git-forge.json` | The pinned release: `version` and the `sha256` of the release's `SHA256SUMS` asset. |
| `wrangler.jsonc` | The instance: Worker name, R2 bucket, D1 database, cron, vars, domain. |
| `build.sh` | Downloads the pinned release, verifies every file against the pin and unpacks it into `dist/`. Needs only `sh`, `curl`, `sha256sum` and `tar`. |
| `deploy.sh` | Applies the release's D1 migrations and deploys, in the right order also on the very first deploy. |
| `renovate.json` | Lets Renovate propose updates when git-forge publishes a release. |
| `.github/workflows/pin-checksum.yml` | Fills in the `sha256` on Renovate's update PRs and checks that the pin builds. |

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

Until accounts are wired up, one secret protects all writes. `wrangler.jsonc`
declares it as required (`secrets.required`); its value never goes into the
repository. Set it once:

```sh
openssl rand -base64 32 | npx wrangler@4 secret put ADMIN_TOKEN
```

or in the dashboard under the Worker's **Settings → Variables and Secrets**.
Then create a repository and push to it:

```sh
curl -X POST https://<your-instance>/api/admin/repos \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"owner":"acme","name":"site"}'
git push https://git:$ADMIN_TOKEN@<your-instance>/acme/site.git main
git clone https://<your-instance>/acme/site.git
```

`PUBLIC_READ` in `wrangler.jsonc` decides whether anyone may clone (`"true"`)
or only holders of the token (`"false"`).

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
