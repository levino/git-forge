# Git LFS in `@git-forge/core`

Implements the [Git LFS Batch API](https://github.com/git-lfs/git-lfs/blob/main/docs/api/batch.md)
with the `basic` transfer adapter and `sha256` as the only hash algorithm.

## Modules

- `src/lfs.ts` — pure core: batch request parsing and validation, per-object
  results, pointer parsing, the hash-while-streaming store, `verify`, and the
  pre-receive check (`lfsPushCheck`, `missingLfsObjects`).
- `src/lfs-http.ts` — `handleLfsRequest`, the HTTP layer. `handleGitRequest`
  calls it first for every repository route, so no separate wiring is needed.
  Pass `lfs: false` in `GitHttpOptions` to switch LFS (routes and push check)
  off, or `lfs: { expiresInSeconds, maxJsonBytes }` to tune it.

## Routes

All below `/{owner}/{repo}(.git)/info/lfs`, which is where `git-lfs` looks by
default for a remote `https://host/{owner}/{repo}(.git)`.

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| `POST` | `/objects/batch` | `read` (download) / `write` (upload) | Batch API |
| `POST` | `/objects/verify` | `write` | `verify` action |
| `PUT` | `/objects/{oid}` | `write` | upload fallback without presigning |
| `GET`/`HEAD` | `/objects/{oid}` | `read` | download fallback without presigning |

Anything else below `/info/lfs` (e.g. the locks API) answers `404` with an LFS
JSON error; `git-lfs` treats that as “locking not supported”. All responses use
`application/vnd.git-lfs+json`. Request-level errors: `409` for an unsupported
`hash_algo`, `422` for an invalid body, `413` for an oversized body or more
than 1000 objects, `404` for an unknown repository. Per-object errors: `404`
when a download target is missing, `422` for an invalid oid or size or a size
that differs from the stored object.

Access is decided by the `authorize` hook of `GitHttpOptions`, i.e. from the
verified token or session. For the batch endpoint the hook runs after the body
has been parsed because the required access depends on `operation`. Actions
pointing back at the forge carry the `Authorization` header of the batch request
so `git-lfs` presents the same credentials to the transfer endpoints, which
check access again.

## Storage layout

```
repos/{owner}/{repo}/lfs/objects/{oid[0:2]}/{oid[2:4]}/{oid}
```

An object counts as **present** when this key exists with exactly the size from
the pointer. Nothing else is written; there are no marker or staging keys.

## Uploads

**With presigning** (`Storage.presignPut` implemented, e.g. S3/R2): the batch
response hands out a presigned `PUT` for the final key. The adapter must bind
the URL to the declared size and SHA-256 (e.g. `Content-Length` plus
`x-amz-checksum-sha256`), so the bucket itself refuses wrong content. Because
the forge did not see the bytes, `verify` re-reads the object and hashes it
before answering `200`.

**Without presigning** (`MemoryStorage`, file system): the upload goes to
`PUT .../info/lfs/objects/{oid}` and is streamed into `Storage.put` for the
final key through a `TransformStream` that counts and hashes the bytes. If the
body is longer than `Content-Length`, shorter, or hashes to something other
than the oid, the stream errors before it ends and the upload answers `422`.
`verify` then only compares the size.

Why no staging key: the storage is append-only, so a staging copy could never
be removed and every object would be stored twice. Instead this relies on one
contract for `Storage.put`, which S3, R2 and `MemoryStorage` already fulfil and
which every other adapter must fulfil (file system: write to a temporary file,
rename on success):

> `put` is atomic. If the body stream errors, nothing is stored under the key.

The put also uses `If-None-Match: *`, so a concurrent upload of the same object
never overwrites an existing one.

## Pre-receive check

`handleGitRequest` runs `lfsPushCheck` before any custom
`receive.beforeUpdate`. It parses every blob of the pushed pack as an LFS
pointer (strict spec format: `version` first (the current or the legacy
`hawser` URL), remaining keys sorted,
`oid sha256:<64 hex>`, canonical `size`, trailing newline, under 1024 bytes) and
rejects the whole push with `missing LFS object <oid>` if any referenced object
is not present. `git-lfs` uploads objects in its pre-push hook, so a regular
push always passes; a push made with `--no-verify` or without `git-lfs` does not.

Only blobs contained in the pack are checked. Pointers already stored in the
repository were checked when they were pushed.

## Tests

- `test/lfs.test.ts` — unit tests for the core functions.
- `test/lfs-http.test.ts` — integration tests with the real `git` and `git-lfs`
  clients against the in-process HTTP server: push, clone with smudge,
  `git lfs pull`, `git lfs fsck`, incremental upload, rejection of pushes with
  missing objects (`--no-verify` and a hand-written pointer), rejection of
  unauthorized uploads, rejection of mismatching bytes, and presigned URLs.
