import { generateSigningKey } from '@git-forge/accounts'

const { key, privateJwk } = await generateSigningKey()
console.error(`key id (JWK thumbprint, usable as pinnedThumbprint): ${key.kid}`)
console.log(JSON.stringify(privateJwk))
