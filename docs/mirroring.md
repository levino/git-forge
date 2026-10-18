# Mirroring repositories from an upstream instance

A downstream instance can mirror a repository from any Git server over HTTPS:
another git-forge instance, GitHub, Forgejo, or just a static copy in a bucket
or on a CDN. Only Git content and LFS objects are mirrored; issues, pull
requests and discussions are not.

## Model

- A mirrored repository is a normal repository on the downstream instance.
  Downstream users may push their own branches and open their own issues.
- The upstream's branches and tags live read-only under
  `refs/upstream/{remote}/heads/*` and `refs/upstream/{remote}/tags/*`
  (like GitHub's fork sync with upstream as branches). `receive-pack`
  rejects every push to `refs/upstream/` (and, as before, `refs/archive/`).
- Per mirror (one per remote name, default `origin`): upstream URL, mode
  `auto` (picked up by a scheduler through `isMirrorDue`) or `manual`, and
  `detachedAt` (detach: stop syncing, keep every ref and object).
- The core stores no credentials. `syncMirror` takes a
  `getAuthorization(): Promise<string | undefined>` callback that is asked
  before every request, so a personal access token or a short-lived
  federation JWT can be supplied. The Worker keeps tokens of `auth: token`
  mirrors sealed in its database (`docs/design.md` §4).

## Sync algorithm (`syncMirror`)

1. Read the mirror config; a detached mirror returns `detached` and changes
   nothing. Record `lastRun.startedAt` in the status file.
2. Connect: `GET info/refs?service=git-upload-pack` with
   `Git-Protocol: version=2`. A v2 advertisement selects the smart client;
   any non-smart response is treated as a dumb HTTP server.
3. List the upstream refs below `refs/{namespace}heads/` and
   `refs/{namespace}tags/`. Ref names that fail the push validation are
   ignored. `namespace` is empty for a normal upstream and
   `upstream/{remote}/` to mirror another mirror (chained backups).
4. Compute the commit closure of all local refs (`connected`). Upstream tips
   outside it are new. If the new tips are already complete in the object
   database (left over by an interrupted run) nothing is downloaded.
   Otherwise:
   - **v2 with `filter`:** the stepped fetch of imports (`docs/design.md` §7,
     state in `mirrors/{remote}/fetch.json`); with `maxSteps` the run returns
     `pending` and the next run continues; steps 5–7 run after the last step
     with the refs listed at the first one.
   - **v2:** `fetch` with `ofs-delta` and `no-progress`, the new tips as
     `want`s and `have`s walked from all local ref tips in growing batches
     (32, 64, … 256, at most 2048) until the server says `ready`, then
     `done`. Side-band channel 1 is the pack, 2 progress, 3 an error.
   - **dumb:** walk from the new tips, stopping at connected commits. A
     missing object is looked up in the remote pack indexes
     (`objects/info/packs`, `*.idx`) and the containing pack is downloaded
     under its original name; otherwise the loose object
     `objects/xx/yyyy…` is fetched and hash-checked. Loose objects are
     written into one new pack.
   Every pack goes through `parsePack` and `ObjectDatabase.addPack`; packs
   are only ever added.
5. Walk all new objects (stopping at connected commits and at the trees of
   the boundary commits). A missing object fails the run before any ref
   changes. Blobs of at most 1024 bytes are checked for LFS pointers.
6. LFS: pointers found in step 5 plus `lfsPending` from the last run are
   requested from the upstream's LFS Batch API (see below).
7. Update refs with the existing compare-and-swap on `refs.json` (retried on
   conflicts with concurrent pushes):
   - new upstream ref → created,
   - branch moved to a descendant → fast-forward,
   - branch moved to a non-descendant, or tag moved → **history rewritten**:
     the old value is kept under `refs/archive/{time}/upstream/{remote}/…`
     (receive-pack's archive naming) and an alarm is returned,
   - upstream ref gone → the `refs/upstream/…` ref is removed, its value is
     kept under `refs/archive/…` and a **ref deleted** alarm is returned.
   Nothing is ever deleted: objects of archived refs stay reachable. Then
   `info/refs` and `HEAD` are rewritten for dumb clients (also on a no-op
   run, which repairs a crash between the ref update and this step).
8. Write the status file.

Every step before 7 only adds data, and refs are updated last, so a run may
be interrupted at any point and the next run continues: already stored packs
are reused, LFS objects already present are skipped.

## LFS

- Endpoint as in git-lfs: `lfsUrl` from the config, then `lfs.url` or
  `remote.origin.lfsurl` of `.lfsconfig` on the upstream default branch
  (other branches, then tags, if it has none), then `<url>.git/info/lfs`
  (`<url>/info/lfs` when the URL ends in `.git`). An endpoint from
  `.lfsconfig` on another origin gets no `Authorization`. The resolved
  endpoint is kept as `lfsEndpoint` in `status.json`.
- `POST {endpoint}/objects/batch` with `operation: download`,
  `transfers: ["basic"]`, `hash_algo: sha256`, 100 objects per request.
- Downloads use the `header` of the `download` action. The `Authorization`
  from `getAuthorization` is only sent to the batch endpoint and to download
  URLs on the same origin that bring no header of their own.
- Each download is streamed through a verifier (size and SHA-256) into
  `repos/{owner}/{name}/lfs/objects/{oid[0:2]}/{oid[2:4]}/{oid}` with
  `If-None-Match: *`. A mismatch errors the stream, which aborts the upload.
- Objects the upstream does not have, failed downloads and an upstream
  without a batch API (404) do not block the Git sync; they are kept in
  `lfsPending` and retried by every later run. Other HTTP errors (e.g. 401)
  fail the run.

## Bucket layout

```
repos/{owner}/{name}/
  mirrors/{remote}/config.json   # MirrorConfig
  mirrors/{remote}/status.json   # MirrorStatus
  mirrors/{remote}/fetch.json    # MirrorFetchState of a stepped fetch
  mirrors/{remote}/commits.txt   # commit order of the stepped fetch
  mirrors/{remote}/blobs.txt     # blobs of a split commit
  lfs/objects/{oid[0:2]}/{oid[2:4]}/{oid}
```

`config.json`:

```json
{
  "version": 1,
  "remote": "origin",
  "url": "https://forge.example.org/village/archive.git",
  "mode": "auto",
  "namespace": "",
  "lfs": true,
  "createdAt": "2026-10-18T12:00:00.000Z",
  "detachedAt": "2026-11-01T08:00:00.000Z"
}
```

`status.json`:

```json
{
  "version": 1,
  "remote": "origin",
  "lastRun": { "startedAt": "…", "finishedAt": "…", "ok": true },
  "lastSuccessAt": "…",
  "protocol": "v2",
  "upstreamHead": "refs/heads/main",
  "upstreamRefs": 4,
  "upstreamChecksum": "3f1c…",
  "lfsPending": [{ "oid": "…", "size": 123, "reason": "404 Object does not exist" }],
  "alarms": [
    {
      "kind": "history-rewritten",
      "ref": "refs/heads/main",
      "localRef": "refs/upstream/origin/heads/main",
      "oldId": "…",
      "newId": "…",
      "archivedAs": "refs/archive/2026-10-18T12-00-00-000Z/upstream/origin/heads/main",
      "at": "…"
    }
  ]
}
```

A `lastRun` without `finishedAt` is a run that was interrupted. The last 100
alarms are kept.

`upstreamChecksum` follows GitHub Spokes: the XOR of
`sha1(refname + value)` over all mirrored upstream refs, with upstream names
(`refs/heads/main`) and hex object ids. Two copies with the same checksum
hold the same refs; it can be recomputed from `git ls-remote`.

## Backing up GitHub

Needs `PUBLIC_URL`, `INSTANCE_KEY`, the `JOBS` queue and, for private
repositories or webhooks, `ACTIONS_SECRETS_KEY` (32 bytes, hex or base64).

Token: classic PAT with `repo` (private repositories) and `admin:repo_hook`
(webhooks); fine-grained: repository access to all repositories, "Contents:
read", "Metadata: read", "Webhooks: read and write". Public repositories
without webhooks need no token.

```sh
curl -X POST https://forge.example/api/mirrors/github \
  -H "Authorization: Bearer $FORGE_TOKEN" -H 'Content-Type: application/json' \
  -d '{"account": "octocat", "owner": "octocat", "token": "'"$GITHUB_TOKEN"'", "webhook": true}'
```

`FORGE_TOKEN` needs `repo:admin`. The answer lists `queued` and `skipped`
repositories; rerunning it adds only new ones. Without `webhook`, mirrors
follow through the daily safety net; `PUT
/api/repos/{owner}/{repo}/mirrors/origin/webhook` returns URL and secret for
registering a hook by hand (content type `application/json`, event `push`).
A single mirror with a token: `POST /api/repos/{owner}/{repo}/mirrors` with
`auth: "token"` and `token`.

## Limits and open points

- Fetched packs are streamed into the same indexer as a push (bounded memory,
  `docs/design.md` §7); `maxPackBytes` optionally bounds a single fetch.
- Each run walks the commit graph of all local refs to know what is
  connected. Fine for the archive's size; a commit-graph cache can come
  later.
- Smart servers that only speak protocol v0 are not supported; they almost
  always also lack dumb HTTP.
- LFS for a mirror of a mirror needs a batch endpoint; set `lfsUrl` to an
  instance that has one (e.g. the original upstream).
- Alarms are returned and stored; delivering them (mail, webhooks) and
  writing log entries is up to the calling layer.
