# @git-forge/accounts-node

Node-only adapter for [`@git-forge/accounts`](../accounts): the `Database`
interface on top of Node 22's built-in `node:sqlite`, for tests and
self-hosting on a Raspberry Pi or NAS.

```ts
import { applyMigrations, createAccountsStore, MIGRATIONS } from '@git-forge/accounts'
import { openSqliteDatabase } from '@git-forge/accounts-node'

const { db } = openSqliteDatabase('/var/lib/git-forge/accounts.sqlite')
await applyMigrations(db, MIGRATIONS)
const store = createAccountsStore(db)
```

`openSqliteDatabase` enables foreign keys, WAL mode for files and a busy
timeout. `batch` runs inside `BEGIN IMMEDIATE … COMMIT`.

The tests here also cover the schema on a real SQLite, the D1 adapter against
a D1-shaped fake, and an end-to-end run with the real `git` client against
`handleGitRequest` with the accounts authorizer: private clones with and
without tokens, Basic and Bearer credentials, push permissions, public
repositories, and clones by a federated instance with a minted JWT.

`pnpm test:libsql` runs the same suites (except the D1 fake) against a local
`sqld` through `@git-forge/libsql` (see its README). `locked-storage.test.ts`
runs the storage conformance suite through `lockedStorage` over a storage that
ignores conditions, and over `S3Storage` when `S3_TEST_*` is set.
