// The Supabase routes use the same paths and payloads as the admin dashboard on Node.
export default function admin({ call, rpc, session, fail, auth, signedIn }) {
  async function changeAccount(action, id) {
    const s = await session()
    if (!s) throw fail(401, 'not signed in')
    if (!id) throw fail(404, 'no such user')
    return call('/functions/v1/admin', { method: 'POST', body: { action, id }, token: s.access_token })
  }

  // Auth consumes the code when it opens a recovery session. Keep that session in memory
  // while the person corrects a password that Auth refused or retries an interrupted request.
  let recovery
  async function redeemReset(body) {
    const email = String(body?.identifier ?? body?.name ?? body?.email ?? '').trim().toLowerCase()
    const code = String(body?.code ?? '').trim().toLowerCase()
    const next = body?.next
    const invalid = () => fail(400, 'that reset code is wrong or has expired', 'reset-invalid')
    if (!email || !code) throw fail(400, 'e-mail and code required', 'missing')
    if (!/^[0-9a-f]{64}$/.test(code)) throw invalid()
    if (typeof next !== 'string' || [...next].length < 10) throw fail(400, 'use at least 10 characters', 'too-short')
    if (recovery?.code !== code || recovery?.session.user?.email?.toLowerCase() !== email) {
      let s
      try { s = await auth('/auth/v1/verify', { type: 'recovery', token_hash: code }) }
      catch (e) { throw [400, 401, 403, 422].includes(e.status) ? invalid() : e }
      if (!s?.access_token || s.user?.email?.toLowerCase() !== email) throw invalid()
      recovery = { code, session: s }
    }
    const s = recovery.session
    let user
    try { user = await call('/auth/v1/user', { method: 'PUT', body: { password: next }, token: s.access_token }) }
    catch (e) {
      if (e.status === 401) recovery = null
      throw e
    }
    recovery = null
    return signedIn({ ...s, user })
  }

  return {
    'GET /api/admin/users': () => rpc('admin_users'),
    'GET /api/admin/user': (_body, q) => rpc('admin_user_data', { uid: q.get('id') }),
    'POST /api/admin/user/disable': body => changeAccount(body?.disabled ? 'disable' : 'enable', body?.id),
    'POST /api/admin/user/delete': body => changeAccount('delete', body?.id),
    'POST /api/admin/user/password-reset': body => changeAccount('password-reset', body?.id),
    'POST /api/admin/user/recovery': body => changeAccount('password-reset', body?.id),
    'POST /api/login/password-reset': redeemReset,
    'POST /api/admin/user/role': body => {
      if (typeof body?.admin !== 'boolean') throw fail(400, 'admin must be true or false')
      return rpc('admin_set_role', { uid: body.id ?? null, role: body.admin ? 'admin' : 'user' })
    },
    'POST /api/admin/owner': body => rpc('admin_transfer_owner', { uid: body?.id ?? null }),
    'GET /api/admin/invites': () => rpc('admin_invites'),
    'POST /api/admin/invites/new': body => rpc('admin_create_invite', { note: typeof body?.note === 'string' ? body.note : '' }),
    'POST /api/admin/invites/revoke': body => rpc('admin_delete_invite', { code: body?.code ?? '' }),
    'POST /api/admin/invite-only': body => rpc('admin_set_invite_only', { enabled: body?.invite_only ?? null }),
    'GET /api/admin/audit': (_body, q) => {
      const limit = Math.max(1, Math.min(200, Math.trunc(Number(q.get('limit'))) || 100))
      const before = Number(q.get('before'))
      return rpc('admin_audit', {
        page_limit: limit, category: q.get('cat') || '', before_id: Number.isSafeInteger(before) && before > 0 ? before : null,
      })
    },
    'POST /api/admin/audit/clear': () => rpc('admin_clear_audit'),
  }
}
