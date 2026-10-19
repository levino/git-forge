import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const LABEL = 'git-forge-hook'

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

const docker = (args, { capture = false, input, env } = {}) => {
  const result = spawnSync('docker', args, { stdio: [input === undefined ? 'ignore' : 'pipe', capture ? 'pipe' : 'inherit', 'inherit'], input, env: { ...process.env, ...env }, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`docker ${args.filter((arg) => !arg.startsWith('-'))[0]} failed (${result.status ?? result.signal})`)
  return (result.stdout ?? '').trim()
}

const dockerReady = () => spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0

const rootOnOverlay = () => fs.readFileSync('/proc/mounts', 'utf8').split('\n').some((line) => line.split(' ')[1] === '/' && line.split(' ')[2] === 'overlay')

const ensureDocker = () => {
  if (dockerReady()) return
  spawn('sudo', ['-n', 'dockerd', '--iptables=false', '--ip6tables=false', ...(rootOnOverlay() ? ['--storage-driver=vfs'] : [])], { detached: true, stdio: 'ignore' }).unref()
  for (let i = 0; i < 120; i++, sleep(500)) if (dockerReady()) return
  throw new Error('dockerd did not start')
}

const words = (text) => {
  text ??= ''
  const out = []
  let word = null
  let quote = null
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === quote) quote = null
      else word += ch === '\\' && quote === '"' && i + 1 < text.length ? text[++i] : ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      word ??= ''
    } else if (/\s/.test(ch)) {
      if (word !== null) out.push(word)
      word = null
    } else word = (word ?? '') + (ch === '\\' && i + 1 < text.length ? text[++i] : ch)
  }
  if (word !== null) out.push(word)
  return out
}

const splitOptions = (text) => {
  const options = []
  const aliases = []
  let name
  const list = words(text)
  for (let i = 0; i < list.length; i++) {
    const match = /^--(network-alias|net-alias|network|net)(?:=(.*))?$/.exec(list[i])
    name ??= /^--label=git-forge-service=(.+)$/.exec(list[i])?.[1]
    if (!match) options.push(list[i])
    else {
      const value = match[2] ?? list[++i]
      if (match[1].endsWith('alias')) aliases.push(value)
    }
  }
  return { options, aliases: name ? [name, ...aliases] : aliases }
}

const hostArgs = (hosts) => hosts.flatMap((host) => ['--add-host', `${host}:127.0.0.1`])

const runArgs = (info, extra) => {
  const { options, aliases } = splitOptions(info.createOptions)
  const env = info.environmentVariables ?? {}
  const mounts = [...(info.userMountVolumes ?? []), ...(info.systemMountVolumes ?? [])]
  return {
    aliases,
    env,
    args: [
      `--label=${LABEL}`,
      '--network=host',
      ...extra,
      ...options,
      ...Object.keys(env).flatMap((key) => ['-e', key]),
      '-e',
      'GITHUB_ACTIONS=true',
      ...('CI' in env ? [] : ['-e', 'CI=true']),
      ...mounts.map((mount) => `-v=${mount.sourceVolumePath ? `${mount.sourceVolumePath}:` : ''}${mount.targetVolumePath}${mount.readOnly ? ':ro' : ''}`),
      ...(info.entryPoint ? ['--entrypoint', info.entryPoint] : []),
    ],
  }
}

const pull = (image, registry) => {
  const config = registry?.username && registry.password ? fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'docker-')) : null
  try {
    if (config) docker(['--config', config, 'login', '-u', registry.username, '--password-stdin', ...(registry.serverUrl ? [registry.serverUrl] : [])], { input: registry.password })
    for (let attempt = 1; ; attempt++) {
      try {
        return docker([...(config ? ['--config', config] : []), 'pull', image])
      } catch (error) {
        if (attempt === 3) throw error
      }
    }
  } finally {
    if (config) fs.rmSync(config, { recursive: true, force: true })
  }
}

const ports = (mappings) => Object.fromEntries((mappings ?? []).map((mapping) => mapping.split(':').pop().split('/')[0]).map((port) => [port, port]))

const healthy = (id, image) => {
  for (let i = 0; ; i++) {
    const status = docker(['inspect', '--format', '{{if .Config.Healthcheck}}{{.State.Health.Status}}{{end}}', id], { capture: true })
    if (status === '' || status === 'healthy') return
    if (status !== 'starting' || i >= 300) throw new Error(`container ${image} is ${status}`)
    console.log(`${image} is ${status}`)
    sleep(2000)
  }
}

const cleanup = () => {
  const ids = docker(['ps', '--all', '--quiet', '--filter', `label=${LABEL}`], { capture: true })
  if (ids) docker(['rm', '--force', ...ids.split('\n')], { capture: true })
}

const prepareJob = (args, responseFile) => {
  ensureDocker()
  cleanup()
  const hosts = []
  const services = (args.services ?? []).map((service) => {
    pull(service.image, service.registry)
    const { args: run, aliases, env } = runArgs(service, [])
    hosts.push(...aliases)
    const id = docker(['run', '--detach', ...run, service.image, ...(service.entryPointArgs ?? [])], { capture: true, env })
    return { id, contextName: aliases[0], image: service.image, network: 'host', ports: ports(service.portMappings) }
  })
  const job = args.container?.image ? args.container : null
  let container
  let jobPath
  if (job) {
    pull(job.image, job.registry)
    const { args: run, env } = runArgs({ ...job, entryPoint: job.entryPoint || 'tail' }, hostArgs([...new Set(hosts)]))
    const id = docker(['run', '--detach', ...run, job.image, ...(job.entryPoint ? (job.entryPointArgs ?? []) : ['-f', '/dev/null'])], { capture: true, env })
    container = { id, network: 'host', ports: ports(job.portMappings) }
    healthy(id, job.image)
    jobPath = docker(['inspect', '--format', '{{range .Config.Env}}{{println .}}{{end}}', id], { capture: true })
      .split('\n')
      .find((line) => line.startsWith('PATH='))
      ?.slice(5)
  }
  for (const service of services) healthy(service.id, service.image)
  const isAlpine = container ? spawnSync('docker', ['exec', container.id, 'sh', '-c', 'grep -qi "^ID=.*alpine" /etc/os-release'], { stdio: 'ignore' }).status === 0 : false
  const state = { container: container?.id, path: jobPath, services: services.map((service) => service.id), hosts: [...new Set(hosts)] }
  fs.writeFileSync(responseFile, JSON.stringify({ state, context: { ...(container ? { container } : {}), services }, isAlpine }))
}

const runScriptStep = (args, state) => {
  const env = args.environmentVariables ?? {}
  const prepend = Array.isArray(args.prependPath) ? args.prependPath.join(':') : args.prependPath
  const result = spawnSync(
    'docker',
    [
      'exec',
      `--workdir=${args.workingDirectory}`,
      ...Object.keys(env).flatMap((key) => ['-e', key]),
      ...(prepend ? ['-e', `PATH=${prepend}:${state.path ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'}`] : []),
      state.container,
      args.entryPoint,
      ...(args.entryPointArgs ?? []),
    ],
    { stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, ...env } },
  )
  process.exit(result.status ?? 1)
}

const runContainerStep = (args, state) => {
  ensureDocker()
  let image = args.image
  if (image) pull(image, args.registry)
  else {
    image = `${LABEL}:${process.pid}-${Date.now()}`
    docker(['build', '--network=host', '-t', image, '-f', args.dockerfile, path.dirname(args.dockerfile)])
  }
  const { args: run, env } = runArgs(args, [`--workdir=${args.workingDirectory}`, ...hostArgs(state?.hosts ?? [])])
  const result = spawnSync('docker', ['run', '--rm', ...run, image, ...(args.entryPointArgs ?? []).filter(Boolean)], { stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, ...env } })
  process.exit(result.status ?? 1)
}

let input = ''
process.stdin.on('data', (chunk) => (input += chunk))
process.stdin.on('end', () => {
  try {
    const { command, responseFile, args, state } = JSON.parse(input)
    if (command === 'prepare_job') prepareJob(args, responseFile)
    else if (command === 'cleanup_job') cleanup()
    else if (command === 'run_script_step') runScriptStep(args, state)
    else if (command === 'run_container_step') runContainerStep(args, state)
    else throw new Error(`unknown command ${command}`)
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : error}`)
    process.exit(1)
  }
})
