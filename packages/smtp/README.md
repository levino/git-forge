# @git-forge/smtp

Email adapter for SMTP: implements `EmailSender` from `@git-forge/core` with
`node:net` and `node:tls`, for the Node deployment (`apps/forge-node`). It
runs on Node and Bun, not on Workers (the Worker uses `@git-forge/ses`).

```ts
import { createSmtpEmailSender } from '@git-forge/smtp'

const email = createSmtpEmailSender({
  host: 'smtp.example.org',
  security: 'starttls',
  username: 'forge@example.org',
  password: process.env.SMTP_PASSWORD,
  from: 'Forge <forge@example.org>',
})
await email.send({ to: ['ada@example.org'], subject: 'Hello', text: 'Plain text', html: '<p>HTML</p>' })
```

- `security`: `starttls` (default, port 587; the server must offer
  `STARTTLS`), `tls` (implicit TLS, port 465) or `none` (port 25, for a local
  relay; credentials are refused without TLS). `port` overrides the default.
- `username` and `password` authenticate with `AUTH PLAIN`, or `AUTH LOGIN`
  when the server only offers that.
- `helo` is the `EHLO` name (default: the host name), `timeoutMs` the idle
  timeout per reply (30 s), `tls` extra `node:tls` options (for example `ca`
  for a private CA).
- One connection per message. The message is MIME with base64 parts
  (`multipart/alternative` when there is HTML), RFC 2047 encoded subject and
  display names, `Date` and a `Message-ID` on the sender's domain, which
  `send` returns as `id`. Lines starting with `.` are dot-stuffed.
- Messages are validated before connecting (addresses, single-line subject,
  header names and values).
- `5xx` replies throw `EmailRejectedError` (permanent: do not retry); `4xx`
  replies, timeouts and connection or TLS failures throw `SmtpError` (retry
  with backoff).

`composeMessage`, `encodeWords`, `formatMailbox` and `dotStuff` are exported
for tests and other transports.

The tests run against a fake SMTP server (`test/fake-smtp.ts`) with plain,
STARTTLS and implicit TLS listeners and a self-signed certificate made by
`openssl` at test time.
