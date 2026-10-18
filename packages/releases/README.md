# @git-forge/releases

GitHub-compatible releases. Design: [design.md §16](../../docs/design.md#releases).
Tables: `releases`, `release_assets` (migration `0007_notifications.sql`).

`handleReleasesRequest(request, options)` serves:

| Route | Access |
|---|---|
| `GET /api/v3/repos/{owner}/{repo}/releases[?per_page=&page=]` | read (drafts only with write) |
| `POST /api/v3/repos/{owner}/{repo}/releases {tag_name, target_commitish?, name?, body?, draft?, prerelease?}` | write |
| `GET /api/v3/repos/{owner}/{repo}/releases/latest`, `…/releases/tags/{tag}`, `…/releases/{id}` | read |
| `PATCH\|DELETE /api/v3/repos/{owner}/{repo}/releases/{id}` | write |
| `GET /api/v3/repos/{owner}/{repo}/releases/{id}/assets` | read |
| `POST /api/uploads/repos/{owner}/{repo}/releases/{id}/assets?name=&label=` (also `POST …/releases/{id}/assets`) | write; raw body, `Content-Length` required, optional `X-Content-SHA256` |
| `GET\|PATCH\|DELETE /api/v3/repos/{owner}/{repo}/releases/assets/{id}` | read / write; `Accept: application/octet-stream` redirects to the bytes |
| `GET\|HEAD /{owner}/{repo}/releases/download/{tag}/{name}` | read; `302` to `/{owner}/{repo}/media/{oid}/{name}` |

- Publishing creates a missing tag at `target_commitish` (`createTag`, a
  compare-and-swap on `refs.json` plus `info/refs`) and calls `onTagCreated`
  with a `PushOutcome`, so the caller can run its push pipeline.
- Assets are stored with `storeAsset` as LFS objects keyed by their SHA-256;
  without `X-Content-SHA256` the upload is staged under `tmp/` while hashing.
  Deleting an asset or release only removes database rows.
- `emit` receives `release` events built with `releaseEvent` from
  `@git-forge/notifications`.

The responses carry `upload_url` and `browser_download_url` the way `gh` and
Octokit expect them; running `gh release` against the forge is not tested
yet (`gh` also asks other GHES endpoints, e.g. GraphQL, that the forge does
not serve).
