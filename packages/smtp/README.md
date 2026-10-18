# @git-forge/smtp

`EmailSender` over SMTP (`node:net`, `node:tls`) for `apps/forge-node`.

```ts
const email = createSmtpEmailSender({ host: 'smtp.example.org', username, password, from: 'Forge <forge@example.org>' })
```

- `security`: `starttls` (default, 587), `tls` (465) or `none` (25, no
  credentials); `port`, `helo`, `timeoutMs` and `tls` (e.g. `ca`) are optional.
- `AUTH PLAIN`, else `AUTH LOGIN`. One connection per message.
- `5xx` throws `EmailRejectedError`, `4xx` and network or TLS errors
  `SmtpError`.
