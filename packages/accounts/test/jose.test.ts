import { describe, expect, it } from 'vitest'
import { derToRawEcdsa, parseVerificationJwk, type VerificationJwk, verifyCompactJws } from '../src/index.ts'

const RFC7515_RS256 = {
  token:
    'eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJqb2UiLA0KICJleHAiOjEzMDA4MTkzODAsDQogImh0dHA6Ly9leGFtcGxlLmNvbS9pc19yb290Ijp0cnVlfQ.' +
    'cC4hiUPoj9Eetdgtv3hF80EGrhuB__dzERat0XF9g2VtQgr9PJbu3XOiZj5RZmh7AAuHIm4Bh-0Qc_lF5YKt_O8W2Fp5jujGbds9uJdbF9CUAr7t1dnZcAcQjbKBYNX4' +
    'BAynRFdiuB--f_nZLgrnbyTyWzO75vRK5h6xBArLIARNPvkSjtQBMHlb1L07Qe7K0GarZRmB_eSN9383LcOLn6_dO--xi12jzDwusC-eOkHWEsqtFZESc6BfI7noOPqv' +
    'hJ1phCnvWh6IeYI2w9QOYEUipUTI8np6LbgGY9Fs98rqVt5AXLIhWkWywlVmtVrBp0igcN_IoypGlUPQGe77Rw',
  jwk: {
    kty: 'RSA',
    n:
      'ofgWCuLjybRlzo0tZWJjNiuSfb4p4fAkd_wWJcyQoTbji9k0l8W26mPddxHmfHQp-Vaw-4qPCJrcS2mJPMEzP1Pt0Bm4d4QlL-yRT-SFd2lZS-pCgNMs' +
      'D1W_YpRPEwOWvG6b32690r2jZ47soMZo9wGzjb_7OMg0LOL-bSf63kpaSHSXndS5z5rexMdbBYUsLA9e-KXBdQOS-UTo7WTBEMa2R2CapHg665xsmtdV' +
      'MTBQY4uDZlxvb3qCo5ZwKh9kG4LT6_I5IhlJH7aGhyxXFvUK-DWNmoudF8NAco9_h9iaGNj8q2ethFkMLs91kzk2PAcDTW9gb54h4FRWyuXpoQ',
    e: 'AQAB',
  },
}

const RFC7515_ES256 = {
  token:
    'eyJhbGciOiJFUzI1NiJ9.eyJpc3MiOiJqb2UiLA0KICJleHAiOjEzMDA4MTkzODAsDQogImh0dHA6Ly9leGFtcGxlLmNvbS9pc19yb290Ijp0cnVlfQ.' +
    'DtEhU3ljbEg8L38VWAfUAqOyKAM6-Xx-F4GawxaepmXFCgfTjDxw5djxLa8ISlSApmWQxfKTUJqPP3-Kg6NU1Q',
  jwk: { kty: 'EC', crv: 'P-256', x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU', y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0' },
}

const RFC8037_EDDSA = {
  token: 'eyJhbGciOiJFZERTQSJ9.RXhhbXBsZSBvZiBFZDI1NTE5IHNpZ25pbmc.hgyY0il_MGCjP0JzlnLWG1PPOt7-09PGcvMg3AIbQR6dWbhijcNR4ki4iylGjg5BhVsPt9g7sVvpAr_MuM0KAg',
  jwk: { kty: 'OKP', crv: 'Ed25519', x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo' },
}

const key = (value: unknown): VerificationJwk => parseVerificationJwk(value)!

const tamper = (token: string): string => {
  const [header, payload, signature] = token.split('.') as [string, string, string]
  return `${header}.${payload.slice(0, -2)}${payload.endsWith('A') ? 'B' : 'A'}${payload.slice(-1)}.${signature}`
}

describe('JWS verification with RFC test vectors', () => {
  for (const [name, vector] of [
    ['RS256 (RFC 7515 A.2)', RFC7515_RS256],
    ['ES256 (RFC 7515 A.3)', RFC7515_ES256],
    ['EdDSA (RFC 8037 A.4)', RFC8037_EDDSA],
  ] as const) {
    it(`verifies ${name} and rejects tampering`, async () => {
      const verified = await verifyCompactJws(vector.token, [key(vector.jwk)])
      expect(verified).not.toBeNull()
      expect(await verifyCompactJws(tamper(vector.token), [key(vector.jwk)])).toBeNull()
    })
  }

  it('decodes the RFC 8037 payload', async () => {
    const verified = await verifyCompactJws(RFC8037_EDDSA.token, [key(RFC8037_EDDSA.jwk)])
    expect(new TextDecoder().decode(verified!.payload)).toBe('Example of Ed25519 signing')
  })

  it('never verifies with a key of another algorithm or a mismatching kid', async () => {
    expect(await verifyCompactJws(RFC7515_RS256.token, [key(RFC7515_ES256.jwk), key(RFC8037_EDDSA.jwk)])).toBeNull()
    expect(await verifyCompactJws(RFC7515_ES256.token, [key({ ...RFC7515_ES256.jwk, alg: 'RS256' })])).toBeNull()
    const [, payload, signature] = RFC7515_ES256.token.split('.')
    const withKid = `${btoa(JSON.stringify({ alg: 'ES256', kid: 'a' })).replace(/=+$/, '')}.${payload}.${signature}`
    expect(await verifyCompactJws(withKid, [key({ ...RFC7515_ES256.jwk, kid: 'b' })])).toBeNull()
  })

  it('rejects alg none, HS256 and private keys', async () => {
    const [, payload] = RFC7515_ES256.token.split('.')
    for (const alg of ['none', 'HS256']) {
      const header = btoa(JSON.stringify({ alg })).replace(/=+$/, '')
      expect(await verifyCompactJws(`${header}.${payload}.AAAA`, [key(RFC7515_ES256.jwk)])).toBeNull()
    }
    expect(parseVerificationJwk({ ...RFC8037_EDDSA.jwk, d: 'nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A' })).toBeNull()
  })

  it('converts DER ECDSA signatures to the raw form', () => {
    const der = Uint8Array.from([0x30, 0x08, 0x02, 0x02, 0x00, 0x80, 0x02, 0x02, 0x01, 0x02])
    const raw = derToRawEcdsa(der)
    expect(raw.length).toBe(64)
    expect(raw[31]).toBe(0x80)
    expect([raw[62], raw[63]]).toEqual([0x01, 0x02])
    expect(() => derToRawEcdsa(Uint8Array.from([0x30, 0x01, 0x00]))).toThrow()
  })
})
