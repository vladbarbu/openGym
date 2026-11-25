/* The Supabase backend (docs/SUPABASE.md): when the build sets VITE_SUPABASE_URL and
 * VITE_SUPABASE_KEY, api() in lib/api.js hands every /api/... request to supabaseApi() here, which
 * answers it the way the Node server would from Supabase Auth (GoTrue) and Postgres functions
 * (supabase/migrations). Only the routes the Supabase build offers exist; every other one is a
 * 404, and the static config below leaves the features behind them switched off.
 *
 * ponytail: plain fetch against five GoTrue endpoints and PostgREST RPCs, no supabase-js. Move to
 * supabase-js if realtime, storage or OAuth providers are ever needed. */
import passkeys from './supabase-passkeys.js'
import media from './supabase-media.js'
import push from './supabase-push.js'
import admin from './supabase-admin.js'

const URL_ = (import.meta.env.VITE_SUPABASE_URL || '').replace(/\/$/, '')
const KEY = import.meta.env.VITE_SUPABASE_KEY || ''
export const SUPABASE = !!(URL_ && KEY)

const STORE = 'gym_sb_session'
const EARLY_S = 60   // refresh this long before the access token expires

const fail = (status, message, code, data) => Object.assign(new Error(message), { status, code, data: { ...(data || {}), ...(code ? { code } : {}), error: message } })

function readSession() {
  try { return JSON.parse(localStorage.getItem(STORE)) || null } catch { return null }
}
let saveMirror = null
let mirrorWrites = Promise.resolve()
let mirrorReady
function writeSession(s) {
  try {
    if (s || saveMirror) localStorage.setItem(STORE, JSON.stringify(s))
    else localStorage.removeItem(STORE)
  } catch { /* private mode: the native mirror can still be updated */ }
  if (saveMirror) {
    mirrorWrites = mirrorWrites.then(() => saveMirror({ url: URL_, session: s })).catch(() => {})
    return mirrorWrites
  }
}

export function restoreSession(load, save) {
  return mirrorReady ||= (async () => {
    const file = await load()
    saveMirror = save
    // A local copy (including 'null' after sign-out) can be newer if the app
    // closed before the file write finished.
    if (localStorage.getItem(STORE) !== null) await writeSession(readSession())
    else if (file?.url === URL_ && file.session?.access_token) {
      localStorage.setItem(STORE, JSON.stringify(file.session))
    }
  })().catch(() => {})
}
const keep = s => s && s.access_token ? { access_token: s.access_token, refresh_token: s.refresh_token, expires_at: s.expires_at || Math.floor(Date.now() / 1000) + (s.expires_in || 3600), user: s.user } : null

async function call(path, { method = 'GET', body, token } = {}) {
  let r
  try {
    r = await fetch(URL_ + path, {
      method,
      headers: { apikey: KEY, 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  } catch { throw fail(undefined, 'The server could not be reached.', 'offline') }   // no status: the store reads it as offline
  const text = await r.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = null }
  if (!r.ok) {
    const code = data?.error_code || data?.code || null
    throw fail(r.status, data?.msg || data?.message || data?.error_description || 'HTTP ' + r.status, code, data)
  }
  return data
}

// One refresh at a time in this tab. Another tab may have refreshed already: the stored session
// is read again first, so a rotated refresh token is never presented twice (that signs out both).
let refreshing = null
async function session() {
  let s = readSession()
  if (!s) return null
  if (s.expires_at - EARLY_S > Date.now() / 1000) return s
  if (!refreshing) refreshing = (async () => {
    const now = readSession()
    if (!now) return null
    if (now.expires_at - EARLY_S > Date.now() / 1000) return now
    try {
      const next = keep(await call('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: now.refresh_token } }))
      // A sign-out or another sign-in can have replaced this session during the request.
      if (readSession()?.refresh_token !== now.refresh_token) return null
      await writeSession(next)
      return next
    } catch (e) {
      if (e.status && e.status < 500 && e.status !== 409 && e.status !== 429) {
        if (readSession()?.refresh_token === now.refresh_token) await writeSession(null)
        return null
      }
      throw e   // offline or busy: still signed in, try again later
    }
  })().finally(() => { refreshing = null })
  return refreshing
}

const userOf = (s, role) => s?.user ? {
  id: s.user.id, name: s.user.user_metadata?.name || (s.user.email || '').split('@')[0],
  ...(role === 'admin' || role === 'owner' ? { admin: true } : {}), ...(role === 'owner' ? { owner: true } : {}),
} : null
// profiles.role (supabase/migrations/*_admin.sql); a failed read just hides the admin page.
const roleOf = s => call('/rest/v1/profiles?select=role&id=eq.' + s.user.id, { token: s.access_token }).then(r => r?.[0]?.role || null, () => null)

async function rpc(fn, args) {
  const s = await session()
  if (!s) throw fail(401, 'not signed in')
  try { return await call('/rest/v1/rpc/' + fn, { method: 'POST', body: args || {}, token: s.access_token }) }
  catch (e) {
    if (e.status === 401) {
      if (readSession()?.access_token === s.access_token) await writeSession(null)
      throw fail(401, 'not signed in')
    }
    throw e
  }
}

// GoTrue's codes in the words the password sheets already have (components/PasswordAuth.jsx).
const AUTH_CODES = { invalid_credentials: 'bad-credentials', user_already_exists: 'email-taken', email_exists: 'email-taken', weak_password: 'too-short', email_address_invalid: 'email-invalid', validation_failed: 'email-invalid', over_request_rate_limit: 'busy', over_email_send_rate_limit: 'busy' }
async function auth(path, body) {
  try { return await call(path, { method: 'POST', body }) }
  catch (e) {
    const code = AUTH_CODES[e.code] || (/invite code/i.test(e.message) ? 'invite' : null)   // the before-user-created hook
    throw code ? fail(e.status, e.message, code) : e
  }
}
async function signedIn(res) {
  const s = keep(res)
  if (!s) throw fail(400, 'Confirm your e-mail address with the link we sent, then sign in.', 'email-not-confirmed')
  await writeSession(s)
  return { user: userOf(s, await roleOf(s)) }
}

const month = d => d.toISOString().slice(0, 7)
// Each feature area adds its routes from its own file (supabase-*.js), handed these helpers.
export const helpers = { URL: URL_, KEY, call, rpc, session, readSession, writeSession, keep, fail, userOf, auth, signedIn }
const ROUTES = {
  'GET /api/config': async () => ({
    signed_in: !!readSession(), allow_guest: true, password_login: true, leaderboard: true, supabase: true,
    invite_only: !!(await call('/rest/v1/rpc/signup_config', { method: 'POST', body: {} }).catch(() => null))?.invite_only,
    // The limits supabase-media.js and the media bucket enforce.
    media: { imageMB: 2, gifMB: 8, videoMB: 100, videoSec: 60, audioMB: 2, quotaMB: 200, workouts: true, days: true, sets: true, sounds: true, avatar: true, builtin: true },
  }),
  'GET /api/me': async () => {
    const s = await session()
    if (!s) throw fail(401, 'not signed in')
    return { user: userOf(s, await roleOf(s)) }
  },
  'POST /api/login/password': async ({ name, password }) => {
    const email = String(name || '').trim()
    if (!email.includes('@')) throw fail(400, 'Sign in with your e-mail address.', 'bad-credentials')
    return signedIn(await auth('/auth/v1/token?grant_type=password', { email, password }))
  },
  'POST /api/register/password': async ({ name, password, email, code }) => {
    if (!email) throw fail(400, 'An e-mail address is needed.', 'email-invalid')
    return signedIn(await auth('/auth/v1/signup', { email, password, data: { name: String(name || '').trim(), invite: String(code || '').trim().toUpperCase() } }))
  },
  'POST /api/logout': async () => {
    const s = readSession()
    await writeSession(null)
    if (s) await call('/auth/v1/logout?scope=local', { method: 'POST', token: s.access_token }).catch(() => {})
    return { ok: true }
  },
  'POST /api/logout/all': async () => {
    const s = await session().catch(() => null)
    await writeSession(null)
    if (s) await call('/auth/v1/logout?scope=global', { method: 'POST', token: s.access_token }).catch(() => {})
    return { ok: true }
  },
  'GET /api/data': () => rpc('get_state'),
  'GET /api/data/rev': () => rpc('get_state_rev'),
  'PUT /api/data': async ({ state, baseRev, baseWid }) => {
    try { return await rpc('put_state', { state, base_rev: baseRev ?? null, base_wid: baseWid ?? null }) }
    catch (e) {
      // put_state raises PT409 with the stored document in `details`: the shape the store's merge
      // reads from a Node server's 409 (e.data.state, e.data.rev).
      if (e.status === 409) {
        let cur = {}
        try { cur = JSON.parse(e.data?.details || '{}') } catch { /* keep {} */ }
        throw fail(409, 'conflict', 'conflict', { rev: cur.rev, state: cur.state })
      }
      if (e.data?.code === '54000') throw fail(413, 'too large', 'too-large')
      throw e
    }
  },
  'GET /api/leaderboard': async (_body, query) => {
    const now = new Date()
    const res = await rpc('leaderboard', { month: query.get('month') || 'all' })
    return { currentMonth: month(now), previousMonth: month(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0))), ...res }
  },
  'POST /api/leaderboard': async body => {
    try {
      if (body?.leave === true) return await rpc('leave_group')
      if (typeof body?.notify === 'boolean') return await rpc('set_leaderboard_notify', { notify: body.notify })
      if (typeof body?.create === 'string') return await rpc('create_group', { name: body.create })
      if (typeof body?.code === 'string') return await rpc('join_group', { code: body.code })
    } catch (e) {
      const known = ['leaderboard-invite', 'already-member'].find(c => e.message === c)
      throw known ? fail(403, known, known) : e
    }
    throw fail(400, 'invalid leaderboard membership change')
  },
}

Object.assign(ROUTES, passkeys(helpers), media(helpers), push(helpers), admin(helpers))

export async function supabaseApi(path, init = {}) {
  const u = new URL(path, 'http://x')
  const hash = u.pathname.match(/^\/api\/media\/([0-9a-f]{64})$/)?.[1]
  const route = ROUTES[(init.method || 'GET').toUpperCase() + ' ' + (hash ? '/api/media/{hash}' : u.pathname)]
  if (!route) throw fail(404, 'not available on this server')
  let body = null
  if (typeof init.body === 'string') { try { body = JSON.parse(init.body) } catch { body = null } }   // a Blob upload stays in init
  return route(body, u.searchParams, init, hash)
}
