// GET  /api/data -> { value: <latest saved JSON string or null>, user, role }
// POST /api/data  { value: <JSON string> } -> saves a new version (admin / editor only)
//
// Every save is kept as a new row in state_versions (who saved it and when),
// so an accidental delete or overwrite can be rolled back. Only the newest
// KEEP_VERSIONS rows are kept.

const MAX_BYTES = 1_900_000; // D1 limit per value is ~2 MB
const KEEP_VERSIONS = 1000;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export async function onRequestGet({ env, data }) {
  const [row] = await Promise.all([
    env.DB.prepare('SELECT value FROM state_versions ORDER BY id DESC LIMIT 1').first(),
    env.DB.prepare('UPDATE users SET last_seen_at = ? WHERE email = ?')
      .bind(new Date().toISOString(), data.user).run(),
  ]);
  return json({ value: row ? row.value : null, user: data.user, role: data.role });
}

export async function onRequestPost({ request, env, data }) {
  if (data.role !== 'admin' && data.role !== 'editor') {
    return json({ error: 'read-only account' }, 403);
  }
  // Requiring JSON means a browser on another site cannot post here without
  // a CORS preflight, which we never approve (basic CSRF protection).
  if (!(request.headers.get('Content-Type') || '').startsWith('application/json')) {
    return json({ error: 'Content-Type must be application/json' }, 415);
  }

  const raw = await request.text();
  if (raw.length > MAX_BYTES) return json({ error: 'data too large' }, 413);

  let value;
  try {
    value = JSON.parse(raw).value;
    if (typeof value !== 'string') throw new Error();
    const state = JSON.parse(value);
    if (!state || typeof state !== 'object' || !Array.isArray(state.clients)) throw new Error();
  } catch {
    return json({ error: 'invalid data' }, 400);
  }

  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO state_versions (value, saved_by, saved_at) VALUES (?, ?, ?)'
    ).bind(value, data.user, new Date().toISOString()),
    env.DB.prepare(
      'DELETE FROM state_versions WHERE id <= (SELECT MAX(id) FROM state_versions) - ?'
    ).bind(KEEP_VERSIONS),
  ]);

  return json({ ok: true });
}
