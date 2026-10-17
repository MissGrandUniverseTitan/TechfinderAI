// Runs before every /api/* request.
// Cloudflare Access already blocks people who are not logged in, but we
// verify its signed JWT here as well, so the API is never open even if
// Access is misconfigured or someone reaches the *.pages.dev URL directly.

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

function isAllowed(email, env) {
  // Optional second allow-list on top of the Access policy.
  const list = (env.ALLOWED_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  return list.length === 0 || list.includes(email);
}

function deny(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export async function onRequest(context) {
  const { request, env } = context;
  const host = new URL(request.url).hostname;

  // Local development only (`npm run dev`): skip Access, which does not exist on localhost.
  if (env.DEV_BYPASS_AUTH === 'true' && (host === 'localhost' || host === '127.0.0.1')) {
    context.data.user = 'dev@localhost';
    return context.next();
  }

  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    return deny(500, 'server is missing ACCESS_TEAM_DOMAIN / ACCESS_AUD');
  }

  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return deny(401, 'not logged in');

  let email;
  try {
    email = await verifyAccessJwt(token, env);
  } catch (e) {
    return deny(401, 'invalid login token');
  }
  if (!isAllowed(email, env)) return deny(403, 'this account is not allowed');

  context.data.user = email;
  return context.next();
}
