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
import { actionsTick, advanceRun, handleActionsService, handleGhesApi, importSecretsKey, queueRunsForPush } from '@git-forge/actions'

const urls = { serverUrl: 'https://forge.example', serviceUrl: 'https://forge.example/_services/actions' }
const dispatch = { db, storage, urls, launcher }
const secretsKey = await importSecretsKey(env.ACTIONS_SECRETS_KEY)

handleActionsService(request, {
  db, storage, basePath: '/_services/actions', instanceId, serverUrl: urls.serverUrl,
  secrets, secretsKey,
  actionSources: { repositories: { 'actions/*': 'mirrors/*' }, githubFallback: null, canUse },
  onJobCompleted: (job) => advanceRun(dispatch, job),
})
handleGhesApi(request, { db, storage, urls, launcher, secretsKey, authorize: isRepoAdmin, authorizeRead, authorizeWrite, actor })
handleGitRequest(request, { storage, onPush: (repo, outcome) => queueRunsForPush(dispatch, { repo, outcome, actor }) })
actionsTick(dispatch)
```

Both handlers return `null` for paths they do not own. `actionsTick` runs due
scheduled workflows and the reaper; call it from a cron every few minutes.
The tables are part of the D1 schema in `packages/accounts/migrations`
(`0005_actions.sql`, `0009_actions_workflows.sql`), applied by
`wrangler d1 migrations apply` (tests: `applyMigrations(db, MIGRATIONS)`).

## What runs

- Workflows: `on` push (branch/tag filters), `pull_request` (branches,
  types), `workflow_dispatch` (typed inputs), `schedule` (cron); workflow
  `env`, `defaults.run`, `concurrency` (group, `cancel-in-progress`).
- Jobs: `needs` with `needs.<job>.result` and `outputs`, `if` (status
  functions included), `runs-on` with expressions, `strategy.matrix`
  (`include`, `exclude`, expressions such as `fromJSON(needs.x.outputs.y)`),
  `fail-fast`, `max-parallel`, `continue-on-error`, `timeout-minutes`,
  `environment` (with required reviewers), `env`, `defaults`, `outputs`.
- Steps: `run` and `uses` (actions downloaded as tarballs from repositories
  on the forge), `if`, `continue-on-error`, `timeout-minutes`, `env`,
  `shell`, `working-directory`. Step expressions are evaluated by the runner.
- Lifecycle: cancellation (`JobCancellation` message to the runner), job
  timeouts, reaper for dead runners, undelivered jobs and runners that never
  connected, re-runs of a run, of its failed jobs or of one job (with their
  dependents) as a new attempt.
- Secrets: instance secrets (`SecretsProvider`), repository and environment
  secrets encrypted with AES-256-GCM under an instance key, masked by the
  runner; none for untrusted runs (pull requests from other repositories).
- Check runs per job through the `CheckRunSink` adapter (the Worker writes
  them with the collaboration package's check-run store).

## REST (`/api/v3`, GitHub paths)

| Path | Permission |
|---|---|
| `GET repos/{o}/{r}/actions/runs[/{id}[/jobs]]`, `GET …/actions/jobs/{id}[/logs]` | read |
| `POST …/actions/runs/{id}/cancel`, `…/force-cancel`, `…/rerun`, `…/rerun-failed-jobs`, `…/actions/jobs/{id}/rerun` | write |
| `POST …/actions/workflows/{file}/dispatches` (`{ ref, inputs }`) | write |
| `GET/POST …/actions/runs/{id}/pending_deployments` (`{ environment_ids, state }`) | reviewer of the environment |
| `GET/PUT/DELETE …/actions/secrets[/{name}]` (`{ value }`, no sealed boxes) | admin |
| `GET/PUT/DELETE …/environments[/{name}]` (`{ reviewers: [{ type: "User", login }] }`), `…/environments/{name}/secrets[/{secret}]` | admin |
| `GET …/tarball/{ref}` | read (or the action token handed to the runner) |
| runners, `generate-jitconfig`, `registration-token` | admin |

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
- `test/workflows.test.ts` covers outputs across `needs`, a matrix from
  `fromJSON`, `max-parallel`, job conditions, fail-fast with
  `JobCancellation`, re-runs, the cancel API, timeouts, the reaper,
  concurrency, encrypted secrets, environments with reviewers, untrusted
  pull requests, `workflow_dispatch`, schedules, check runs, action
  download info and tarballs.
- `test/runner.integration.test.ts` downloads the latest official runner
  (or uses `ACTIONS_RUNNER_DIR`), mirrors `github.com/actions/checkout` into
  the forge and runs real workflows: `actions/checkout@v4` from the mirror
  plus `wrangler deploy --dry-run` (or a real deploy if
  `CLOUDFLARE_API_TOKEN` is set), a matrix with job outputs and a masked
  secret, and the cancellation of a running job. It skips with the reason
  in its name when the runner cannot be downloaded or the platform is not
  Linux x64/arm64.
