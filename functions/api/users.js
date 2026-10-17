// Admin-only user management.
// GET    /api/users                          -> { users: [...] }
// POST   /api/users  { email, name, role }   -> add a user, or change their name / role
// DELETE /api/users?email=...                -> remove a user
//
// Guards: an admin cannot remove or demote themself, and the last admin can never go,
// so nobody gets locked out of user management.

const ROLES = ['admin', 'editor', 'viewer'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

async function adminCount(env) {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1"
  ).first();
  return row.n;
}

export async function onRequest(context) {
  if (context.data.role !== 'admin') return json({ error: 'admins only' }, 403);
  const method = context.request.method;
  if (method === 'GET') return listUsers(context);
  if (method === 'POST') return saveUser(context);
  if (method === 'DELETE') return removeUser(context);
  return json({ error: 'method not allowed' }, 405);
}

async function listUsers({ env }) {
  const { results } = await env.DB.prepare(
    'SELECT email, name, role, added_by, added_at, last_seen_at FROM users WHERE active = 1 ORDER BY role, email'
  ).all();
  return json({ users: results });
}

async function saveUser({ request, env, data }) {
  if (!(request.headers.get('Content-Type') || '').startsWith('application/json')) {
    return json({ error: 'Content-Type must be application/json' }, 415);
  }
  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid JSON' }, 400); }

  const email = String(body.email || '').trim().toLowerCase();
  const name = String(body.name || '').trim().slice(0, 100);
  const role = String(body.role || '');
  if (!EMAIL_RE.test(email) || email.length > 254) return json({ error: 'อีเมลไม่ถูกต้อง' }, 400);
  if (!ROLES.includes(role)) return json({ error: 'สิทธิ์ไม่ถูกต้อง' }, 400);

  if (email === data.user && role !== 'admin') {
    return json({ error: 'ลดสิทธิ์ของตัวเองไม่ได้ ให้ผู้ดูแลคนอื่นเป็นผู้เปลี่ยน' }, 400);
  }

  await env.DB.prepare(
    `INSERT INTO users (email, name, role, active, added_by, added_at)
     VALUES (?, ?, ?, 1, ?, ?)
     ON CONFLICT(email) DO UPDATE SET name = excluded.name, role = excluded.role, active = 1`
  ).bind(email, name, role, data.user, new Date().toISOString()).run();
  return json({ ok: true });
}

async function removeUser({ request, env, data }) {
  const email = (new URL(request.url).searchParams.get('email') || '').trim().toLowerCase();
  if (!email) return json({ error: 'missing email' }, 400);
  if (email === data.user) return json({ error: 'ลบบัญชีของตัวเองไม่ได้' }, 400);

  const target = await env.DB.prepare('SELECT role FROM users WHERE email = ? AND active = 1').bind(email).first();
  if (!target) return json({ error: 'ไม่พบผู้ใช้นี้' }, 404);
  if (target.role === 'admin' && (await adminCount(env)) <= 1) {
    return json({ error: 'ต้องมีผู้ดูแลระบบอย่างน้อย 1 คน' }, 400);
  }

  await env.DB.prepare('DELETE FROM users WHERE email = ?').bind(email).run();
  return json({ ok: true });
}
