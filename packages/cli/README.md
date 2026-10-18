# @git-forge/cli

`git-forge`, a command-line helper for git-forge instances. Its first command,
`git forge push`, pushes history that does not fit into one HTTP request
(Cloudflare caps request bodies at 100 MB on the Free and Pro plans) as a
series of smaller pushes made with the unmodified `git` client.

```sh
git forge push origin main
git forge push --max-bytes 16MiB https://forge.example/acme/site.git main v1.0
git forge push -n origin main          # print the chunks, push nothing
git forge push origin +main            # rewritten history, archived as usual
```

Because the executable is called `git-forge`, `git forge …` works as soon as it
is on `PATH`. It needs `git` 2.38 or newer.

## Login and the credential helper

```sh
git forge auth login https://forge.example   # or without URL: the host of origin
git forge auth login --scopes repo:admin     # also lets you create repositories
git clone https://forge.example/acme/site.git  # no token in the URL
git forge auth status
git forge auth logout https://forge.example
```

`auth login` prints a short link such as
`https://forge.example/login/cli/Xy3…` and opens it when a browser can reach
it (`$BROWSER`, `open`, `xdg-open` with a display; not over SSH, in
Codespaces or dev containers; `--no-browser` never opens one). Sign in with
OIDC or a passkey, check the request (client host, IP, time, access), approve,
and paste the one-time code the page shows at the `Paste the code:` prompt.
The code only works together with the PKCE verifier the CLI kept, once, for
10 minutes. Other ways in:

| Option | Meaning |
|---|---|
| `--scopes repo:read\|repo:write\|repo:admin` | Access to request; default `repo:write` (Git and Git LFS). The consent page can lower it, never raise it. Admin also allows the JSON API, e.g. `repo create`. |
| `--browser-redirect` | Instead of pasting, receive the code on `http://127.0.0.1:<random port>/callback` (RFC 8252). Needs the browser on the same machine. |
| `--device` | RFC 8628 device flow for clients without a prompt; prints the link with the user code to click. |
| `--no-browser` | Print the link only. |
| `--no-setup-git` | Skip the git configuration. |

The forge issues a personal access token with the granted scope, valid for 90
days. It is stored in `~/.config/git-forge/hosts.json`
(`$XDG_CONFIG_HOME/git-forge`, or `GIT_FORGE_CONFIG_DIR`), mode `0600`, and
git is configured globally to use it for that host only:

```ini
[credential "https://forge.example"]
	helper =
	helper = !'/usr/local/bin/git-forge' auth git-credential
```

The empty `helper =` resets other helpers for that host, so a stale password
from the system keychain is never tried first. `git forge auth git-credential
get` answers git's credential protocol from `hosts.json` (`username` is your
login, `password` the token); `store` and `erase` do nothing, so a rejected
token stays until you log in again. `git forge auth setup-git [<url>]` writes
the git configuration later and `git forge auth token [<url>]` prints the
token for scripts.

## Creating repositories

```sh
git forge repo create acme/site --public --remote origin
git forge repo create notes                  # owned by you, private
```

`repo create [<owner>/]<name> [--private|--public] [--default-branch <b>]
[--remote <name>] [--host <url>]` calls `POST /api/repos` with the stored
token, which needs `repo:admin` (`git forge auth login --scopes repo:admin`).
It prints the clone URL and with `--remote` adds it to the current repository.
The forge is `--host`, else the host of `origin` if you are logged in there,
else the only host in `hosts.json`.

## Installation

Download the single executable for your platform from a git-forge release
(`git-forge-linux-x64`, `-linux-arm64`, `-darwin-x64`, `-darwin-arm64`,
`-windows-x64.exe`; checksums in `CLI-SHA256SUMS`), rename it to `git-forge`
(`git-forge.exe` on Windows) and put it on `PATH`. No Node.js, npm or Bun is
needed.

During development run it from the repository:

```sh
pnpm --filter @git-forge/cli start push origin main
pnpm --filter @git-forge/cli build        # dist/git-forge for this machine, needs Bun
sh packages/cli/build-executables.sh out/  # all platforms plus CLI-SHA256SUMS
```

## Options

| Option | Meaning |
|---|---|
| `--max-bytes <size>` | Largest request per push. Default `80MB` (80 000 000 bytes). Also `git config forge.maxPushBytes` or `GIT_FORGE_MAX_PUSH_BYTES`. Units: `k`/`M`/`G` (decimal), `Ki`/`Mi`/`Gi` (binary). Set it below the server's limit: Cloudflare's request body limit (100 MB on Free and Pro), or `MAX_PUSH_BYTES` if the Worker sets one. |
| `-f`, `--force` | Allow non-fast-forward updates, like `+<refspec>`. |
| `-n`, `--dry-run` | Plan and print the chunks without pushing. |

Exit codes: `0` success, `1` error, `2` a single commit is larger than the
budget.

## How it works

For each refspec:

1. `git ls-remote` lists the remote refs. Those whose objects exist locally are
   the negatives, exactly as `git push` computes them.
2. If `git pack-objects --revs --thin --stdout` for the whole push stays below
   the budget (minus 4 KiB for the ref commands), it is one normal `git push`.
3. Otherwise the first-parent line of the source commit that is not yet on
   the remote is split. For the next chunk the helper searches for the
   furthest commit whose pack still fits: `git rev-list --objects
   --disk-usage` gives a cheap estimate for a binary search, then a real
   `pack-objects` dry run (aborted as soon as it passes the budget) checks the
   candidate, and the estimate is rescaled when it was off. Each chunk is a
   plain `git push <remote> <commit>:<ref>`; the pushed commit becomes a
   negative for the next chunk.
4. A first-parent step that alone is too large is a merge of a large side
   branch: that branch is chunked the same way onto a temporary ref, then the
   merge is retried. A non-merge commit that alone is too large aborts with
   exit code 2 and the advice to move large files to Git LFS.
5. The final `git push` sets the destination ref to the source and, in the
   same `--atomic` push, deletes the temporary refs.

### Where chunks go

Chunks of a branch go **directly to the destination branch**:

- Every chunk is an ancestor of the final commit, so after the first chunk
  every update is a fast-forward. Branch protection that forbids force pushes
  keeps working; a rewrite needs `+`/`--force` exactly as with `git push`,
  and git-forge archives the old tip once, on the first chunk.
- Nothing is left behind on the server: no extra refs, and no
  `refs/archive/…` entries, because nothing is deleted.
- Watchers see the branch move through intermediate commits, all of which
  are real history of the branch.

**Temporary refs** `refs/forge-chunk/<destination>/<n>` are only used where
direct chunks are impossible: chunks of a merged side branch (they do not
descend from the branch's current tip, so pushing them to the branch would be
a force push) and chunks of a tag's history. The final atomic push removes
them. git-forge never deletes anything, so their last values remain under
`refs/archive/` — a few refs pointing at commits that are part of the pushed
history anyway.

### Resuming

There is no local state. A rerun lists the remote refs again: chunks that
landed are on the destination branch or on a temporary ref and therefore
negatives, so the plan continues with the first missing chunk. An interrupted
chunk is simply pushed again.

## Why Bun for the single executable

`bun build --compile` turns the TypeScript sources into one self-contained
executable and cross-compiles for Linux, macOS and Windows (x64 and arm64)
from a single CI runner, without a separate bundling step. The CLI only uses
`node:child_process`, which Bun implements, so the same sources also run
unchanged on Node.js for development and tests. `deno compile` would have
worked as well, but needs `node:`-specifier and permission flags handling and
produces larger binaries; `node --experimental-sea-config` cannot
cross-compile and needs a separate bundler. The release workflow
(`.github/workflows/release.yml`) runs `build-executables.sh` and attaches the
executables and `CLI-SHA256SUMS` to every git-forge release, next to the
Worker bundle. `CLI-SHA256SUMS` is separate from `SHA256SUMS`, so the pin of
instances is unaffected.

## Tests

`pnpm --filter @git-forge/cli test` drives the real `git` client through
`git forge push` (a `git-forge` shim on `PATH`) against an in-process forge
with a small request limit: a split push lands the same refs and objects as a
normal push, an interrupted chunk resumes without resending, merged side
branches go through temporary refs, rewrites archive once, an oversized commit
is refused. The Worker's end-to-end suite pushes 24 MiB through `wrangler dev`
with `MAX_PUSH_BYTES` set to 16 MiB.
