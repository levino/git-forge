# @git-forge/actions

GitHub Actions compatible CI for git-forge: the Actions service that the
unmodified official [`actions/runner`](https://github.com/actions/runner)
talks to, a GHES-style REST subset under `/api/v3`, and the dispatcher that
turns a push into workflow runs and one ephemeral JIT runner per job.
Architecture, protocol and gaps: [docs/design.md §15](../../docs/design.md#ci).

Everything in `src/` uses web-standard APIs only (WebCrypto, `fetch`,
Streams) and SQLite SQL through the `Database` adapter of
`@git-forge/accounts`, so it runs on Workers with D1 and on Node with
`node:sqlite`. The workflow parser and job model live in `@git-forge/core`.

## Use

```ts
import { applyMigrations } from '@git-forge/accounts'
import { ACTIONS_MIGRATIONS, advanceRun, handleActionsService, handleGhesApi, queueRunsForPush } from '@git-forge/actions'

await applyMigrations(db, ACTIONS_MIGRATIONS, Date.now(), 'actions_migrations')
const urls = { serverUrl: 'https://forge.example', serviceUrl: 'https://forge.example/_services/actions' }
const dispatch = { db, storage, urls, launcher }

handleActionsService(request, { db, storage, basePath: '/_services/actions', instanceId, serverUrl: urls.serverUrl, secrets, onJobCompleted: (job) => advanceRun(dispatch, job) })
handleGhesApi(request, { db, storage, urls, authorize: (request, owner, repo) => isRepoAdmin(request, owner, repo) })
handleGitRequest(request, { storage, onPush: (repo, outcome) => queueRunsForPush(dispatch, { repo, outcome, actor }) })
```

Both handlers return `null` for paths they do not own. The migrations use
their own table (`actions_migrations`) so they can share a database with the
accounts schema.

## Adapters

- `RunnerLauncher` — compute: `launch({ jobId, requestId, runnerName,
  labels, encodedJitConfig })` must start
  `run.sh --jitconfig <encodedJitConfig>` with the official runner somewhere.
  The Cloudflare Containers implementation is in `apps/forge-worker`. A
  failed launch leaves the job queued for any registered runner.
- `SecretsProvider` — `(owner, repo) → Record<name, value>`; values reach the
  runner as secret variables only.

## Running a runner by hand

Against `pnpm --filter forge-worker dev` (or any forge instance), with a
`repo:admin` personal access token of a repository admin:

```sh
curl -sX POST http://127.0.0.1:8787/api/v3/repos/acme/site/actions/runners/generate-jitconfig \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"laptop","runner_group_id":1,"labels":["self-hosted","linux"]}' | jq -r .encoded_jit_config > jit
./run.sh --jitconfig "$(cat jit)"   # in an extracted actions-runner-linux-x64-*.tar.gz
```

The runner then picks up queued jobs whose `runs-on` labels it has.

## Tests

- `test/protocol.test.ts` drives the whole protocol with our own client:
  push with a workflow, JIT config, OAuth assertion, session, long-poll,
  renew, timeline, logs, completion, `needs`, `GITHUB_TOKEN` clone, classic
  registration.
- `test/runner.integration.test.ts` downloads the latest official runner
  (or uses `ACTIONS_RUNNER_DIR`), pushes a workflow that checks out from the
  forge, echoes and runs `wrangler deploy --dry-run` (or a real deploy if
  `CLOUDFLARE_API_TOKEN` is set), and waits for success. It skips with the
  reason in its name when the runner cannot be downloaded or the platform is
  not Linux x64/arm64.
