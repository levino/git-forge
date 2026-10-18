# git-forge instance

A deployment of [git-forge](https://github.com/levino/git-forge), a serverless
Git forge, on Cloudflare Workers with R2 and D1. This repository contains no
forge code: it pins a release of git-forge and configures one instance.

| File | Purpose |
|---|---|
| `git-forge.json` | The pinned release: `version` and the `sha256` of the release's `SHA256SUMS` asset. |
| `wrangler.jsonc` | The instance: Worker name, R2 bucket, D1 database, cron, vars, domain. |
| `build.sh` | Downloads the pinned release, verifies every file against the pin and unpacks it into `dist/`. Needs only `sh`, `curl`, `sha256sum` and `tar`. |
| `renovate.json` | Lets Renovate propose updates when git-forge publishes a release. |
| `.github/workflows/pin-checksum.yml` | Fills in the `sha256` on Renovate's update PRs and checks that the pin builds. |

There is no `package.json` and no lockfile. Nothing from npm ends up in the
Worker: it runs the bundled `git-forge-worker.mjs` from the release, byte for
byte, verified against the checksum committed here.

## Create an instance

A Workers **Paid** plan is required (indexing a push needs more than the 10 ms
CPU of the Free plan, and `limits.cpu_ms` cannot be set on Free).

### With the Deploy button

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/levino/git-forge-instance)

The button copies this repository into your GitHub or GitLab account, creates
the R2 bucket and the D1 database, connects the new repository to Workers
Builds and deploys it. Then continue with [the first admin](#first-admin) and
check the [build settings](#build-settings) below.

### By hand

1. Create your own repository from this one ("Use this template" on GitHub, or
   copy the files).
2. Adjust `wrangler.jsonc`: `name`, `bucket_name`, `database_name`, `vars`.
3. Create the resources once:

   ```sh
   npx wrangler@4 login
   npx wrangler@4 r2 bucket create git-forge
   npx wrangler@4 d1 create git-forge
   ```

   Add the printed `database_id` to the `d1_databases` entry in
   `wrangler.jsonc`.
4. In the Cloudflare dashboard, open **Workers & Pages → Create → Import a
   repository**, pick your repository and use the [build
   settings](#build-settings) below. Every push to the default branch now
   deploys the instance.

### Build settings

| Setting | Value |
|---|---|
| Build command | `sh build.sh` |
| Deploy command | `npx wrangler@4 d1 migrations apply DB --remote && npx wrangler@4 deploy` |
| Root directory | `/` |

The build step fetches and verifies the release. The deploy step applies new
D1 migrations from the release first and then uploads the Worker, so new code
never runs against an old schema. `wrangler deploy` runs `build.sh` again
through `build.command` in `wrangler.jsonc`; it finds `dist/` already verified
and does nothing.

### Domain

The instance is reachable at `https://<name>.<account>.workers.dev`. For your
own domain add a route to `wrangler.jsonc`, for example

```jsonc
"routes": [{ "pattern": "git.example.com", "custom_domain": true }]
```

or attach the domain in the dashboard under the Worker's **Settings →
Domains & Routes**.

## First admin

Until accounts are wired up, one secret protects all writes. Set it once:

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
or a locally built release.
