# git-forge

Serverless Git forge with federated mirrors. Design and decisions in
`docs/design.md`, status in `docs/roadmap.md` — read them before changing
architecture or formats, and keep them up to date.

## Rules

- **One language:** TypeScript. Web-standard APIs only (`fetch`, Streams,
  WebCrypto, `DecompressionStream`); no WebAssembly, no `node:*` imports in
  the core.
- **Core logic as pure functions;** HTTP, UI and sync layers call the same
  functions, no duplicated permission logic.
- **Providers only via adapters** (storage, database, scheduling, email).
  The core knows no Cloudflare types.
- **Database: SQLite SQL only**, so that D1, Durable Objects, libSQL and an
  SQLite file all work.
- **Nothing entirely in memory:** packs and LFS objects are streamed.
- **Permissions always from the verified token or session**, never from
  client-supplied data.
- **Formats are durable:** change the bucket layout and log entries only
  backwards-compatibly.
- **Compatibility with real `git` and `git-lfs`** is tested with the real
  clients, not only with our own mocks.
- **Never commit secrets.**
- Everything in English.
- **No code comments.** Explanations belong in `docs/design.md` or the
  package README.
- Work on feature branches and open PRs; the coordinator merges. Before every
  push: `pnpm run typecheck` and `pnpm test` green.
- **Storage is append-only:** the `Storage` interface has no delete.
