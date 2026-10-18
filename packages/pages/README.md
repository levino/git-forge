# @git-forge/pages

Static sites per repository, like GitHub Pages. Design:
[design.md §19](../../docs/design.md#19-pages). Tables: `pages_sites`,
`pages_deployments`, `pages_grants`, `pages_sessions` (migration
`0012_pages.sql`).

`createPages(options)` returns:

- `serve(request)`: answers requests for a Pages host (`null` for any other
  host). Resolves the site from the host (`PagesHosts`), checks read access
  (Pages session cookie or `Authorization`), loads the active manifest and
  streams the file.
- `api(request)`: GitHub's Pages REST API under
  `/api/v3/repos/{owner}/{repo}/pages` and the session handoff
  `/_pages/authorize` on the forge host.
- `onPush(repo, outcome, principal)`: deploys the source branch of a
  `legacy` site when it moved.
- `runJob(job)`: runs a queued `pages-deploy` job (`options.schedule`
  enqueues them; without it deployments run inline).

Pure parts: `parsePagesHosts`, `matchPagesHost`, `pagesUrl`, `isPagesUrl`
(hosts), `normalizeSitePath`, `serializeManifest`, `parseManifest`,
`resolvePagesPath`, `pagesContentType` (manifest).

Deployments:

- `buildFromTree` walks a commit (root or `/docs`) and `buildFromTar` reads
  a tar or tar.gz stream (`readTar` and `maybeGunzip` from the core). Every
  file is stored content-addressed under `lfs/objects/<sha256>` (the same
  keys as LFS objects and release assets, so identical files are stored
  once); files that are LFS pointers are kept as pointers. Tar entries up to
  4 MiB are hashed in memory, larger ones are staged in `tmp/` while
  hashing. Limits: 50 000 files and 1 GiB per site (`BuildLimits`).
- The manifest (`{"version":1,"files":{path:{oid,size,lfs?}}}`, keys
  sorted) is stored under `repos/<owner>/<repo>/pages/deployments/<sha256>.json`
  with `If-None-Match: *`.
- `PagesStore.complete` marks the deployment `succeed` and moves
  `active_deployment_id` in one batch, only forward (a slower, older
  deployment never replaces a newer one).
- `ArtifactSource` is the seam for `actions/deploy-pages`: given the
  repository and `artifact_id`/`artifact_url`, it returns the tar stream of
  the `github-pages` artifact. Without it, `artifact_id` requests answer
  `422` and sites are uploaded as tar bodies.
