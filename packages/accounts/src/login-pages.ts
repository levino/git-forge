export type LoginPage =
  | {
      readonly kind: 'login'
      readonly returnTo: string
      readonly oidcName: string | null
      readonly selfSignup: boolean
      readonly breakGlass: boolean
      readonly passkeys: boolean
      readonly user: { readonly login: string; readonly csrf: string } | null
      readonly message?: string
    }
  | {
      readonly kind: 'invite'
      readonly code: string
      readonly login: string | null
      readonly existingUser: boolean
      readonly oidcName: string | null
      readonly passkeys: boolean
    }
  | {
      readonly kind: 'device'
      readonly userCode: string | null
      readonly device: { readonly userCode: string; readonly clientName: string; readonly scopes: string } | null
      readonly user: { readonly login: string; readonly csrf: string }
      readonly message?: string
    }
  | { readonly kind: 'device-result'; readonly approved: boolean }
  | { readonly kind: 'break-glass'; readonly message?: string }
  | { readonly kind: 'error'; readonly status: number; readonly message: string }

export type LoginPageRenderer = (page: LoginPage, request: Request) => Response | null | Promise<Response | null>

export const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)

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
${page.passkeys ? '<p><button data-passkey="register">Add a passkey</button></p>\n' : ''}<form method="post" action="/logout">${csrfField(page.user.csrf)}<button>Sign out</button></form>`,
          config: page.passkeys ? { returnTo: page.returnTo, csrf: page.user.csrf } : null,
        }
      }
      const oidc = page.oidcName
        ? `<p><a href="/login/oidc?return_to=${encodeURIComponent(page.returnTo)}"><button type="button">Sign in with ${escapeHtml(page.oidcName)}</button></a></p>`
        : ''
      const signup = page.passkeys && page.selfSignup
        ? `<form><label>New account: <input id="login" name="login" autocomplete="username" required></label> <button data-passkey="register">Create with a passkey</button></form>`
        : ''
      const breakGlass = page.breakGlass ? '<p><small><a href="/login/break-glass">Break-glass login</a></small></p>' : ''
      return {
        title: 'Sign in',
        body: `${page.message ? `<p>${escapeHtml(page.message)}</p>` : ''}${oidc}${page.passkeys ? '<p><button data-passkey="login">Sign in with a passkey</button></p>' : ''}${signup}${breakGlass}`,
        config: page.passkeys ? { returnTo: page.returnTo, csrf: null } : null,
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
        body: `<p>You were invited ${who}.</p>${oidc}${page.passkeys ? `<form>${loginField}<button data-passkey="register">Use a passkey</button></form>` : ''}`,
        config: page.passkeys ? { returnTo: '/', csrf: null, invite: page.code } : null,
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
      return {
        title: 'Connect a device',
        body: `${message}<p><strong>${escapeHtml(page.device.clientName)}</strong> asks for a token for Git and Git LFS (<code>${escapeHtml(page.device.scopes)}</code>) on behalf of <strong>${escapeHtml(page.user.login)}</strong>.</p>
<p>Code: <code>${escapeHtml(page.device.userCode)}</code> — only continue if your device shows the same code.</p>
<form method="post" action="/login/device">${csrfField(page.user.csrf)}<input type="hidden" name="user_code" value="${escapeHtml(page.device.userCode)}">
<button name="decision" value="approve">Authorize</button> <button name="decision" value="deny">Deny</button></form>`,
        config: null,
      }
    }
    case 'device-result':
      return {
        title: page.approved ? 'Device connected' : 'Request denied',
        body: page.approved ? '<p>You can close this window and return to your terminal.</p>' : '<p>The device received no token.</p>',
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
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    },
  })
}
