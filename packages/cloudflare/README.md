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
| `put(key, body, size)` | `bucket.put`; a `Uint8Array` is checked against `size`, a stream is piped through `FixedLengthStream(size)` because R2 needs the length up front and must not buffer. A stream that ends early or runs long makes the put fail and nothing is stored. |
| `put(…, { ifNoneMatch: '*' })` | `onlyIf: { etagDoesNotMatch: '*' }`: written only if the key does not exist. |
| `put(…, { ifMatch })` | `onlyIf: { etagMatches }`: written only if the current ETag matches; fails if the key does not exist. |
| failed condition | R2 returns `null`, mapped to `{ ok: false, reason: 'precondition-failed' }`. |
| `contentType` | `httpMetadata.contentType` |
| `list(prefix)` | `bucket.list({ prefix, limit, cursor })`, following `truncated`/`cursor` until the end; keys come back in lexicographic order. |

`presignGet` and `presignPut` are not implemented: a binding cannot sign URLs.
Presigned URLs for LFS need R2's S3 API with an access key and belong in a
separate S3 adapter.

## Tests

`pnpm --filter @git-forge/cloudflare test` runs the tests inside workerd with
a Miniflare R2 bucket through `@cloudflare/vitest-plugin`. The storage
conformance suite in `test/storage-conformance.ts` runs against both
`MemoryStorage` and `R2Storage` (with a small list page size to exercise
pagination); it covers missing keys, streamed multi-MiB puts, length
mismatches, ranges, both conditional writes, racing conditional writers and
listing. Once the shared suite lands in
`packages/core/test/storage-conformance.ts`, this file should be replaced by
it.
