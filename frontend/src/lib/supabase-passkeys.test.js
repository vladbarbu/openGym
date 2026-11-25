// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const key = 'pk'
const origin = 'http://sb.test'
const session = {
  access_token: 'at', refresh_token: 'rt', expires_in: 3600,
  user: { id: 'u1', email: 'alex@example.test', user_metadata: { name: 'Alex' } },
}
const storeSession = () => localStorage.setItem('gym_sb_session', JSON.stringify({
  ...session, expires_at: Math.floor(Date.now() / 1000) + 3600,
}))
const answer = (body, status = 200) => new Response(body === null ? null : JSON.stringify(body), { status })
const assertionOptions = {
  challenge: '-_8', rpId: 'localhost', allowCredentials: [{ type: 'public-key', id: 'AQI' }],
}
const creationOptions = {
  challenge: '-_8', rp: { id: 'localhost', name: 'openGym' },
  user: { id: 'AQI', name: 'alex', displayName: 'Alex' },
  excludeCredentials: [{ type: 'public-key', id: 'AwQ', transports: ['internal'] }],
}
const buf = (...bytes) => Uint8Array.of(...bytes).buffer
const item = { id: 'uuid', friendly_name: 'Work laptop', created_at: '2026-11-25', last_used_at: '2026-11-26' }
const state = {
  passkeys: [{ id: 'uuid', name: 'Work laptop', created: '2026-11-25', lastUsed: '2026-11-26', transports: [] }],
  password: false, lastWayIn: false,
}
const emptyState = { ...state, passkeys: [] }

async function load() {
  const { api, createPasskey, passkeyLogin, webauthnOK } = await import('./api.js')
  const request = (path, method, body) => api(path, {
    method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { request, createPasskey, passkeyLogin, webauthnOK }
}

describe('Supabase passkeys', () => {
  let fetch
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('VITE_SUPABASE_URL', origin)
    vi.stubEnv('VITE_SUPABASE_KEY', key)
    vi.stubEnv('VITE_MOBILE', '0')
    vi.stubGlobal('PublicKeyCredential', class {})
    localStorage.clear()
    fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function called(n, path, method, body, token) {
    expect(fetch).toHaveBeenNthCalledWith(n, origin + '/auth/v1/passkeys' + path, {
      method,
      headers: { apikey: key, 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  }

  it('shows WebAuthn on web builds with browser support', async () => {
    expect((await load()).webauthnOK()).toBe(true)
  })

  it('keeps WebAuthn hidden on mobile builds', async () => {
    vi.stubEnv('VITE_MOBILE', '1')
    expect((await load()).webauthnOK()).toBe(false)
  })

  it('decodes authentication options, verifies the assertion without a bearer token and persists the new session', async () => {
    const { request, passkeyLogin } = await load()
    storeSession()
    fetch.mockResolvedValueOnce(answer({ challenge_id: 'auth-id', options: assertionOptions }))
      .mockResolvedValueOnce(answer({ ...session, access_token: 'new-at' }))
    const get = vi.fn(async () => ({
      id: '-_8', rawId: buf(251, 255), type: 'public-key',
      getClientExtensionResults: () => ({ appid: false }),
      response: { clientDataJSON: buf(1, 2), authenticatorData: buf(3, 4), signature: buf(5, 6), userHandle: buf(7, 8) },
    }))
    vi.spyOn(navigator, 'credentials', 'get').mockReturnValue({ get })

    await expect(passkeyLogin()).resolves.toEqual({ id: 'u1', name: 'Alex' })
    called(1, '/authentication/options', 'POST', {})
    expect(get).toHaveBeenCalledWith({ publicKey: {
      ...assertionOptions, challenge: buf(251, 255), allowCredentials: [{ type: 'public-key', id: buf(1, 2) }],
    } })
    called(2, '/authentication/verify', 'POST', { challenge_id: 'auth-id', credential: {
      id: '-_8', rawId: '-_8', type: 'public-key', clientExtensionResults: { appid: false },
      authenticatorAttachment: null,
      response: { clientDataJSON: 'AQI', authenticatorData: 'AwQ', signature: 'BQY', userHandle: 'Bwg' },
    } })
    expect(JSON.parse(localStorage.getItem('gym_sb_session'))).toMatchObject({ access_token: 'new-at', refresh_token: 'rt' })
    await expect(request('/api/me')).resolves.toEqual({ user: { id: 'u1', name: 'Alex' } })
  })

  it('decodes creation options and verifies the attestation before applying the optional name', async () => {
    const { request, createPasskey } = await load()
    storeSession()
    fetch.mockResolvedValueOnce(answer({ challenge_id: 'registration-id', options: creationOptions }))
      .mockResolvedValueOnce(answer({ id: 'uuid', created_at: item.created_at }))
      .mockResolvedValueOnce(answer(item))
      .mockResolvedValueOnce(answer([item]))
    const create = vi.fn(async () => ({
      id: '-_8', rawId: buf(251, 255), type: 'public-key', authenticatorAttachment: 'platform',
      getClientExtensionResults: () => ({ credProps: { rk: true } }),
      response: { clientDataJSON: buf(1, 2), attestationObject: buf(3, 4), getTransports: () => ['internal'] },
    }))
    vi.spyOn(navigator, 'credentials', 'get').mockReturnValue({ create })

    const path = '/api/account/passkeys'
    const { cid, options } = await request(path + '/options', 'POST', {})
    expect({ cid, options }).toEqual({ cid: 'registration-id', options: creationOptions })
    const credential = await createPasskey(options)
    expect(options).toEqual(creationOptions)
    expect(create).toHaveBeenCalledWith({ publicKey: {
      ...creationOptions, challenge: buf(251, 255), user: { ...creationOptions.user, id: buf(1, 2) },
      excludeCredentials: [{ ...creationOptions.excludeCredentials[0], id: buf(3, 4) }],
    } })
    expect(credential).toEqual({
      id: '-_8', rawId: '-_8', type: 'public-key', authenticatorAttachment: 'platform',
      clientExtensionResults: { credProps: { rk: true } },
      response: { clientDataJSON: 'AQI', attestationObject: 'AwQ', transports: ['internal'] },
    })
    await expect(request(path + '/verify', 'POST', { cid, credential, name: 'Work laptop' })).resolves.toEqual({ ok: true, ...state })
    called(1, '/registration/options', 'POST', {}, 'at')
    called(2, '/registration/verify', 'POST', { challenge_id: 'registration-id', credential }, 'at')
    called(3, '/uuid', 'PATCH', { friendly_name: 'Work laptop' }, 'at')
    called(4, '/', 'GET', undefined, 'at')
  })

  it('prefers the browser JSON methods when available', async () => {
    const { request, createPasskey, passkeyLogin } = await load()
    const credential = { id: 'native' }
    const toJSON = vi.fn(() => credential)
    const create = vi.fn(async () => ({ toJSON }))
    const get = vi.fn(async () => ({ toJSON }))
    const parseCreationOptionsFromJSON = vi.fn(() => ({ challenge: buf(1) }))
    const parseRequestOptionsFromJSON = vi.fn(() => ({ challenge: buf(2) }))
    Object.assign(window.PublicKeyCredential, { parseCreationOptionsFromJSON, parseRequestOptionsFromJSON })
    vi.spyOn(navigator, 'credentials', 'get').mockReturnValue({ create, get })
    fetch.mockResolvedValueOnce(answer({ challenge_id: 'auth-id', options: assertionOptions }))
      .mockResolvedValueOnce(answer(session))

    await expect(createPasskey(creationOptions)).resolves.toEqual(credential)
    await passkeyLogin()
    expect(parseCreationOptionsFromJSON).toHaveBeenCalledWith(creationOptions)
    expect(parseRequestOptionsFromJSON).toHaveBeenCalledWith(assertionOptions)
    expect(create).toHaveBeenCalledWith({ publicKey: { challenge: buf(1) } })
    expect(get).toHaveBeenCalledWith({ publicKey: { challenge: buf(2) } })
    called(2, '/authentication/verify', 'POST', { challenge_id: 'auth-id', credential })
    await expect(request('/api/me')).resolves.toEqual({ user: { id: 'u1', name: 'Alex' } })
  })

  it('lists, renames and removes credentials with the session bearer token', async () => {
    const { request } = await load()
    storeSession()
    fetch.mockResolvedValueOnce(answer([item])).mockResolvedValueOnce(answer(item))
      .mockResolvedValueOnce(answer([item])).mockResolvedValueOnce(answer(null, 204))
      .mockResolvedValueOnce(answer([]))
    const path = '/api/account/passkeys'
    await expect(request(path)).resolves.toEqual(state)
    await expect(request(path + '/rename', 'POST', { id: 'uuid', name: 'Work laptop' })).resolves.toEqual({ ok: true, ...state })
    await expect(request(path + '?id=uuid', 'DELETE', {})).resolves.toEqual({ ok: true, ...emptyState })
    called(1, '/', 'GET', undefined, 'at')
    called(2, '/uuid', 'PATCH', { friendly_name: 'Work laptop' }, 'at')
    called(3, '/', 'GET', undefined, 'at')
    called(4, '/uuid', 'DELETE', undefined, 'at')
    called(5, '/', 'GET', undefined, 'at')
  })

  it('rejects account routes without a session before calling GoTrue', async () => {
    const { request } = await load()
    await expect(request('/api/account/passkeys')).rejects.toMatchObject({ status: 401 })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('returns the created key if GoTrue rejects its optional name', async () => {
    const { request } = await load()
    storeSession()
    fetch.mockResolvedValueOnce(answer({ id: 'uuid', created_at: item.created_at }))
      .mockResolvedValueOnce(answer({ error_code: 'validation_failed', msg: 'Invalid friendly name' }, 400))
      .mockResolvedValueOnce(answer([{ ...item, friendly_name: undefined }]))
    await expect(request('/api/account/passkeys/verify', 'POST', { cid: 'registration-id', credential: {}, name: 'Work laptop' }))
      .resolves.toMatchObject({ ok: true, passkeys: [{ id: 'uuid', name: null }], nameError: { message: 'Invalid friendly name' } })
  })

  it('reports a completed deletion even if the subsequent list request fails', async () => {
    const { request } = await load()
    storeSession()
    fetch.mockResolvedValueOnce(answer(null, 204)).mockRejectedValueOnce(new Error('offline'))
    await expect(request('/api/account/passkeys?id=uuid', 'DELETE', {})).resolves.toEqual({ ok: true })
  })

  it('maps an already used challenge to the existing retry message', async () => {
    const { request } = await load()
    fetch.mockResolvedValueOnce(answer({ error_code: 'webauthn_challenge_not_found', msg: 'Challenge not found or already used' }, 400))
    await expect(request('/api/login/verify', 'POST', { cid: 'auth-id', credential: {} }))
      .rejects.toMatchObject({ status: 400, data: { code: 'challenge-expired' } })
    expect(localStorage.getItem('gym_sb_session')).toBeNull()
  })
})
