# @git-forge/libsql

The `Database` interface of [`@git-forge/accounts`](../accounts) over
libSQL's Hrana-over-HTTP protocol (`POST /v2/pipeline`): Bunny Database,
Turso and self-hosted `sqld`. Only `fetch`, so it runs on Node, Bun, Deno and
Workers.

```ts
import { applyMigrations, MIGRATIONS } from '@git-forge/accounts'
import { libsqlDatabase } from '@git-forge/libsql'

const db = libsqlDatabase({ url: 'libsql://forge.lite.bunnydb.net', authToken })
await applyMigrations(db, MIGRATIONS)
```

- `url`: `libsql://` and `wss://` map to `https://`, `ws://` to `http://`.
  `authToken` is sent as `Authorization: Bearer`.
- Every call is one stateless pipeline request (`execute` + `close`), so no
  baton or sticky session is needed.
- `batch` is one `batch` request: `BEGIN IMMEDIATE`, the statements (each
  conditioned on the previous one), `COMMIT`, and `ROLLBACK` if the commit
  step did not succeed. The first failing step is thrown as `LibsqlError`
  with the server's message (`UNIQUE constraint failed: …` as on SQLite).
- Integers outside the safe range come back as `bigint`, blobs as
  `Uint8Array`.
- Foreign keys: `sqld` enforces them by default; the adapter sends no
  `PRAGMA`.

## Tests

`pnpm test` runs the protocol tests with a fake `fetch`, and, when an `sqld`
binary is on `PATH` or in `SQLD_BIN`, the tests against a real server:
`test/global-setup.ts` starts `sqld` with namespaces and JWT auth, and
`sqldDatabase()` from `test/sqld.ts` creates a fresh namespace per call.
The accounts suite runs on it with
`pnpm --filter @git-forge/accounts-node test:libsql`. Binary:
`libsql-server-x86_64-unknown-linux-gnu.tar.xz` from the
[`libsql-server` releases](https://github.com/tursodatabase/libsql/releases)
(the `libsql` CI job pins v0.24.32) or the image
`ghcr.io/tursodatabase/libsql-server`.
