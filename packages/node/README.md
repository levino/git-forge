# @git-forge/node

Node-only adapters for git-forge. Currently `FsStorage`: the core `Storage`
interface on a local directory, for tests and for self-hosting on a Raspberry
Pi or NAS.

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
instances, stale and held locks.
