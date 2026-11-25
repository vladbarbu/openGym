// The Supabase build's routes for passkey sign-in and passkey management (Supabase Auth passkeys). h: the helpers from lib/supabase.js.
const authPath = '/auth/v1/passkeys'
const accountPath = '/api/account/passkeys'
const errorCodes = {
  too_many_passkeys: 'passkey-limit',
  webauthn_challenge_not_found: 'challenge-expired',
  webauthn_challenge_expired: 'challenge-expired',
  webauthn_credential_exists: 'credential-exists',
}

export default function passkeys({ call, session, fail, signedIn }) {
  const tokenForAccount = async () => {
    const s = await session()
    if (!s) throw fail(401, 'not signed in')
    return s.access_token
  }

  async function ceremony(path, body, token) {
    try {
      return await call(authPath + '/' + path, { method: 'POST', body, token })
    } catch (e) {
      const code = errorCodes[e.code]
      throw code ? fail(e.status, e.message, code, e.data) : e
    }
  }

  async function start(kind, token) {
    const { challenge_id, options } = await ceremony(kind + '/options', {}, token)
    return { cid: challenge_id, options }
  }

  const verify = (kind, body, token) =>
    ceremony(kind + '/verify', { challenge_id: body?.cid, credential: body?.credential }, token)

  async function list(token) {
    const items = await call(authPath + '/', { token })
    return {
      passkeys: items.map(p => ({
        id: p.id, name: p.friendly_name || null, created: p.created_at, lastUsed: p.last_used_at || null, transports: [],
      })),
      // Supabase accounts have password sign-in. GoTrue checks the session for management.
      password: false,
      lastWayIn: false,
    }
  }

  const keyPath = id => authPath + '/' + encodeURIComponent(id)
  const rename = (token, id, name) => call(keyPath(id), { method: 'PATCH', body: { friendly_name: name }, token })
  const changed = async token => {
    // The write succeeded. If the list cannot be read, the sheet reloads it separately.
    const state = await list(token).catch(() => ({}))
    return { ok: true, ...state }
  }

  return {
    'POST /api/login/options': () => start('authentication'),
    'POST /api/login/verify': async body => signedIn(await verify('authentication', body)),
    ['GET ' + accountPath]: async () => list(await tokenForAccount()),
    ['POST ' + accountPath + '/options']: async () => start('registration', await tokenForAccount()),
    ['POST ' + accountPath + '/verify']: async body => {
      const token = await tokenForAccount()
      const { id } = await verify('registration', body, token)
      const name = typeof body?.name === 'string' ? body.name.trim() : ''
      let nameError
      // GoTrue sets a default name at registration. Applying a custom name is a separate write.
      if (name) {
        try { await rename(token, id, name) }
        catch (e) { nameError = e }
      }
      return { ...await changed(token), ...(nameError ? { nameError } : {}) }
    },
    ['POST ' + accountPath + '/rename']: async body => {
      const token = await tokenForAccount()
      await rename(token, body?.id, typeof body?.name === 'string' ? body.name.trim() : '')
      return changed(token)
    },
    ['DELETE ' + accountPath]: async (_body, query) => {
      const token = await tokenForAccount()
      await call(keyPath(query.get('id')), { method: 'DELETE', token })
      return changed(token)
    },
  }
}
