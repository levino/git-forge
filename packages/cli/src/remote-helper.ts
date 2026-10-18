import { spawn } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { uploadPush } from './forge-upload.ts'
import { configValue, runGit } from './git.ts'
import { applyOption, capabilitiesResponse, defaultOptions, parsePushLine, parseRefList, pushResponse, remoteHttpUrl, splitCredentials } from './helper-protocol.ts'
import { LineReader } from './line-reader.ts'
import { parseSize } from './size.ts'

export type HelperIO = {
  readonly stdin: Readable
  readonly stdout: Writable
  readonly stderr: Writable
}

const writeTo = (stream: Writable, text: string | Buffer): Promise<void> =>
  new Promise((resolve, reject) => stream.write(text, (error) => (error ? reject(error) : resolve())))

const block = (lines: readonly string[]): string => `${lines.map((line) => `${line}\n`).join('')}\n`

const gitDirectory = async (): Promise<string> => {
  if (process.env.GIT_DIR) return process.env.GIT_DIR
  const { stdout } = await runGit(['rev-parse', '--absolute-git-dir'])
  return stdout.trim()
}

const configuredPartBytes = async (): Promise<number | undefined> => {
  const text = process.env.GIT_FORGE_UPLOAD_PART_BYTES ?? (await runGit(['config', '--get', 'forge.uploadPartBytes'], { allowFailure: true })).stdout.trim()
  return text ? parseSize(text) : undefined
}

const configureLfs = async (remote: string, httpUrl: string): Promise<void> => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(remote)) return
  const url = await configValue(`remote.${remote}.url`)
  if (!url || !(url.startsWith('forge::') || url.startsWith('forge://'))) return
  if ((await configValue(`remote.${remote}.lfsurl`)) || (await configValue('lfs.url'))) return
  await runGit(['config', `remote.${remote}.lfsurl`, `${splitCredentials(httpUrl).url}/info/lfs`], { allowFailure: true })
}

export const runRemoteHelper = async (args: readonly string[], io: HelperIO = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }): Promise<number> => {
  const [remote, address] = args
  if (!remote) throw new Error('usage: git-remote-forge <remote> [<url>]')
  const httpUrl = remoteHttpUrl(address ?? remote)
  await configureLfs(remote, httpUrl)
  const child = spawn('git', [httpUrl.startsWith('https:') ? 'remote-https' : 'remote-http', remote, httpUrl], { stdio: ['pipe', 'pipe', 'inherit'] })
  const exited = new Promise<number | null>((resolve) => child.on('close', resolve))
  child.stdin.on('error', () => undefined)
  const fromChild = new LineReader(child.stdout)
  const input = new LineReader(io.stdin)
  const options = defaultOptions()
  let remoteRefs = new Map<string, string>()
  const toChild = (text: string | Buffer) => writeTo(child.stdin, text)
  const childBlock = () => fromChild.readBlock()
  const log = (line: string) => {
    if (options.progress || options.verbosity > 1) io.stderr.write(`${line}\n`)
  }
  try {
    for (;;) {
      const line = await input.readLine()
      if (line === null || line === '') break
      if (line === 'capabilities') {
        await writeTo(io.stdout, capabilitiesResponse())
      } else if (line.startsWith('option ')) {
        applyOption(options, line)
        await toChild(`${line}\n`)
        await writeTo(io.stdout, `${(await fromChild.readLine()) ?? 'unsupported'}\n`)
      } else if (line === 'list' || line.startsWith('list ')) {
        await toChild(`${line}\n`)
        const lines = await childBlock()
        remoteRefs = parseRefList(lines.join('\n'))
        await writeTo(io.stdout, block(lines))
      } else if (line.startsWith('stateless-connect ')) {
        await toChild(`${line}\n`)
        const answer = await fromChild.readLine()
        await writeTo(io.stdout, `${answer ?? 'fallback'}\n`)
        if (answer !== '') continue
        const upstream = (async () => {
          for await (const chunk of input.rest()) await toChild(chunk)
          child.stdin.end()
        })()
        for await (const chunk of fromChild.rest()) await writeTo(io.stdout, chunk)
        await upstream
        return (await exited) ?? 1
      } else if (line.startsWith('fetch ')) {
        const batch = [line, ...(await input.readBlock())]
        await toChild(block(batch))
        await writeTo(io.stdout, block(await childBlock()))
      } else if (line.startsWith('push ')) {
        const batch = [line, ...(await input.readBlock())]
        const specs = batch.map(parsePushLine)
        let response: string
        try {
          const partBytes = await configuredPartBytes()
          const results = await uploadPush(httpUrl, specs, remoteRefs, options, {
            fetch: (url, init) => fetch(url, init),
            log,
            sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
            gitDir: await gitDirectory(),
            ...(partBytes !== undefined ? { partBytes } : {}),
          })
          if (results === null) {
            await toChild(block(batch))
            response = block(await childBlock())
          } else response = pushResponse(results)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          io.stderr.write(`git-remote-forge: ${message}\n`)
          response = pushResponse(specs.map((spec) => [spec.dst, { ok: false, reason: message }]))
        }
        await writeTo(io.stdout, response)
      } else {
        io.stderr.write(`git-remote-forge: unknown command ${line}\n`)
        return 1
      }
    }
    child.stdin.end()
    await exited
    return 0
  } finally {
    if (child.exitCode === null) child.stdin.end()
  }
}
