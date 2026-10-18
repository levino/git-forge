# @git-forge/backup

Encrypted, append-only, incremental backups of repositories (Git packs, LFS
objects and an export of issues, pull requests, reviews, discussions,
releases and branch protection) to a bucket that is not a forge: a Hetzner or
Backblaze B2 bucket with Object Lock, a local disk, a partner's bucket. The
bucket only ever sees ciphertext; restoring needs the offline recovery key.
Design and rationale: [docs/design.md §19](../../docs/design.md#19-encrypted-backups).

Web-standard APIs only (WebCrypto `X25519`, `HKDF`, `HMAC`, `AES-GCM`,
Streams); it runs on Node, Bun and Workers. Packs and LFS objects are
streamed in 64 KiB segments, never held in memory.

## Keys

| Key | Where | Purpose |
|---|---|---|
| Recovery key (X25519 private JWK) | offline: password manager, paper, HSM | the only thing that can decrypt |
| Recovery public key (`BACKUP_RECOVERY_KEY`) | instance configuration | seals a fresh key for every backup run |
| Backup secret (`BACKUP_SECRET`, ≥ 32 characters) | instance secret | names objects in the bucket (HMAC), so a run can tell what is already there without reading it; not needed to restore |

Generate the recovery key on a trusted machine with
`git forge backup keygen recovery.jwk` (or `git-forge-node recovery-key`).

## API

```ts
import { backupRepository, nameKeyFromSecret, parseRecoveryPublicKey, restoreRepository } from '@git-forge/backup'

await backupRepository({
  source: storage,                       // the instance's Storage
  repository: { owner: 'acme', name: 'site' },
  storage: backupBucket,                 // any Storage: S3Storage, FsStorage, R2Storage
  recipient: parseRecoveryPublicKey(env.BACKUP_RECOVERY_KEY),
  names: await nameKeyFromSecret(env.BACKUP_SECRET),
  data: (repo) => exportRepositoryData(db, repo),   // optional
})

await restoreRepository({ backup: backupBucket, privateKey, repository, destination: storage })
```

- `backupRepository` / `backupRepositories` upload what is missing and write a
  snapshot unless the repository is unchanged since the last one.
- `restoreRepository` rebuilds a repository in the forge bucket layout (packs
  verified against their trailer and index, LFS objects against their
  SHA-256); `restoreSnapshot` with your own `RestoreSink` writes anywhere,
  e.g. a bare repository (`bareRepositoryFiles`), as the CLI does.
- `summarizeSnapshots`, `findSnapshot` list and pick snapshots (newest
  first).
- `exportRepositoryData` / `importRepositoryData` dump and load the database
  rows of one repository (`git-forge-repository-data-v1`, JSON). Import keeps
  row ids and therefore expects a fresh database; it refuses to run twice and
  rolls back on any conflict. Assignees and review requests of users that do
  not exist on the target are skipped.
- `replicateBackup(from, to)` copies a backup bucket append-only (for a
  partner holding a second copy) and `checkBackupStructure` checks one without
  the key: every object parses, its size matches its header, its run key
  record exists.

## Bucket layout

```
README.txt                    plain text: what this is and how to restore
keys/<run>.json               per run: ephemeral X25519 public key, recipient key id
objects/<n[0:2]>/<n>          sealed pack, index, LFS object or data export; n = HMAC(secret, address)
snapshots/<run>-<tag16>       sealed snapshot: refs.json state, pack list, LFS list, data export
seen/<tag>                    empty marker: this exact snapshot exists already
```

Everything is written with `If-None-Match: *` and never rewritten, so a
bucket with Object Lock (compliance mode) or a WORM retention policy works as
is. Expire nothing; snapshots are small.

## Sealed object format (version 1)

```
"GFBACKUP" | 0x01 | len(run) | run | segment size (u32) | plaintext size (u64) | salt (16)
segment 0 .. n-1:  AES-256-GCM(key, nonce = 0^3 | index (u64) | last (u8), aad = header)
```

The object key is `HKDF-SHA256(run key, salt, "git-forge backup object v1")`;
the run key is `HKDF-SHA256(X25519(ephemeral, recovery), ephemeral ‖ recovery,
"git-forge backup run v1")`. The last segment carries the flag `1`, so
truncation, reordering, appending and header changes all fail
authentication.

## Tests

`pnpm --filter @git-forge/backup test`: round trips at segment boundaries,
tampering, wrong keys, no plaintext (contents, names, refs, LFS oids) in the
bucket, incremental runs, restore into the forge layout and into a bare
repository checked by `git fsck` and `git clone`, replication and the keyless
structure check, the data export round trip on SQLite.
