# @git-forge/node

Node-only adapters for git-forge (they also run on Bun):

- `FsStorage`: the core `Storage` interface on a local directory, for tests
  and for self-hosting on a Raspberry Pi or NAS.
- `serve(handler, options)` / `nodeHandler(handler, options)`: serve a
  `fetch`-style handler (`(Request) => Promise<Response>`) over `node:http`.
- `nodeDigests`: the core `DigestFactory` on `node:crypto`, much faster than
  the JavaScript fallback.

`apps/forge-node` combines them into a full instance.

```ts
import { FsStorage } from '@git-forge/node'

const storage = new FsStorage('/srv/git-forge')
```

Each key is a plain file below the root (`repos/acme/site/git/HEAD` is
`/srv/git-forge/repos/acme/site/git/HEAD`), so the directory can be served
by any static web server and cloned via dumb HTTP without the forge.

## Behaviour

- **Atomic puts.** The body is streamed into a temporary file, counted against
  the declared size, `fdatasync`ed and then `rename`d onto the key. A short,
  long or failing body throws and leaves the key untouched.
- **Conditional writes.** `ifNoneMatch: '*'` and `ifMatch` are checked and
  applied under a per-key lock file created with `O_EXCL`, so they hold across
  processes sharing the directory. Unconditional puts take the same lock.
  A lock older than `staleLockMs` (default 30 s) is considered left behind by
  a crashed writer and broken; waiting for a lock gives up after
  `lockTimeoutMs` (default 10 s).
- **ETags** are derived from inode, size, modification and change time, so they
  change on every write without hashing the file. This needs a file system
  with stable inode numbers and fine-grained timestamps (ext4, XFS, Btrfs, ZFS,
  APFS).
- **Reads** open the file once and stream from that handle, so a concurrent
  replace never mixes two versions. Ranges are clamped to the file size.
- **Listing** walks only the directories that can contain the prefix and yields
  keys in lexicographic order, like S3.

## HTTP

`serve` listens on `host:port` (default `127.0.0.1`, a free port) and returns
`{ server, url, close }`. Request bodies reach the handler as a stream
(`Readable.toWeb`, `duplex: 'half'`), never buffered; response bodies are
written chunk by chunk with backpressure (`drain`). When the client goes away,
the request's `signal` aborts and the response stream is cancelled. Repeated
request headers are combined, multiple `Set-Cookie` headers are kept,
responses to `HEAD` have no body. The request URL uses the `Host` header;
with `trustProxy: true` it uses `X-Forwarded-Proto` and `X-Forwarded-Host`
instead. An exception in the handler becomes a `500` (reported to
`onError`); one after the headers were sent destroys the connection. There is
no overall request timeout, since pushes and clones can take long; header
reading is limited to 60 s.

## Restrictions

- Keys must be relative, `/`-separated, without empty, `.` or `..` segments
  and without backslashes or NUL. A key cannot also be a "directory" of
  another key (`a` and `a/b`); the git-forge bucket layout never needs that.
- `.git-forge/` at the root is reserved for temporary and lock files. It is
  hidden from `list` and keys inside it are rejected. Temporary files of a
  crashed process stay there.
- No presigning: LFS uploads go through the forge (`PUT .../info/lfs/objects/{oid}`).

## Tests

`pnpm --filter @git-forge/node test` runs the shared storage conformance
suite from `@git-forge/core/test/storage-conformance.ts` on a temporary
directory, plus file-system specifics: plain-file layout, keys that would
escape the root, no leftover temporary files, compare-and-swap across separate
instances, stale and held locks. `test/http.test.ts` covers streaming in
both directions, headers, `HEAD`, errors, forwarded origins and client
disconnects; `test/digest.test.ts` compares `nodeDigests` with the JavaScript
digests.
