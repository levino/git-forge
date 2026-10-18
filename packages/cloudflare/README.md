# @git-forge/cloudflare

Cloudflare adapters for git-forge. The core never imports Cloudflare types;
everything platform-specific lives here.

## `R2Storage`

Implements the core `Storage` interface on an R2 bucket binding.

```ts
import { R2Storage } from '@git-forge/cloudflare'

const storage = new R2Storage(env.BUCKET, { prefix: 'optional/prefix/' })
```

| `Storage` | R2 |
|---|---|
| `get(key)` | `bucket.get(key)`; the ETag is R2's unquoted `etag`. |
| `get(key, range)` | `bucket.head` first, then the range is clamped to the object size and read with `bucket.get(key, { range, onlyIf: { etagMatches } })`, so the bytes and the reported size belong to the same version. A range starting at or beyond the end yields an empty body, as in `MemoryStorage`, instead of relying on how R2 treats such ranges. |
| `head(key)` | `bucket.head(key)` |
| `put(key, body, size)` | `bucket.put`; a `Uint8Array` is checked against `size`. A stream is piped through `exactLength(size)` from the core, which withholds the last byte until the source has ended at exactly `size` bytes, and then through `FixedLengthStream(size)` because R2 needs the length up front and must not buffer. A stream that ends early, runs long or errors never delivers all bytes, so the put fails and nothing is stored. (`FixedLengthStream` alone lets R2 commit the first `size` bytes of a body that runs long.) |
| `put(…, { ifNoneMatch: '*' })` | `onlyIf: { etagDoesNotMatch: '*' }`: written only if the key does not exist. |
| `put(…, { ifMatch })` | `onlyIf: { etagMatches }`: written only if the current ETag matches; fails if the key does not exist. |
| failed condition | R2 returns `null`, mapped to `{ ok: false, reason: 'precondition-failed' }`. |
| `contentType` | `httpMetadata.contentType` |
| `list(prefix)` | `bucket.list({ prefix, limit, cursor })`, following `truncated`/`cursor` until the end; keys come back in lexicographic order. |

`presignGet` and `presignPut` are not implemented: a binding cannot sign URLs.
Presigned URLs for LFS need R2's S3 API with an access key; use `S3Storage`
from [`@git-forge/s3`](../s3) for that.

## Tests

`pnpm --filter @git-forge/cloudflare test` runs the tests inside workerd with
a Miniflare R2 bucket through `@cloudflare/vitest-plugin`. The shared storage
conformance suite from `@git-forge/core/test/storage-conformance.ts` runs
against `R2Storage` with a list page size of 7 to exercise pagination.

### Simulator noise

The conformance tests that make a `put` fail (stream errors, wrong length)
abort an upload stream on purpose. Miniflare's local R2 simulator, which runs in its
own workerd worker, then leaves internal promises unhandled, and workerd logs
`uncaught exception; … Error: Network connection lost.`,
`… TypeError: Can't read from request stream because client disconnected.`
and `disconnected: fixed-length pipe ended prematurely`. The promise is not in
`R2Storage` or the test worker (an `unhandledrejection` listener in the test
worker never fires), the `put` itself rejects as it should, and real R2 is not
involved. The vitest pool overrides Miniflare's log handler, so
`vitest.config.ts` drops exactly these lines from the test process output.
Any other workerd output is passed through.
