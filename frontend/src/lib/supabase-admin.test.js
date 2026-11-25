// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const uid = 'abe6bc56-95c0-4bc9-8b11-a454a785e940'
const answer = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) })
const post = body => ({ method: 'POST', body: JSON.stringify(body) })

async function load(fetch) {
  vi.resetModules()
  vi.stubEnv('VITE_SUPABASE_URL', 'http://sb.test')
  vi.stubEnv('VITE_SUPABASE_KEY', 'pk')
  vi.stubGlobal('fetch', fetch)
  return (await import('./supabase.js')).supabaseApi
}

beforeEach(() => {
  localStorage.setItem('gym_sb_session', JSON.stringify({ access_token: 'admin-token', expires_at: Math.floor(Date.now() / 1000) + 3600 }))
})
afterEach(() => {
  localStorage.clear()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

it('routes list, detail, ownership, invites and audit paging to the database', async () => {
  const responses = [
    ['/api/admin/users', undefined, 'admin_users', {}, { users: [{ id: uid }], invite_only: true, data_view: true, password_login: true }],
    ['/api/admin/user?id=' + uid, undefined, 'admin_user_data', { uid }, { user: { id: uid }, workouts: [] }],
    ['/api/admin/user/role', post({ id: uid, admin: true }), 'admin_set_role', { uid, role: 'admin' }, { ok: true, id: uid, admin: true }],
    ['/api/admin/owner', post({ id: uid }), 'admin_transfer_owner', { uid }, { ok: true, id: uid }],
    ['/api/admin/invites', undefined, 'admin_invites', {}, { invites: [], invite_only: true }],
    ['/api/admin/invites/new', post({ note: 'friend' }), 'admin_create_invite', { note: 'friend' }, { invite: { code: 'CODE' } }],
    ['/api/admin/invites/revoke', post({ code: 'CODE' }), 'admin_delete_invite', { code: 'CODE' }, { ok: true }],
    ['/api/admin/invite-only', post({ invite_only: false }), 'admin_set_invite_only', { enabled: false }, { ok: true, invite_only: false }],
    ['/api/admin/audit?limit=50&cat=admin&before=12', undefined, 'admin_audit', { page_limit: 50, category: 'admin', before_id: 12 }, { events: [], nextBefore: null }],
    ['/api/admin/audit/clear', post({}), 'admin_clear_audit', {}, { ok: true }],
  ]
  const fetch = vi.fn()
  const api = await load(fetch)
  for (const [path, init, rpc, body, result] of responses) {
    fetch.mockResolvedValueOnce(answer(200, result))
    await expect(api(path, init)).resolves.toEqual(result)
    expect(fetch).toHaveBeenLastCalledWith('http://sb.test/rest/v1/rpc/' + rpc, expect.objectContaining({
      method: 'POST', body: JSON.stringify(body), headers: expect.objectContaining({ Authorization: 'Bearer admin-token' }),
    }))
  }
})

it('uses the caller token for Auth admin operations and preserves errors', async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce(answer(200, { ok: true, id: uid, disabled: true }))
    .mockResolvedValueOnce(answer(200, { ok: true, id: uid, disabled: false }))
    .mockResolvedValueOnce(answer(403, { message: 'only the owner can delete an admin', code: 'forbidden' }))
    .mockResolvedValueOnce(answer(200, { ok: true, name: 'Alex', code: 'a'.repeat(64), expires: 123 }))
  const api = await load(fetch)
  await expect(api('/api/admin/user/disable', post({ id: uid, disabled: true }))).resolves.toMatchObject({ disabled: true })
  await expect(api('/api/admin/user/disable', post({ id: uid, disabled: false }))).resolves.toMatchObject({ disabled: false })
  await expect(api('/api/admin/user/delete', post({ id: uid }))).rejects.toMatchObject({ status: 403, code: 'forbidden' })
  await expect(api('/api/admin/user/password-reset', post({ id: uid }))).resolves.toMatchObject({ name: 'Alex', expires: 123 })
  expect(fetch.mock.calls.map(([, req]) => JSON.parse(req.body))).toEqual([
    { action: 'disable', id: uid }, { action: 'enable', id: uid }, { action: 'delete', id: uid }, { action: 'password-reset', id: uid },
  ])
  expect(fetch.mock.calls.every(([url, req]) => url === 'http://sb.test/functions/v1/admin' && req.headers.Authorization === 'Bearer admin-token')).toBe(true)
})

it('exchanges a recovery code for a password sign-in session', async () => {
  const code = 'ab'.repeat(32)
  const user = { id: uid, email: 'alex@example.test', user_metadata: { name: 'Alex' } }
  const fetch = vi.fn()
    .mockResolvedValueOnce(answer(200, { access_token: 'recovery-token', refresh_token: 'refresh-token', user }))
    .mockResolvedValueOnce(answer(200, user))
  const api = await load(fetch)
  await expect(api('/api/login/password-reset', post({ name: user.email, code, next: 'a new password' }))).resolves.toMatchObject({ user: { id: uid, name: 'Alex' } })
  expect(fetch).toHaveBeenNthCalledWith(1, 'http://sb.test/auth/v1/verify', expect.objectContaining({ body: JSON.stringify({ type: 'recovery', token_hash: code }) }))
  expect(fetch).toHaveBeenNthCalledWith(2, 'http://sb.test/auth/v1/user', expect.objectContaining({
    method: 'PUT', body: JSON.stringify({ password: 'a new password' }), headers: expect.objectContaining({ Authorization: 'Bearer recovery-token' }),
  }))
  expect(JSON.parse(localStorage.getItem('gym_sb_session')).access_token).toBe('recovery-token')
})
