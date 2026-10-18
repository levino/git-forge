# @git-forge/ses

Email adapter for Amazon SES: implements `EmailSender` from `@git-forge/core`
with the SES v2 `SendEmail` HTTP API, signed with SigV4 by `aws4fetch`. Only
`fetch` and WebCrypto are used, so it runs on Workers, Node and Bun.

```ts
import { createSesEmailSender } from '@git-forge/ses'

const email = createSesEmailSender({
  region: 'eu-central-1',
  accessKeyId: env.SES_ACCESS_KEY_ID,
  secretAccessKey: env.SES_SECRET_ACCESS_KEY,
  from: 'Forge <forge@example.org>',
})
await email.send({ to: ['ada@example.org'], subject: 'Hello', text: 'Plain text', html: '<p>HTML</p>' })
```

- `endpoint` overrides `https://email.<region>.amazonaws.com` (tests use an
  HTTP mock), `configurationSet` sets `ConfigurationSetName`, `fetch` replaces
  the global `fetch`.
- Messages are validated before anything is sent (addresses, single-line
  subject, header names and values).
- `4xx` answers throw `EmailRejectedError` (permanent: do not retry); `429`,
  `5xx` and throttling errors throw `SesError` (retry with backoff).
- The IAM user needs `ses:SendEmail` on the sending identity; the `from`
  address or its domain must be verified in SES, and an account in the SES
  sandbox can only send to verified addresses.

The Worker reads `EMAIL_PROVIDER=ses`, `EMAIL_FROM`, `SES_REGION`, the
secrets `SES_ACCESS_KEY_ID` and `SES_SECRET_ACCESS_KEY`, and optionally
`SES_ENDPOINT` and `SES_CONFIGURATION_SET` (see `apps/forge-worker/README.md`).

`@git-forge/smtp` implements the same interface over SMTP for the Node
deployment.
