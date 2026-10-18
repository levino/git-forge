import { describe, expect, it } from 'vitest'
import {
  base64UrlDecode,
  COSE_ALGORITHMS,
  coseBytesToJwk,
  creationOptions,
  decodeCbor,
  parseAuthenticatorData,
  type RelyingParty,
  verifyAuthentication,
  verifyRegistration,
  WebAuthnError,
} from '../src/index.ts'

const RP: RelyingParty = { id: 'localhost', name: 'test', origins: ['http://localhost:5000'] }

const REGISTRATION_NONE = {
  challenge: 'TwN7n4WTyGKLc4ZY-qGsFqKnHM4nglqsyV0ICJlN2TO9XiRyFtrkaDwUvsql-gkLJXP6fnF1MlrZ53Mm4R7Cvw',
  credential: {
    id: '9y1xA8Tmg1FEmT-c7_fvWZ_uoTuoih3OvR45_oAK-cwHWhAbXrl2q62iLVTjiyEZ7O7n-CROOY494k7Q3xrs_w',
    rawId: '9y1xA8Tmg1FEmT-c7_fvWZ_uoTuoih3OvR45_oAK-cwHWhAbXrl2q62iLVTjiyEZ7O7n-CROOY494k7Q3xrs_w',
    response: {
      attestationObject:
        'o2NmbXRkbm9uZWdhdHRTdG10oGhhdXRoRGF0YVjESZYN5YgOjGh0NBcPZHZgW4_krrmihjLHmVzzuoMdl2NFAAAAFwAAAAAAAAAAAAAAAAAAAAAAQPctcQPE5oNRRJk_nO_371mf7qE7qIodzr0eOf6ACvnMB1oQG165dqutoi1U44shGezu5_gkTjmOPeJO0N8a7P-lAQIDJiABIVggSFbUJF-42Ug3pdM8rDRFu_N5oiVEysPDB6n66r_7dZAiWCDUVnB39FlGypL-qAoIO9xWHtJygo2jfDmHl-_eKFRLDA',
      clientDataJSON:
        'eyJ0eXBlIjoid2ViYXV0aG4uY3JlYXRlIiwiY2hhbGxlbmdlIjoiVHdON240V1R5R0tMYzRaWS1xR3NGcUtuSE00bmdscXN5VjBJQ0psTjJUTzlYaVJ5RnRya2FEd1V2c3FsLWdrTEpYUDZmbkYxTWxyWjUzTW00UjdDdnciLCJvcmlnaW4iOiJodHRwOi8vbG9jYWxob3N0OjUwMDAiLCJjcm9zc09yaWdpbiI6ZmFsc2V9',
      transports: ['nfc', 'usb'],
    },
    type: 'public-key',
  },
  publicKey: 'pQECAyYgASFYIEhW1CRfuNlIN6XTPKw0RbvzeaIlRMrDwwep-uq_-3WQIlgg1FZwd_RZRsqS_qgKCDvcVh7ScoKNo3w5h5fv3ihUSww',
}

const ASSERTION_ES256 = {
  challenge: 'xi30GPGAFYRxVDpY1sM10DaLzVQG66nv-_7RUazH0vI2YvG8LYgDEnvN5fZZNVuvEDuMi9te3VLqb42N0fkLGA',
  publicKey: 'pQECAyYgASFYIIeDTe-gN8A-zQclHoRnGFWN8ehM1b7yAsa8I8KIvmplIlgg4nFGT5px8o6gpPZZhO01wdy9crDSA_Ngtkx0vGpvPHI',
  signCount: 77,
  credential: {
    id: 'EDx9FfAbp4obx6oll2oC4-CZuDidRVV4gZhxC529ytlnqHyqCStDUwfNdm1SNHAe3X5KvueWQdAX3x9R1a2b9Q',
    rawId: 'EDx9FfAbp4obx6oll2oC4-CZuDidRVV4gZhxC529ytlnqHyqCStDUwfNdm1SNHAe3X5KvueWQdAX3x9R1a2b9Q',
    response: {
      authenticatorData: 'SZYN5YgOjGh0NBcPZHZgW4_krrmihjLHmVzzuoMdl2MBAAAATg',
      clientDataJSON:
        'eyJjaGFsbGVuZ2UiOiJ4aTMwR1BHQUZZUnhWRHBZMXNNMTBEYUx6VlFHNjZudi1fN1JVYXpIMHZJMll2RzhMWWdERW52TjVmWlpOVnV2RUR1TWk5dGUzVkxxYjQyTjBma0xHQSIsImNsaWVudEV4dGVuc2lvbnMiOnt9LCJoYXNoQWxnb3JpdGhtIjoiU0hBLTI1NiIsIm9yaWdpbiI6Imh0dHA6Ly9sb2NhbGhvc3Q6NTAwMCIsInR5cGUiOiJ3ZWJhdXRobi5nZXQifQ',
      signature: 'MEUCIGisVZOBapCWbnJJvjelIzwpixxIwkjCCb5aCHafQu68AiEA88v-2pJNNApPFwAKFiNuf82-2hBxYW5kGwVweeoxCwo',
    },
    type: 'public-key',
  },
}

const ASSERTION_RS256 = {
  challenge: 'iPmAi1Pp1XL6oAgq3PWZtZPnZa1zFUDoGbaQ0_KvVG1lF2s3Rt_3o4uSzccy0tmcTIpTTT4BU1T-I4maavndjQ',
  publicKey:
    'pAEDAzkBACBZAQDfV20epzvQP-HtcdDpX-cGzdOxy73WQEvsU7Dnr9UWJophEfpngouvgnRLXaEUn_d8HGkp_HIx8rrpkx4BVs6X_B6ZjhLlezjIdJbLbVeb92BaEsmNn1HW2N9Xj2QM8cH-yx28_vCjf82ahQ9gyAr552Bn96G22n8jqFRQKdVpO-f-bvpvaP3IQ9F5LCX7CUaxptgbog1SFO6FI6ob5SlVVB00lVXsaYg8cIDZxCkkENkGiFPgwEaZ7995SCbiyCpUJbMqToLMgojPkAhWeyktu7TlK6UBWdJMHc3FPAIs0lH_2_2hKS-mGI1uZAFVAfW1X-mzKL0czUm2P1UlUox7IUMBAAE',
  signCount: 0,
  credential: {
    id: 'ZoIKP1JQvKdrYj1bTUPJ2eTUsbLeFkv-X5xJQNr4k6s',
    rawId: 'ZoIKP1JQvKdrYj1bTUPJ2eTUsbLeFkv-X5xJQNr4k6s',
    response: {
      authenticatorData: 'SZYN5YgOjGh0NBcPZHZgW4_krrmihjLHmVzzuoMdl2MFAAAAAQ',
      clientDataJSON:
        'eyJ0eXBlIjoid2ViYXV0aG4uZ2V0IiwiY2hhbGxlbmdlIjoiaVBtQWkxUHAxWEw2b0FncTNQV1p0WlBuWmExekZVRG9HYmFRMF9LdlZHMWxGMnMzUnRfM280dVN6Y2N5MHRtY1RJcFRUVDRCVTFULUk0bWFhdm5kalEiLCJvcmlnaW4iOiJodHRwOi8vbG9jYWxob3N0OjUwMDAiLCJjcm9zc09yaWdpbiI6ZmFsc2V9',
      signature:
        'iOHKX3erU5_OYP_r_9HLZ-CexCE4bQRrxM8WmuoKTDdhAnZSeTP0sjECjvjfeS8MJzN1ArmvV0H0C3yy_FdRFfcpUPZzdZ7bBcmPh1XPdxRwY747OrIzcTLTFQUPdn1U-izCZtP_78VGw9pCpdMsv4CUzZdJbEcRtQuRS03qUjqDaovoJhOqEBmxJn9Wu8tBi_Qx7A33RbYjlfyLm_EDqimzDZhyietyop6XUcpKarKqVH0M6mMrM5zTjp8xf3W7odFCadXEJg-ERZqFM0-9Uup6kJNLbr6C5J4NDYmSm3HCSA6lp2iEiMPKU8Ii7QZ61kybXLxsX4w4Dm3fOLjmDw',
      userHandle: 'T1RWa1l6VXdPRFV0WW1NNVlTMDBOVEkxTFRnd056Z3RabVZpWVdZNFpEVm1ZMk5p',
    },
    type: 'public-key',
  },
}

const ASSERTION_EDDSA = {
  challenge: 'eZ4eeA3O4jy5FIzqDaSJ6JDNGu0bBc5zI1DjQ_kLso1WNqkG6k5mCYf1dtQhVUiBWZWlZkzR5MFeeWCpJRUNXw',
  publicKey: 'pAEBAycgBiFYIMz6_SUFLiDid2Yhlq0YboyJ-CDrIrNpkPUGmJp4D3Dp',
  signCount: 3,
  credential: {
    id: 'fq9Nj0nS24B5y6Pkw_h3-9GEAEA3-0LBPxE2zvTdLjDqtSeCSNYFe9VMRueSpAZxT3YDc6L1lWXdQNwI-sVNYrefEcRR1Nsb_0jpHE955WEtFud2xxZg3MvoLMxHLet63i5tajd1fHtP7I-00D6cehM8ZWlLp2T3s9lfZgVIFcA',
    rawId: 'fq9Nj0nS24B5y6Pkw_h3-9GEAEA3-0LBPxE2zvTdLjDqtSeCSNYFe9VMRueSpAZxT3YDc6L1lWXdQNwI-sVNYrefEcRR1Nsb_0jpHE955WEtFud2xxZg3MvoLMxHLet63i5tajd1fHtP7I-00D6cehM8ZWlLp2T3s9lfZgVIFcA',
    response: {
      authenticatorData: 'SZYN5YgOjGh0NBcPZHZgW4_krrmihjLHmVzzuoMdl2MBAAAABw',
      clientDataJSON:
        'eyJ0eXBlIjoid2ViYXV0aG4uZ2V0IiwiY2hhbGxlbmdlIjoiZVo0ZWVBM080ank1Rkl6cURhU0o2SkROR3UwYkJjNXpJMURqUV9rTHNvMVdOcWtHNms1bUNZZjFkdFFoVlVpQldaV2xaa3pSNU1GZWVXQ3BKUlVOWHciLCJvcmlnaW4iOiJodHRwOi8vbG9jYWxob3N0OjUwMDAiLCJjcm9zc09yaWdpbiI6ZmFsc2V9',
      signature: 'RRWV8mYDRvK7YdQgdtZD4pJ2dh1D_IWZ_D6jsZo6FHJBoenbj0CVT5nA20vUzlRhN4R6dOEUHmUwP1F8eRBhBg',
    },
    type: 'public-key',
  },
}

const ASSERTION_WRONG_KEY = {
  challenge: 'zsfiMZj16TUVCrT5tDRYXdYlUrJp7zn_UNd5NmBocPc4I2dKZbeEWpwBAwA4s6oHkVX6_ly_jgp743dyiWHYYw',
  credential: {
    id: 'FviUBZA3FGMxEm3A1K2T8MhuEBLp4qQsV9ScAKYrpdw2kbGnqx24tF4ev6PEHEYC3g8z6HMJh7dYHe3Uuq7_8Q',
    response: {
      authenticatorData: 'SZYN5YgOjGh0NBcPZHZgW4_krrmihjLHmVzzuoMdl2MFAAAAJA',
      clientDataJSON:
        'eyJ0eXBlIjoid2ViYXV0aG4uZ2V0IiwiY2hhbGxlbmdlIjoienNmaU1aajE2VFVWQ3JUNXREUllYZFlsVXJKcDd6bl9VTmQ1Tm1Cb2NQYzRJMmRLWmJlRVdwd0JBd0E0czZvSGtWWDZfbHlfamdwNzQzZHlpV0hZWXciLCJvcmlnaW4iOiJodHRwOi8vbG9jYWxob3N0OjUwMDAiLCJjcm9zc09yaWdpbiI6ZmFsc2V9',
      signature: 'MEQCIBX9B1LaLaQ0LYJsRv7cOyMS-Do1rJfFJoF9oO1tHMA4AiBRKdNneMKPlN53i8uoTZ5y9Gj4ORZySmiercS38655_g',
    },
  },
}

const withResponse = <T extends { credential: { response: object } }>(vector: T, patch: Record<string, unknown>) => ({
  ...vector.credential,
  response: { ...vector.credential.response, ...patch },
})

describe('CBOR and authenticator data', () => {
  it('decodes the attestation object of the none vector', () => {
    const value = decodeCbor(base64UrlDecode(REGISTRATION_NONE.credential.response.attestationObject)) as Map<string, unknown>
    expect(value.get('fmt')).toBe('none')
    const authData = parseAuthenticatorData(value.get('authData') as Uint8Array)
    expect(authData.userPresent && authData.userVerified).toBe(true)
    expect(authData.signCount).toBe(23)
    expect(authData.attestedCredential?.aaguid).toBe('00000000-0000-0000-0000-000000000000')
  })

  it('rejects truncated and trailing data', () => {
    const bytes = base64UrlDecode(REGISTRATION_NONE.credential.response.attestationObject)
    expect(() => decodeCbor(bytes.subarray(0, bytes.length - 5))).toThrow()
    expect(() => decodeCbor(Uint8Array.from([...bytes, 0]))).toThrow()
    expect(() => parseAuthenticatorData(new Uint8Array(36))).toThrow(WebAuthnError)
  })

  it('maps COSE keys of all three algorithms to JWKs', () => {
    expect(coseBytesToJwk(base64UrlDecode(ASSERTION_ES256.publicKey))).toMatchObject({ algorithm: COSE_ALGORITHMS.ES256, jwk: { kty: 'EC', crv: 'P-256' } })
    expect(coseBytesToJwk(base64UrlDecode(ASSERTION_RS256.publicKey))).toMatchObject({ algorithm: COSE_ALGORITHMS.RS256, jwk: { kty: 'RSA', e: 'AQAB' } })
    expect(coseBytesToJwk(base64UrlDecode(ASSERTION_EDDSA.publicKey))).toMatchObject({ algorithm: COSE_ALGORITHMS.EdDSA, jwk: { kty: 'OKP', crv: 'Ed25519' } })
  })
})

describe('registration ceremony', () => {
  it('verifies a none attestation with user verification', async () => {
    const verified = await verifyRegistration({ credential: REGISTRATION_NONE.credential, challenge: REGISTRATION_NONE.challenge, rp: RP })
    expect(verified).toMatchObject({ credentialId: REGISTRATION_NONE.credential.id, signCount: 23, format: 'none', userVerified: true, transports: ['nfc', 'usb'] })
    expect(verified.publicKey).toEqual(coseBytesToJwk(base64UrlDecode(REGISTRATION_NONE.publicKey)))
  })

  it('rejects another challenge, origin, relying party or ceremony type', async () => {
    const input = { credential: REGISTRATION_NONE.credential, challenge: REGISTRATION_NONE.challenge, rp: RP }
    await expect(verifyRegistration({ ...input, challenge: 'x' })).rejects.toThrow(/challenge/)
    await expect(verifyRegistration({ ...input, rp: { ...RP, origins: ['https://evil.example'] } })).rejects.toThrow(/origin/)
    await expect(verifyRegistration({ ...input, rp: { ...RP, id: 'example.com' } })).rejects.toThrow(/relying party/)
    await expect(verifyRegistration({ ...input, credential: { ...ASSERTION_ES256.credential } })).rejects.toThrow(WebAuthnError)
    await expect(verifyRegistration({ ...input, credential: { ...REGISTRATION_NONE.credential, rawId: ASSERTION_ES256.credential.id } })).rejects.toThrow(/rawId/)
  })

  it('builds creation options that demand user verification and attestation none', () => {
    const options = creationOptions({ rp: RP, user: { handle: new Uint8Array(32), name: 'alice', displayName: 'Alice' }, challenge: new Uint8Array(32), excludeCredentials: ['abc'] })
    expect(options).toMatchObject({
      attestation: 'none',
      authenticatorSelection: { userVerification: 'required', residentKey: 'required' },
      pubKeyCredParams: [{ alg: -7 }, { alg: -8 }, { alg: -257 }],
      excludeCredentials: [{ type: 'public-key', id: 'abc' }],
    })
  })
})

describe('authentication ceremony', () => {
  const run = (vector: typeof ASSERTION_ES256 | typeof ASSERTION_RS256 | typeof ASSERTION_EDDSA, overrides: Record<string, unknown> = {}) =>
    verifyAuthentication({
      credential: vector.credential,
      challenge: vector.challenge,
      rp: RP,
      publicKey: coseBytesToJwk(base64UrlDecode(vector.publicKey)),
      storedSignCount: vector.signCount,
      ...overrides,
    })

  it('verifies an RS256 assertion with user verification', async () => {
    expect(await run(ASSERTION_RS256)).toMatchObject({ signCount: 1, userVerified: true })
  })

  it('verifies ES256 (DER signature) and EdDSA assertions and requires user verification by default', async () => {
    expect(await run(ASSERTION_ES256, { requireUserVerification: false })).toMatchObject({ signCount: 78, userVerified: false })
    expect(await run(ASSERTION_EDDSA, { requireUserVerification: false })).toMatchObject({ signCount: 7 })
    await expect(run(ASSERTION_ES256)).rejects.toThrow(/user verification/)
    await expect(run(ASSERTION_EDDSA)).rejects.toThrow(/user verification/)
  })

  it('rejects a wrong public key, a replayed counter and tampered data', async () => {
    await expect(
      verifyAuthentication({ credential: ASSERTION_WRONG_KEY.credential, challenge: ASSERTION_WRONG_KEY.challenge, rp: RP, publicKey: coseBytesToJwk(base64UrlDecode(ASSERTION_RS256.publicKey)), storedSignCount: 35 }),
    ).rejects.toThrow(/signature/)
    await expect(run(ASSERTION_RS256, { storedSignCount: 1 })).rejects.toThrow(/counter/)
    await expect(run(ASSERTION_ES256, { requireUserVerification: false, storedSignCount: 78 })).rejects.toThrow(/counter/)
    const tampered = withResponse(ASSERTION_RS256, { authenticatorData: 'SZYN5YgOjGh0NBcPZHZgW4_krrmihjLHmVzzuoMdl2MFAAAAAg' })
    await expect(run(ASSERTION_RS256, { credential: tampered })).rejects.toThrow(/signature/)
    await expect(run(ASSERTION_RS256, { challenge: ASSERTION_ES256.challenge })).rejects.toThrow(/challenge/)
  })
})
