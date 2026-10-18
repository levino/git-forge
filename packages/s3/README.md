# @git-forge/s3

`S3Storage`: the core `Storage` interface on any S3-compatible object store,
built on `fetch` and [`aws4fetch`](https://github.com/mhart/aws4fetch) for
SigV4. Web-standard APIs only, so it runs on Node, Bun, Deno and Workers.

```ts
import { S3Storage } from '@git-forge/s3'

const storage = new S3Storage({
  endpoint: 'https://s3.eu-central-1.amazonaws.com',
  region: 'eu-central-1',
  bucket: 'forge',
  accessKeyId,
  secretAccessKey,
  prefix: 'optional/prefix/',
  forcePathStyle: true,
})
```

| Option | Meaning |
|---|---|
| `endpoint`, `region`, `bucket` | Where to send requests and which region to sign for. |
| `accessKeyId`, `secretAccessKey`, `sessionToken?` | Credentials. |
| `prefix?` | Prepended to every key and stripped from `list` results. |
| `forcePathStyle?` | `https://host/bucket/key` instead of `https://bucket.host/key`. Needed for most self-hosted servers. |
| `listPageSize?` | `max-keys` for `ListObjectsV2`; the server default (1000) if unset. |
| `fetch?` | Custom `fetch`, e.g. for tests or a service binding. |

## Mapping

| `Storage` | S3 |
|---|---|
| `get(key)` / `get(key, range)` | `GetObject`, with `Range: bytes=…`; the full size comes from `Content-Range`. `416` and empty ranges yield an empty body with the object's size and ETag. |
| `head(key)` | `HeadObject` |
| `put(key, body, size)` | `PutObject` with `Content-Length: size`. A `Uint8Array` is signed with its SHA-256; a stream is sent with `UNSIGNED-PAYLOAD` and piped through `exactLength(size)` from the core, which withholds the last byte until the source has ended at exactly `size` bytes. A body that runs short, long or errors therefore never delivers `Content-Length` bytes and the server discards the upload. On Workers the stream additionally goes through `FixedLengthStream`. |
| `ifNoneMatch: '*'` | `If-None-Match: *` |
| `ifMatch` | `If-Match: "<etag>"` |
| failed condition | `412`, a `409 ConditionalRequestConflict` (concurrent conditional writes on AWS) and a `404` for `If-Match` on a missing key all map to `{ ok: false, reason: 'precondition-failed' }`. |
| `list(prefix)` | `ListObjectsV2`, following `NextContinuationToken`. |
| `presignGet` | Query-signed `GET` URL. |
| `presignPut(key, size, sha256, expires)` | Query-signed `PUT` URL whose signed headers include `content-length` and `x-amz-checksum-sha256`. The client must send exactly these headers (returned in `headers`); the server rejects a different length, a different checksum header (signature mismatch) and content that does not match the checksum. This is how LFS uploads go straight to the bucket without the forge seeing the bytes. |

ETags are returned unquoted. Other S3 errors throw `S3Error` with `status` and
the S3 error `code`.

The server must support conditional writes on `PutObject` and
`x-amz-checksum-sha256`; refs rely on the former, LFS uploads on the latter.
Servers that silently ignore `If-Match`/`If-None-Match` are not safe to use.
Cloudflare R2's S3 API can be used through this adapter when presigned URLs
are needed (the `R2Storage` binding adapter cannot sign); the Worker uses it
only as presigner (`withPresigner`).

## Tests

`pnpm test` runs the XML parser tests and skips everything that needs a
server. With a server, the shared storage conformance suite from
`@git-forge/core/test/storage-conformance.ts` runs twice (with a prefix and a
small list page size, and without a prefix over 1005 keys), plus presigned-URL
tests: GET, tampered signature, exact PUT, same-length forged content,
different length, missing checksum header, replaced checksum header, expiry.
`test/lfs-presigned.test.ts` pushes and clones a 3 MiB object with the real
`git-lfs` through a 1 MiB body limit via presigned URLs.

```sh
pnpm --filter @git-forge/s3 test:s3
```

`test:s3` uses `S3_TEST_*` if set, otherwise starts a local
[versitygw](https://github.com/versity/versitygw) (a `versitygw` binary on
`PATH` or in `VERSITYGW_BIN`, else `compose.yaml` via `docker compose`), runs
the tests against it and stops it again. `pnpm s3:up` / `pnpm s3:down` start
and stop the compose service alone (port 7070, bucket `git-forge-test`,
credentials `git-forge` / `git-forge-local-secret`).

To install the binary without Docker: `go install github.com/versity/versitygw/cmd/versitygw@v1.9.0`.
The `s3` job in `.github/workflows/ci.yml` does exactly that and runs `test:s3`.

Against any other server:

| Variable | Meaning |
|---|---|
| `S3_TEST_ENDPOINT` | e.g. `http://127.0.0.1:7070` |
| `S3_TEST_BUCKET` | existing bucket |
| `S3_TEST_ACCESS_KEY_ID`, `S3_TEST_SECRET_ACCESS_KEY` | credentials |
| `S3_TEST_REGION` | default `us-east-1` |
| `S3_TEST_FORCE_PATH_STYLE` | default `true` |
| `S3_TEST_PREFIX` | default `git-forge-test/` |

Tests only ever write below unique per-run prefixes and never delete.

### Local S3 servers evaluated (October 2026)

MinIO is discontinued. Results of this suite (45 tests) against the
candidates:

| Server | Version | Result |
|---|---|---|
| versitygw (posix backend) | v1.9.0 | all pass |
| RustFS | 1.0.3 | all pass |
| SeaweedFS | image of 2026-09-28 | conditional writes and checksums pass; `ListObjectsV2` returns keys in directory order (`p/c/d` before `p/c-z`), not lexicographic |
| Garage | v2.1.0 | ignores `If-Match` and `If-None-Match` (every concurrent writer "wins"); expired presigned URLs answer `400` |

versitygw is the default: it passes everything, is a single Go binary that
also runs without Docker, and starts instantly.
