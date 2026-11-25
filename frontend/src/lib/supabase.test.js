// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// lib/supabase.js reads its env at import, so each test imports a fresh copy.
async function load() {
  vi.resetModules()
  vi.stubEnv('VITE_SUPABASE_URL', 'http://sb.test')
  vi.stubEnv('VITE_SUPABASE_KEY', 'pk')
  return import('./supabase.js')
}
const answer = (status, body) => ({ ok: status < 400, status, text: async () => (body == null ? '' : JSON.stringify(body)) })
const session = (expiresIn = 3600) => ({ access_token: 'at', refresh_token: 'rt', expires_at: Math.floor(Date.now() / 1000) + expiresIn, user: { id: 'u1', email: 'a@b.c', user_metadata: { name: 'Alex' } } })

describe('the Supabase backend behind api()', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

  it('signs in by e-mail and answers /api/me with the profile name', async () => {
    const { supabaseApi, SUPABASE } = await load()
    expect(SUPABASE).toBe(true)
    const fetch = vi.fn(async () => answer(200, session()))
    vi.stubGlobal('fetch', fetch)
    const res = await supabaseApi('/api/login/password', { method: 'POST', body: JSON.stringify({ name: 'a@b.c', password: 'pw' }) })
    expect(res.user).toEqual({ id: 'u1', name: 'Alex' })
    expect(fetch.mock.calls[0][0]).toBe('http://sb.test/auth/v1/token?grant_type=password')
    expect(fetch.mock.calls[0][1].headers.apikey).toBe('pk')
    expect((await supabaseApi('/api/me')).user.name).toBe('Alex')
  })

  it('marks owners as admins, passes the invite code to sign-up and routes media by hash', async () => {
    const { supabaseApi } = await load()
    localStorage.setItem('gym_sb_session', JSON.stringify(session()))
    vi.stubGlobal('fetch', vi.fn(async u => answer(200, u.includes('/profiles?') ? [{ role: 'owner' }] : null)))
    expect((await supabaseApi('/api/me')).user).toEqual({ id: 'u1', name: 'Alex', admin: true, owner: true })

    const fetch = vi.fn(async () => answer(403, { error_code: 'hook_error', msg: 'a valid invite code is required' }))
    vi.stubGlobal('fetch', fetch)
    await expect(supabaseApi('/api/register/password', { method: 'POST', body: JSON.stringify({ name: 'A', password: 'pw', email: 'a@b.c', code: ' ab12 ' }) }))
      .rejects.toMatchObject({ data: { code: 'invite' } })
    expect(JSON.parse(fetch.mock.calls[0][1].body).data.invite).toBe('AB12')

    // A raw upload reaches the media route with its hash, the Blob left in init.
    const hash = 'a'.repeat(64)
    await expect(supabaseApi('/api/media/' + 'z'.repeat(64), { method: 'PUT', body: new Blob(['x']) })).rejects.toMatchObject({ status: 404 })
    vi.stubGlobal('fetch', vi.fn(async () => answer(200, { Key: 'media/u1/' + hash })))
    await supabaseApi('/api/media/' + hash, { method: 'PUT', body: new Blob(['x'], { type: 'image/png' }), headers: { 'Content-Type': 'image/png' } }).catch(e => { if (e.status === 404) throw e })
  })

  it('maps wrong credentials to the code the password sheet words', async () => {
    const { supabaseApi } = await load()
    vi.stubGlobal('fetch', vi.fn(async () => answer(400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' })))
    await expect(supabaseApi('/api/login/password', { method: 'POST', body: JSON.stringify({ name: 'a@b.c', password: 'x' }) }))
      .rejects.toMatchObject({ status: 400, data: { code: 'bad-credentials' } })
  })

  it('turns a put_state conflict into the 409 the sync merge reads', async () => {
    const { supabaseApi } = await load()
    localStorage.setItem('gym_sb_session', JSON.stringify(session()))
    const fetch = vi.fn(async () => answer(409, { code: 'PT409', message: 'conflict', details: JSON.stringify({ rev: 7, state: { workouts: [] } }) }))
    vi.stubGlobal('fetch', fetch)
    await expect(supabaseApi('/api/data', { method: 'PUT', body: JSON.stringify({ state: { a: 1 }, baseRev: 6, baseWid: 'w' }) }))
      .rejects.toMatchObject({ status: 409, data: { rev: 7, state: { workouts: [] } } })
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ state: { a: 1 }, base_rev: 6, base_wid: 'w' })
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer at')
  })

  it('refreshes an expiring token once, even for two calls at the same time', async () => {
    const { supabaseApi } = await load()
    localStorage.setItem('gym_sb_session', JSON.stringify(session(10)))
    const fetch = vi.fn(async url => url.includes('refresh_token') ? answer(200, { ...session(), access_token: 'at2' }) : answer(200, { rev: 1 }))
    vi.stubGlobal('fetch', fetch)
    await Promise.all([supabaseApi('/api/data/rev'), supabaseApi('/api/data/rev')])
    expect(fetch.mock.calls.filter(([url]) => url.includes('refresh_token'))).toHaveLength(1)
    expect(JSON.parse(localStorage.getItem('gym_sb_session')).access_token).toBe('at2')
  })

  it('answers 404 for what the Supabase build does not offer', async () => {
    const { supabaseApi } = await load()
    await expect(supabaseApi('/api/coach/chat', { method: 'POST' })).rejects.toMatchObject({ status: 404 })
  })
})
