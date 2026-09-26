// Shared by every page: where the backend is, the Supabase client (for login), and an authed fetch helper.
// The Supabase URL and publishable key come from the backend's GET /demo/config, so no keys live in git.

export const BACKEND = window.LUMA_BACKEND || 'http://127.0.0.1:8000';

let clientPromise = null;

export function getSupabase() {
  clientPromise ??= (async () => {
    let cfg;
    try {
      const res = await fetch(`${BACKEND}/demo/config`);
      cfg = await res.json();
      if (!res.ok) throw new Error(typeof cfg.detail === 'string' ? cfg.detail : `Backend responded ${res.status}`);
    } catch (e) {
      if (e instanceof Error && e.message && !e.message.startsWith('Failed to fetch')) throw e;
      throw new Error(`Can't reach the Luma backend at ${BACKEND}. Is it running?`);
    }
    if (!cfg.supabase_url || !cfg.supabase_publishable_key) {
      throw new Error('The backend is missing SUPABASE_URL or SUPABASE_PUBLISHABLE_KEY in its .env.');
    }
    return window.supabase.createClient(cfg.supabase_url, cfg.supabase_publishable_key);
  })();
  clientPromise.catch(() => { clientPromise = null; }); // allow a retry after a failure
  return clientPromise;
}

// FastAPI errors come back as {detail: "..."} or, for validation errors, {detail: [{msg}, ...]}
function errorText(data, status) {
  const d = data?.detail;
  if (typeof d === 'string') return d;
  if (Array.isArray(d)) return d.map((e) => e.msg).join('; ');
  return `Request failed (${status})`;
}

// Call the backend as the signed-in user. `body` goes as JSON; a Blob in `file` goes as-is (photo uploads).
export async function api(path, { method = 'GET', body, file } = {}) {
  const sb = await getSupabase();
  const { data: { session } } = await sb.auth.getSession();
  let res;
  try {
    res = await fetch(`${BACKEND}${path}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(file ? { 'Content-Type': file.type } : {}),
        ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}),
      },
      body: file || (body ? JSON.stringify(body) : undefined),
    });
  } catch {
    throw new Error(`Can't reach the Luma backend at ${BACKEND}. Is it running?`);
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(errorText(data, res.status));
    err.status = res.status;
    throw err;
  }
  return data;
}
