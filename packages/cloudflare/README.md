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
| `get(key, range)` | One ranged `bucket.get`; bytes and size come from the same response. Only if that fails or the range runs past the end: `bucket.head` first, then the range is clamped to the object size and read with `onlyIf: { etagMatches }`. A range starting at or beyond the end yields an empty body, as in `MemoryStorage`. |
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

## `cacheApiObjectCache`

`ObjectCache` of the core over the Cache API: `cachedStorage(storage, cacheApiObjectCache())`
keeps pack indexes, pack heads and pack ranges up to 1 MiB in the colo's cache
under a private host. Pack files are content-addressed, so entries never go
stale.

## `cacheApiPageCache`

Page cache of the Worker UI over the Cache API: `cacheApiPageCache(300)` stores
responses under a private host with `Cache-Control: public, max-age=300`
(the original `Cache-Control` travels in `X-Forge-Cache-Control` and is
restored on a hit), drops `Vary`, and never stores a response with
`Set-Cookie`. Which pages may be cached is decided by the caller (design §18).

## `d1Sessions`

`Database` (of `@git-forge/accounts`) over a D1 binding with the Sessions API:
`d1Sessions(env.DB, new AsyncLocalStorage())`. `run(start, callback)` runs one
request in its own `withSession(start)`; every query of the request goes
through that session (found via the context storage), queries outside a
request use the binding (primary). `start` is `sessionStart(request)`:
`first-primary` for unsafe methods, else the request's bookmark
(`X-Forge-Bookmark` header, then the `gf_bookmark` cookie, `__Host-` on
HTTPS), else `first-unconstrained`. `withBookmark` returns the session's
latest bookmark in `X-Forge-Bookmark` to clients that sent one, and sets the
cookie (5 minutes) after writes of unsafe requests, so a user reads their own
writes on a replica. Without a context storage (no `node:async_hooks`) every
query uses the binding.

## `createCloudflareEmailSender`

`EmailSender` over a `send_email` binding (Cloudflare Email Service):
`createCloudflareEmailSender(env.EMAIL, 'Forge <forge@example.org>')`. The
sender's domain must be onboarded for Email Sending. Error codes
`E_RATE_LIMIT_EXCEEDED`, `E_DAILY_LIMIT_EXCEEDED`, `E_INTERNAL_SERVER_ERROR`,
`E_DELIVERY_FAILED` and errors without a code are rethrown (the job queue
retries); every other code is an `EmailRejectedError`.

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
