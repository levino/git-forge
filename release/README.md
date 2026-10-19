# @git-forge/release

Builds the release artifact that instances deploy, and tests it together with
the instance template in `templates/instance`.

```sh
sh release/build-release.sh [out-dir]
```

writes into `out-dir` (default `release/dist`):

| File | Content |
|---|---|
| `git-forge-worker.mjs` | `apps/forge-worker` built by `astro build` (web UI included, stylesheet compiled in) and bundled by `wrangler deploy dist/server/entry.mjs --dry-run --containers-rollout=none` (no container image build) into one ES module whose only imports are workerd built-ins (`cloudflare:workers`, and `node:async_hooks` loaded dynamically for D1 sessions). Instances upload it with `no_bundle: true`, unchanged. |
| `migrations.tar.gz` | `migrations/*.sql` for D1, collected from the packages listed in `migration_dirs`. Built reproducibly (sorted, zero mtime, `gzip -n`). |
| `SHA256SUMS` | `sha256sum` output for the two files above. |

and prints the SHA-256 of `SHA256SUMS`, which is the `S` an instance pins at
the start of its `[build]` command (`V=<version> S=<sha256>` in
`templates/instance/wrangler.toml`).

The release workflow also attaches the single executables of the `git-forge`
CLI (`packages/cli/build-executables.sh`, built with Bun) and their checksums
in a separate `CLI-SHA256SUMS`, and the single executables of
`git-forge-node` (`apps/forge-node/build-executables.sh`, `linux-x64` and
`linux-arm64`, an instance without Cloudflare) with their checksums in
`NODE-SHA256SUMS`.

`.github/workflows/release.yml` runs the script on every `v*` tag, on a push to
`main` that changes `release/VERSION` (it then creates the tag `v<VERSION>` on
that commit unless the release exists already) and on manual dispatch, and
publishes the three files as release assets with `GITHUB_TOKEN`; the release
notes contain the pin `V=<version> S=<sha256>` and the complete `[build]`
command line taken from `templates/instance/wrangler.toml` with that pin.
Before that, the `runner` job pushes `apps/forge-worker/runner/` (linux/amd64)
to `ghcr.io/levino/git-forge-runner:<version>` with `GITHUB_TOKEN`
(`packages: write`); the digest-pinned reference goes into the release notes
and the `runner-image` asset.
Tags with a `-` (`v0.2.0-rc.1`) are marked as pre-releases. For every other
release the `pin-template` job then writes the new pin and the runner
reference into `templates/instance` and pushes that commit to `main`, so the
Deploy button (which deploys `templates/instance` from `main` as is) always
gets a published release.

## Test

`pnpm --filter @git-forge/release test` builds a release into a temporary
directory, copies `templates/instance`, checks its shape (one pin, resources
by name only, `BOOTSTRAP_TOKEN` as the only secret), pins the release and runs
the `[build]` command from its `wrangler.toml` against it via
`GIT_FORGE_RELEASE_URL=file://…`. It checks that a wrong pin and a tampered
bundle are refused, starts the instance with `wrangler dev` (which runs the
build command too and lets the Worker migrate its local D1), inserts an admin
claim, pushes and clones a repository with the real `git` client and requests
its page in the web UI.
