import { describe, expect, it } from 'vitest'
import {
  DispatchInputError,
  dispatchTrigger,
  filterPatternToRegExp,
  jobLevels,
  parseWorkflow,
  resolveDispatchInputs,
  scheduleCrons,
  triggeredByPullRequest,
  triggeredByPush,
  WorkflowError,
} from '../src/index.ts'

const DEPLOY = `
name: Deploy
on:
  push:
    branches: [main]
env:
  NODE_VERSION: 22
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo test
  deploy:
    needs: test
    runs-on: [self-hosted, linux]
    timeout-minutes: 10
    env:
      CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
    steps:
      - name: Checkout
        id: checkout
        run: |
          git clone "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY" .
        shell: bash
        working-directory: /tmp
      - uses: actions/setup-node@v4
        with:
          node-version: 22
        continue-on-error: true
`

describe('parseWorkflow', () => {
  it('builds the job model', () => {
    const workflow = parseWorkflow(DEPLOY)
    expect(workflow.name).toBe('Deploy')
    expect(workflow.triggers).toEqual([{ event: 'push', branches: ['main'] }])
    expect(workflow.env).toEqual({ NODE_VERSION: '22' })
    const [test, deploy] = workflow.jobs
    expect(test).toEqual({
      id: 'test',
      name: 'test',
      explicitName: false,
      runsOn: ['ubuntu-latest'],
      needs: [],
      env: {},
      defaults: {},
      outputs: {},
      continueOnError: false,
      timeoutMinutes: 360,
      steps: [{ kind: 'run', run: 'echo test', env: {}, continueOnError: false }],
    })
    expect(deploy).toMatchObject({
      id: 'deploy',
      runsOn: ['self-hosted', 'linux'],
      needs: ['test'],
      timeoutMinutes: 10,
      env: { CLOUDFLARE_API_TOKEN: '${{ secrets.CLOUDFLARE_API_TOKEN }}' },
    })
    expect(deploy!.steps).toEqual([
      { kind: 'run', id: 'checkout', name: 'Checkout', run: 'git clone "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY" .\n', shell: 'bash', workingDirectory: '/tmp', env: {}, continueOnError: false },
      { kind: 'uses', uses: 'actions/setup-node@v4', with: { 'node-version': '22' }, env: {}, continueOnError: true },
    ])
    expect(jobLevels(workflow.jobs).map((level) => level.map((job) => job.id))).toEqual([['test'], ['deploy']])
  })

  it('accepts the short trigger forms', () => {
    expect(parseWorkflow('on: push\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: "true"').triggers).toEqual([{ event: 'push' }])
    expect(parseWorkflow('on: [push, workflow_dispatch]\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: "true"').triggers).toEqual([{ event: 'push' }, { event: 'workflow_dispatch' }])
  })

  it('collects every problem', () => {
    const error = (() => {
      try {
        parseWorkflow('jobs:\n  1bad:\n    steps:\n      - run: a\n        uses: b\n  c:\n    runs-on: x\n    needs: [missing]\n    steps: []')
      } catch (caught) {
        return caught as WorkflowError
      }
      return null
    })()
    expect(error).toBeInstanceOf(WorkflowError)
    expect(error!.problems).toEqual([
      'jobs.1bad: job ids must start with a letter or "_" and contain only letters, digits, "-" and "_"',
      'jobs.1bad.runs-on: is required',
      'jobs.1bad.steps[0]: a step needs exactly one of "run" or "uses"',
      'jobs.c.steps: needs at least one step',
      'on: is required',
    ])
  })

  it('rejects job keys that would otherwise be ignored', () => {
    expect(() =>
      parseWorkflow('on:\n  push:\n    paths: [src]\nrun-name: x\njobs:\n  a:\n    services: {}\n    runs-on: x\n    strategy: {matrix: {os: x}, retry: 1}\n    steps: [{run: x, retry: 3}]'),
    ).toThrow(
      'run-name: is not supported yet; jobs.a.services: is not supported yet; jobs.a.strategy.retry: is not supported yet; jobs.a.strategy.matrix.os: expected a list or an expression; jobs.a.steps[0].retry: is not supported yet; on.push.paths: is not supported yet',
    )
  })

  it('rejects dependency cycles and YAML errors', () => {
    expect(() => parseWorkflow('on: push\njobs:\n  a:\n    runs-on: x\n    needs: b\n    steps: [{run: x}]\n  b:\n    runs-on: x\n    needs: a\n    steps: [{run: x}]')).toThrow(/cycle/)
    expect(() => parseWorkflow('on: push\non: pull_request')).toThrow(WorkflowError)
  })
})

describe('workflow features', () => {
  const FULL = `
name: Full
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
    types: [opened, labeled]
  schedule:
    - cron: '*/15 * * * *'
    - cron: '0 3 * * MON-FRI'
  workflow_dispatch:
    inputs:
      level:
        type: choice
        options: [low, high]
        default: low
      dry:
        type: boolean
      count:
        type: number
        required: true
concurrency:
  group: deploy-\${{ github.ref }}
  cancel-in-progress: true
defaults:
  run:
    shell: bash
jobs:
  build:
    if: github.event_name != 'schedule'
    runs-on: \${{ matrix.os }}
    strategy:
      fail-fast: false
      max-parallel: 2
      matrix:
        os: [linux, macos]
        node: [20, 22]
        include:
          - os: linux
            experimental: true
    continue-on-error: \${{ matrix.experimental == true }}
    outputs:
      version: \${{ steps.v.outputs.version }}
    defaults:
      run:
        working-directory: app
    environment:
      name: production
      url: https://example.org
    steps:
      - id: v
        run: echo "version=1" >> "$GITHUB_OUTPUT"
        continue-on-error: \${{ matrix.experimental }}
        timeout-minutes: \${{ matrix.timeout }}
`

  it('parses conditions, strategies, outputs, defaults, environments and triggers', () => {
    const workflow = parseWorkflow(FULL)
    expect(workflow.defaults).toEqual({ shell: 'bash' })
    expect(workflow.concurrency).toEqual({ group: 'deploy-${{ github.ref }}', cancelInProgress: true })
    expect(scheduleCrons(workflow)).toEqual(['*/15 * * * *', '0 3 * * MON-FRI'])
    expect(dispatchTrigger(workflow)?.inputs).toEqual({
      level: { required: false, type: 'choice', options: ['low', 'high'], default: 'low' },
      dry: { required: false, type: 'boolean' },
      count: { required: true, type: 'number' },
    })
    const [build] = workflow.jobs
    expect(build).toMatchObject({
      if: "github.event_name != 'schedule'",
      runsOn: ['${{ matrix.os }}'],
      strategy: { failFast: false, maxParallel: 2, matrix: { os: ['linux', 'macos'], node: [20, 22], include: [{ os: 'linux', experimental: true }] } },
      continueOnError: '${{ matrix.experimental == true }}',
      outputs: { version: '${{ steps.v.outputs.version }}' },
      defaults: { workingDirectory: 'app' },
      environment: { name: 'production', url: 'https://example.org' },
    })
    expect(build!.steps[0]).toMatchObject({ continueOnError: '${{ matrix.experimental }}', timeoutMinutes: '${{ matrix.timeout }}' })
    expect(triggeredByPullRequest(workflow, 'main', 'labeled')).toBe(true)
    expect(triggeredByPullRequest(workflow, 'main', 'synchronize')).toBe(false)
    expect(triggeredByPullRequest(workflow, 'dev', 'opened')).toBe(false)
  })

  it('validates workflow_dispatch inputs', () => {
    const inputs = dispatchTrigger(parseWorkflow(FULL))!.inputs!
    expect(resolveDispatchInputs(inputs, { count: '3', dry: 'true' })).toEqual({ level: 'low', dry: true, count: 3 })
    expect(() => resolveDispatchInputs(inputs, {})).toThrow('input "count" is required')
    expect(() => resolveDispatchInputs(inputs, { count: 1, level: 'medium' })).toThrow(DispatchInputError)
    expect(() => resolveDispatchInputs(inputs, { count: 1, other: 'x' })).toThrow('unexpected inputs: other')
  })

  it('rejects invalid crons', () => {
    expect(() => parseWorkflow("on:\n  schedule:\n    - cron: '61 * * * *'\njobs:\n  a:\n    runs-on: x\n    steps: [{run: x}]")).toThrow('on.schedule[0].cron: invalid minute "61"')
  })
})

describe('push filters', () => {
  const workflow = (filter: string) => parseWorkflow(`on:\n  push:\n${filter}\njobs:\n  a:\n    runs-on: x\n    steps: [{run: x}]`)

  it('matches branches with globs and negations', () => {
    const w = workflow("    branches: ['main', 'release/**', '!release/old']")
    expect(triggeredByPush(w, 'refs/heads/main')).toBe(true)
    expect(triggeredByPush(w, 'refs/heads/release/1/2')).toBe(true)
    expect(triggeredByPush(w, 'refs/heads/release/old')).toBe(false)
    expect(triggeredByPush(w, 'refs/heads/feature')).toBe(false)
    expect(triggeredByPush(w, 'refs/tags/v1')).toBe(false)
  })

  it('runs on every branch and tag without filters, and only tags with a tag filter', () => {
    expect(triggeredByPush(parseWorkflow('on: push\njobs:\n  a:\n    runs-on: x\n    steps: [{run: x}]'), 'refs/tags/v1')).toBe(true)
    const tags = workflow("    tags: ['v*']")
    expect(triggeredByPush(tags, 'refs/tags/v1.0')).toBe(true)
    expect(triggeredByPush(tags, 'refs/heads/main')).toBe(false)
    expect(triggeredByPush(workflow("    branches-ignore: ['wip/*']"), 'refs/heads/wip/x')).toBe(false)
  })

  it('translates filter patterns', () => {
    expect(filterPatternToRegExp('feature/*').test('feature/a/b')).toBe(false)
    expect(filterPatternToRegExp('feature/**').test('feature/a/b')).toBe(true)
    expect(filterPatternToRegExp('v1.?').test('v1.2')).toBe(true)
  })
})
