import { readFileSync } from 'node:fs'
import { generateSigningKey, MAX_BREAK_GLASS_TOKEN_SECONDS, type PrivateJwk, signBreakGlassToken } from '@git-forge/accounts'

const USAGE = `usage: break-glass keygen > break-glass.private.jwk
       break-glass sign --key break-glass.private.jwk --url https://forge.example --login <admin> [--ttl <seconds>]`

const option = (args: readonly string[], name: string): string | undefined => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

const [command, ...args] = process.argv.slice(2)

if (command === 'keygen') {
  const { privateJwk } = await generateSigningKey()
  console.log(JSON.stringify(privateJwk))
  console.error(`BREAK_GLASS_PUBLIC_KEY=${JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: privateJwk.x })}`)
} else if (command === 'sign') {
  const keyFile = option(args, '--key')
  const url = option(args, '--url')
  const login = option(args, '--login')
  const ttl = Number(option(args, '--ttl') ?? 300)
  if (!keyFile || !url || !login || !Number.isInteger(ttl) || ttl <= 0 || ttl > MAX_BREAK_GLASS_TOKEN_SECONDS) {
    console.error(USAGE)
    process.exit(1)
  }
  const privateJwk = JSON.parse(readFileSync(keyFile, 'utf8')) as PrivateJwk
  console.log(await signBreakGlassToken({ privateJwk, audience: url, login, ttlSeconds: ttl }))
} else {
  console.error(USAGE)
  process.exit(1)
}
