// Runs before every request (the page itself and /api/*).
//
// 1. Authentication: Cloudflare Access verifies the person owns their email
//    (one-time PIN). We verify Access's signed JWT here as well, so nothing is
//    served even if Access is misconfigured or the *.pages.dev URL is hit directly.
// 2. Authorization: the email must be an active row in the `users` table,
//    which admins manage from the app's "ผู้ใช้งาน" page. Its role
//    (admin / editor / viewer) is passed on to the API in context.data.role.

const encoder = new TextEncoder();
let cachedKeys = null; // { keys, fetchedAt }

function b64urlToBytes(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(str.length / 4) * 4, '=');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function b64urlToJson(str) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(str)));
}

async function getSigningKeys(teamDomain, forceRefresh) {
  const maxAgeMs = 60 * 60 * 1000;
  if (!forceRefresh && cachedKeys && Date.now() - cachedKeys.fetchedAt < maxAgeMs) {
    return cachedKeys.keys;
  }
  const res = await fetch(`${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error('could not fetch Access signing keys');
  const { keys } = await res.json();
  cachedKeys = { keys, fetchedAt: Date.now() };
  return keys;
}

async function verifyAccessJwt(token, env) {
  const teamDomain = env.ACCESS_TEAM_DOMAIN.replace(/\/+$/, '');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const [headerB64, payloadB64, sigB64] = parts;
  const header = b64urlToJson(headerB64);
  const payload = b64urlToJson(payloadB64);
  if (header.alg !== 'RS256') throw new Error('unexpected alg');

  let jwk = (await getSigningKeys(teamDomain, false)).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await getSigningKeys(teamDomain, true)).find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('unknown signing key');

  const key = await crypto.subtle.importKey(
    'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']
  );
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5', key, b64urlToBytes(sigB64), encoder.encode(`${headerB64}.${payloadB64}`)
  );
  if (!valid) throw new Error('bad signature');

  const now = Math.floor(Date.now() / 1000);
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.ACCESS_AUD)) throw new Error('wrong audience');
  if (payload.iss !== teamDomain) throw new Error('wrong issuer');
  if (typeof payload.exp !== 'number' || payload.exp < now) throw new Error('token expired');
  if (!payload.email) throw new Error('no email in token');
  return payload.email.toLowerCase();
}

function deny(request, status, message, email) {
  if (new URL(request.url).pathname.startsWith('/api/')) {
    return new Response(JSON.stringify({ error: message }), {
      status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }
  return new Response(forbiddenPage(status, email), {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

function forbiddenPage(status, email) {
  const msg = status === 403 && email
    ? `บัญชี <b>${escapeHtml(email)}</b> ยังไม่ได้รับสิทธิ์ใช้งานระบบนี้<br>กรุณาติดต่อผู้ดูแลระบบให้เพิ่มอีเมลนี้ในหน้า "ผู้ใช้งาน"`
    : 'กรุณาเข้าสู่ระบบใหม่อีกครั้ง';
  return `<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>ไม่มีสิทธิ์เข้าใช้งาน</title></head>
<body style="margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; background:#F5F6F8; font-family:sans-serif; color:#1B222E;">
<div style="background:#fff; border:1px solid #E3E6EB; border-radius:12px; padding:32px 28px; max-width:420px; margin:16px; text-align:center; line-height:1.7;">
<div style="font-size:20px; font-weight:700; color:#1B2A4A; margin-bottom:10px;">Techfinder Accounting</div>
<p>${msg}</p>
<p><a href="/cdn-cgi/access/logout" style="color:#2E7D6E;">ออกจากระบบ / ใช้อีเมลอื่น</a></p>
</div></body></html>`;
}

async function lookupRole(env, email) {
  const row = await env.DB.prepare(
    'SELECT role FROM users WHERE email = ? AND active = 1'
  ).bind(email).first();
  return row ? row.role : null;
}

export async function onRequest(context) {
  const { request, env } = context;
  const host = new URL(request.url).hostname;

  // Local development only (`npm run dev`): skip Access, which does not exist on localhost.
  // DEV_USER picks which `users` row to act as; with no matching row you are an admin.
  if (env.DEV_BYPASS_AUTH === 'true' && (host === 'localhost' || host === '127.0.0.1')) {
    const email = (env.DEV_USER || 'dev@localhost').toLowerCase();
    context.data.user = email;
    context.data.role = (await lookupRole(env, email)) || 'admin';
    return context.next();
  }

  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    return deny(request, 500, 'server is missing ACCESS_TEAM_DOMAIN / ACCESS_AUD');
  }

  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return deny(request, 401, 'not logged in');

  let email;
  try {
    email = await verifyAccessJwt(token, env);
  } catch (e) {
    return deny(request, 401, 'invalid login token');
  }

  const role = await lookupRole(env, email);
  if (!role) return deny(request, 403, 'this account is not allowed', email);

  context.data.user = email;
  context.data.role = role;
  return context.next();
}
