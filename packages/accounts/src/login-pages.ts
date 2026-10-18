import { accessChoices, ACCESS_CHOICES, type TokenScope } from './tokens.ts'

export type ConsentUser = { readonly login: string; readonly csrf: string }

export type DeviceDetails = {
  readonly userCode: string
  readonly clientName: string
  readonly clientHost: string | null
  readonly requestIp: string | null
  readonly requestedAt: number
  readonly scope: TokenScope
}

export type CliConsent = {
  readonly id: string
  readonly clientName: string
  readonly clientHost: string | null
  readonly requestIp: string | null
  readonly requestedAt: number
  readonly redirect: 'loopback' | 'oob'
  readonly redirectUri: string
  readonly scope: TokenScope
}

export type LoginPage =
  | {
      readonly kind: 'login'
      readonly returnTo: string
      readonly oidcName: string | null
      readonly selfSignup: boolean
      readonly breakGlass: boolean
      readonly user: { readonly login: string; readonly csrf: string } | null
      readonly message?: string
    }
  | {
      readonly kind: 'invite'
      readonly code: string
      readonly login: string | null
      readonly existingUser: boolean
      readonly oidcName: string | null
    }
  | {
      readonly kind: 'device'
      readonly userCode: string | null
      readonly device: DeviceDetails | null
      readonly user: ConsentUser
      readonly instance: string
      readonly viewerIp: string | null
      readonly message?: string
    }
  | { readonly kind: 'device-result'; readonly approved: boolean }
  | { readonly kind: 'cli'; readonly request: CliConsent; readonly user: ConsentUser; readonly instance: string }
  | { readonly kind: 'cli-code'; readonly code: string; readonly expiresAt: number }
  | { readonly kind: 'break-glass'; readonly message?: string }
  | { readonly kind: 'error'; readonly status: number; readonly message: string }

export type LoginPageRenderer = (page: LoginPage, request: Request) => Response | null | Promise<Response | null>

export const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)

export const CONSENT_WARNING =
  'Only approve a request you started yourself just now. Whoever sent you a link to this page gets this access to your account if you approve it.'

export const accessLabel = (scope: TokenScope): string => ACCESS_CHOICES.find((choice) => choice.scope === scope)?.label ?? scope

export const LOOPBACK_FORM_ACTION = 'http://127.0.0.1:* http://localhost:*'

export const loginFormAction = (page: LoginPage): string => (page.kind === 'cli' && page.request.redirect === 'loopback' ? `'self' ${LOOPBACK_FORM_ACTION}` : "'self'")

export const formatRequestTime = (ms: number): string => `${new Date(ms).toISOString().slice(0, 19).replace('T', ' ')} UTC`

const accessRadios = (max: TokenScope): string =>
  `<fieldset><legend>Access</legend>${accessChoices(max)
    .map((choice) => `<label><input type="radio" name="scope" value="${choice.scope}"${choice.scope === max ? ' checked' : ''}> ${escapeHtml(choice.label)}</label>`)
    .join('<br>')}</fieldset>`

export const COPY_SCRIPT = `
for (const button of document.querySelectorAll('[data-copy]')) {
  button.addEventListener('click', async () => {
    const field = document.getElementById(button.dataset.copy);
    field.select();
    try { await navigator.clipboard.writeText(field.value); } catch { document.execCommand('copy'); }
    button.textContent = 'Copied';
  });
}
`

const scriptJson = (value: unknown): string => JSON.stringify(value).replace(/</g, '\\u003c')

export const PASSKEY_SCRIPT = `
const config = JSON.parse(document.getElementById('login-config').textContent);
const enc = (buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
const dec = (text) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4)), (c) => c.charCodeAt(0));
const show = (text) => { document.getElementById('message').textContent = text; };
const post = async (path, body) => {
  const headers = { 'Content-Type': 'application/json' };
  if (config.csrf) headers['X-CSRF-Token'] = config.csrf;
  const response = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body), credentials: 'same-origin' });
  const json = await response.json();
  if (!response.ok) throw new Error(json.error || String(response.status));
  return json;
};
const descriptors = (list) => (list || []).map((item) => ({ ...item, id: dec(item.id) }));
const passkeyLogin = async () => {
  const { handle, publicKey } = await post('/login/passkey/options', {});
  const credential = await navigator.credentials.get({ publicKey: { ...publicKey, challenge: dec(publicKey.challenge), allowCredentials: descriptors(publicKey.allowCredentials) } });
  const r = credential.response;
  await post('/login/passkey', { handle, credential: { id: credential.id, rawId: enc(credential.rawId), type: credential.type, response: {
    clientDataJSON: enc(r.clientDataJSON), authenticatorData: enc(r.authenticatorData), signature: enc(r.signature), userHandle: r.userHandle ? enc(r.userHandle) : null } } });
  location.href = config.returnTo;
};
const passkeyRegister = async (body) => {
  const { handle, publicKey } = await post('/login/passkey/register/options', body);
  const credential = await navigator.credentials.create({ publicKey: { ...publicKey, challenge: dec(publicKey.challenge), user: { ...publicKey.user, id: dec(publicKey.user.id) }, excludeCredentials: descriptors(publicKey.excludeCredentials) } });
  const r = credential.response;
  await post('/login/passkey/register', { handle, name: navigator.platform || 'passkey', credential: { id: credential.id, rawId: enc(credential.rawId), type: credential.type, response: {
    clientDataJSON: enc(r.clientDataJSON), attestationObject: enc(r.attestationObject), transports: r.getTransports ? r.getTransports() : [] } } });
  location.href = config.returnTo;
};
for (const button of document.querySelectorAll('[data-passkey]')) {
  button.addEventListener('click', (event) => {
    event.preventDefault();
    const kind = button.dataset.passkey;
    const login = document.getElementById('login');
    const run = kind === 'login' ? passkeyLogin() : passkeyRegister({ ...(config.invite ? { invite: config.invite } : {}), ...(login && login.value ? { login: login.value } : {}) });
    run.catch((error) => show(error.message));
  });
}
`

const layout = (title: string, body: string, config: Record<string, unknown> | null = null): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem;line-height:1.5}form,p{margin:1rem 0}button,input{font:inherit;padding:.4rem .8rem}code{font-size:1.4rem;letter-spacing:.1em}#message{color:#b00}</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${body}
<p id="message" role="alert"></p>
${config ? `<script type="application/json" id="login-config">${scriptJson(config)}</script>\n<script>${PASSKEY_SCRIPT}</script>` : ''}
</body>
</html>
`

const csrfField = (csrf: string) => `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`

const renderBody = (page: LoginPage): { title: string; body: string; config: Record<string, unknown> | null } => {
  switch (page.kind) {
    case 'login': {
      if (page.user) {
        return {
          title: 'Signed in',
          body: `<p>Signed in as <strong>${escapeHtml(page.user.login)}</strong>.</p>
<p><button data-passkey="register">Add a passkey</button></p>
<form method="post" action="/logout">${csrfField(page.user.csrf)}<button>Sign out</button></form>`,
          config: { returnTo: page.returnTo, csrf: page.user.csrf },
        }
      }
      const oidc = page.oidcName
        ? `<p><a href="/login/oidc?return_to=${encodeURIComponent(page.returnTo)}"><button type="button">Sign in with ${escapeHtml(page.oidcName)}</button></a></p>`
        : ''
      const signup = page.selfSignup
        ? `<form><label>New account: <input id="login" name="login" autocomplete="username" required></label> <button data-passkey="register">Create with a passkey</button></form>`
        : ''
      const breakGlass = page.breakGlass ? '<p><small><a href="/login/break-glass">Break-glass login</a></small></p>' : ''
      return {
        title: 'Sign in',
        body: `${page.message ? `<p>${escapeHtml(page.message)}</p>` : ''}${oidc}<p><button data-passkey="login">Sign in with a passkey</button></p>${signup}${breakGlass}`,
        config: { returnTo: page.returnTo, csrf: null },
      }
    }
    case 'invite': {
      const who = page.existingUser ? `for <strong>${escapeHtml(page.login ?? '')}</strong>` : page.login ? `as <strong>${escapeHtml(page.login)}</strong>` : ''
      const loginField = !page.existingUser && !page.login ? '<label>Login: <input id="login" name="login" autocomplete="username" required></label> ' : ''
      const oidc = page.oidcName
        ? `<p><a href="/login/oidc?invite=${encodeURIComponent(page.code)}"><button type="button">Continue with ${escapeHtml(page.oidcName)}</button></a></p>`
        : ''
      return {
        title: 'Accept invite',
        body: `<p>You were invited ${who}.</p>${oidc}<form>${loginField}<button data-passkey="register">Use a passkey</button></form>`,
        config: { returnTo: '/', csrf: null, invite: page.code },
      }
    }
    case 'device': {
      const message = page.message ? `<p>${escapeHtml(page.message)}</p>` : ''
      if (!page.device) {
        return {
          title: 'Connect a device',
          body: `${message}<form method="get" action="/login/device"><label>Code shown on your device: <input name="user_code" value="${escapeHtml(page.userCode ?? '')}" autocomplete="off" required></label> <button>Continue</button></form>`,
          config: null,
        }
      }
      const device = page.device
      return {
        title: 'Connect a device',
        body: `${message}<p><strong>${escapeHtml(device.clientName)}</strong> asks for a token for Git, Git LFS and the API on <strong>${escapeHtml(page.instance)}</strong> on behalf of <strong>${escapeHtml(page.user.login)}</strong>, with ${escapeHtml(accessLabel(device.scope))} access.</p>
<ul><li>Device: ${escapeHtml(device.clientHost ?? 'not reported')} (reported by the device)</li><li>Requested from: ${escapeHtml(device.requestIp ?? 'unknown')}${page.viewerIp ? ` (this browser: ${escapeHtml(page.viewerIp)})` : ''}</li><li>Requested at: ${escapeHtml(formatRequestTime(device.requestedAt))}</li><li>Code: <code>${escapeHtml(device.userCode)}</code></li></ul>
<p><strong>${escapeHtml(CONSENT_WARNING)}</strong></p>
<form method="post" action="/login/device">${csrfField(page.user.csrf)}<input type="hidden" name="user_code" value="${escapeHtml(device.userCode)}">
${accessRadios(device.scope)}
<button name="decision" value="approve">Approve</button> <button name="decision" value="deny">Deny</button></form>`,
        config: null,
      }
    }
    case 'device-result':
      return {
        title: page.approved ? 'Device connected' : 'Request denied',
        body: page.approved ? '<p>You can close this window and return to your terminal.</p>' : '<p>The device received no token.</p>',
        config: null,
      }
    case 'cli': {
      const request = page.request
      return {
        title: 'Authorize the command line',
        body: `<p>Authorize <strong>${escapeHtml(request.clientName)}</strong>${request.clientHost ? ` on <strong>${escapeHtml(request.clientHost)}</strong>` : ''} to act as <strong>${escapeHtml(page.user.login)}</strong> on <strong>${escapeHtml(page.instance)}</strong> with ${escapeHtml(accessLabel(request.scope))} access?</p>
<ul><li>Requested from: ${escapeHtml(request.requestIp ?? 'unknown')}</li><li>Requested at: ${escapeHtml(formatRequestTime(request.requestedAt))}</li></ul>
<p>${request.redirect === 'loopback' ? `The token goes to <code>${escapeHtml(request.redirectUri)}</code> on this computer.` : 'You will get a one-time code to paste into your terminal.'}</p>
<p><strong>${escapeHtml(CONSENT_WARNING)}</strong></p>
<form method="post" action="/login/cli/${escapeHtml(request.id)}">${csrfField(page.user.csrf)}
${accessRadios(request.scope)}
<button name="decision" value="approve">Approve</button> <button name="decision" value="deny">Deny</button></form>`,
        config: null,
      }
    }
    case 'cli-code':
      return {
        title: 'Paste this code',
        body: `<p>Paste this one-time code into your terminal. It works once, only for the terminal that asked for it, and expires at ${escapeHtml(formatRequestTime(page.expiresAt))}.</p>
<p><input id="cli-code" readonly value="${escapeHtml(page.code)}" aria-label="Authorization code" size="40"> <button type="button" data-copy="cli-code">Copy</button></p>
<script>${COPY_SCRIPT}</script>`,
        config: null,
      }
    case 'break-glass':
      return {
        title: 'Break-glass login',
        body: `${page.message ? `<p>${escapeHtml(page.message)}</p>` : ''}<p>Paste a token signed with the instance's offline break-glass key.</p>
<form method="post" action="/login/break-glass"><p><textarea name="token" rows="6" cols="40" required></textarea></p><button>Sign in</button></form>`,
        config: null,
      }
    case 'error':
      return { title: 'Sign-in failed', body: `<p>${escapeHtml(page.message)}</p><p><a href="/login">Back to sign-in</a></p>`, config: null }
  }
}

export const renderLoginPage = (page: LoginPage): Response => {
  const { title, body, config } = renderBody(page)
  return new Response(layout(title, body, config), {
    status: page.kind === 'error' ? page.status : 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action ${loginFormAction(page)}; frame-ancestors 'none'; base-uri 'none'`,
    },
  })
}
