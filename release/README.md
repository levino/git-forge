# @git-forge/release

Builds the release artifact that instances deploy, and tests it together with
the instance template in `templates/instance`.

```sh
sh release/build-release.sh [out-dir]
```

writes into `out-dir` (default `release/dist`):

| File | Content |
|---|---|
| `git-forge-worker.mjs` | `apps/forge-worker` bundled by `wrangler deploy --dry-run` into one ES module without imports. Instances upload it with `no_bundle: true`, unchanged. |
| `migrations.tar.gz` | `migrations/*.sql` for D1, collected from the packages listed in `migration_dirs`. Built reproducibly (sorted, zero mtime, `gzip -n`). |
| `SHA256SUMS` | `sha256sum` output for the two files above. |

and prints the SHA-256 of `SHA256SUMS`, which is the `sha256` an instance pins
in `git-forge.json`.

`.github/workflows/release.yml` runs the script on every `v*` tag and
publishes the three files as release assets with `GITHUB_TOKEN`; the release
notes contain the `git-forge.json` to pin. Tags with a `-` (`v0.2.0-rc.1`) are
marked as pre-releases.

## Test

`pnpm --filter @git-forge/release test` builds a release into a temporary
directory, copies `templates/instance`, pins the release and runs the
template's `build.sh` against it via `GIT_FORGE_RELEASE_URL=file://…`. It
checks that a wrong pin and a tampered bundle are refused, applies the D1
migrations locally, starts the instance with `wrangler dev` and pushes and
clones a repository with the real `git` client.

## Instance template repository

The template is meant to live in its own repository `levino/git-forge-instance`.
`.github/workflows/sync-instance-template.yml` copies `templates/instance`
there, with `git-forge.json` pinned to the latest release, after every release
and on every change of the template on `main`; it can also be started by hand
for a given tag. It needs a deploy key with write access on
`levino/git-forge-instance`, stored as the secret
`INSTANCE_TEMPLATE_DEPLOY_KEY` in this repository, and skips itself while the
secret is missing. Mark `levino/git-forge-instance` as a template repository
in its settings so "Use this template" is offered.
