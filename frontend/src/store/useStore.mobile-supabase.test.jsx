// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({ files: new Map(), read: vi.fn() }))
vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => 'ios', isNativePlatform: () => true },
  registerPlugin: () => ({}),
}))
vi.mock('@capacitor/filesystem', () => ({
  Directory: { Data: 'data', LibraryNoCloud: 'no-cloud' },
  Encoding: { UTF8: 'utf8' },
  Filesystem: {
    readFile: async ({ directory, path }) => {
      native.read(path)
      const data = native.files.get(directory + '/' + path)
      if (data === undefined) throw new Error('File does not exist')
      return { data }
    },
    writeFile: async ({ directory, path, data }) => { native.files.set(directory + '/' + path, data) },
    stat: async () => ({}),
  },
}))
vi.mock('@capacitor/app', () => ({ App: { addListener: () => ({ remove() {} }) } }))

const url = 'https://sb.test'
const sessionFile = 'no-cloud/opengym-supabase-session.json'
const session = () => ({
  access_token: 'access', refresh_token: 'refresh', expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: { id: 'u1', email: 'alex@example.test', user_metadata: { name: 'Alex' } },
})
const answer = body => ({ ok: true, status: 200, text: async () => JSON.stringify(body) })
const fetch = vi.fn(async path => {
  if (path.includes('grant_type=password')) return answer(session())
  if (path.includes('grant_type=refresh_token')) return answer({ ...session(), access_token: 'renewed' })
  if (path.endsWith('/rpc/get_state')) return answer({ state: { workouts: [{ id: 'w1', d: '2026-10-10', entries: [] }] }, rev: 1 })
  if (path.includes('/logout')) return answer(null)
  throw new Error('Unexpected fetch: ' + path)
})

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetModules()
  vi.stubEnv('VITE_MOBILE', '1')
  vi.stubEnv('VITE_SUPABASE_URL', url + '/')
  vi.stubEnv('VITE_SUPABASE_KEY', 'publishable')
  vi.stubGlobal('fetch', fetch)
  localStorage.clear()
  native.files.clear()
  native.read.mockClear()
  fetch.mockClear()
})
afterEach(async () => {
  window.dispatchEvent(new Event('pagehide'))
  await vi.dynamicImportSettled()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

it('boots to the shared sign-in gate with guest mode available and skips pairing', async () => {
  native.files.set('data/opengym-remote.json', JSON.stringify({ mode: 'remote', base: 'https://node.test', token: 'old' }))
  const { useStore } = await import('./useStore.js')
  await useStore.getState().boot()
  const state = useStore.getState()
  expect(state).toMatchObject({ ready: true, user: null, needsMobileOnboarding: false, config: { allow_guest: true, signed_in: false }, sync: { server: url } })
  expect(state.isGuest()).toBe(false)
  expect(native.read).not.toHaveBeenCalledWith('opengym-remote.json')
  expect(fetch.mock.calls.filter(([u]) => !u.endsWith('/rpc/signup_config'))).toEqual([])   // only the public invite-only flag
  state.setGuest(true)
  expect(useStore.getState().isGuest()).toBe(true)
  await useStore.getState().boot()
  expect(useStore.getState().isGuest()).toBe(true)
})

it('restores the mirrored session before checking auth and pulls through Supabase', async () => {
  native.files.set(sessionFile, JSON.stringify({ url, session: session() }))
  const { useStore } = await import('./useStore.js')
  await useStore.getState().boot()
  expect(useStore.getState()).toMatchObject({
    ready: true, user: { id: 'u1', name: 'Alex' }, config: { signed_in: true }, sync: { server: url },
  })
  expect(useStore.getState().S.workouts.map(w => w.id)).toEqual(['w1'])
  expect(fetch).toHaveBeenCalledWith(url + '/rest/v1/rpc/get_state', expect.objectContaining({
    headers: expect.objectContaining({ apikey: 'publishable', Authorization: 'Bearer access' }),
  }))
  expect(JSON.parse(localStorage.getItem('gym_sb_session')).access_token).toBe('access')
})

it('keeps a guest workout after WebView storage eviction', async () => {
  native.files.set('data/opengym-state.json', JSON.stringify({ _ts: 5, workouts: [{ id: 'guest-workout', d: '2026-10-10' }] }))
  native.files.set('data/opengym-state-owner.json', JSON.stringify({ owner: null, ts: 5 }))
  const { useStore } = await import('./useStore.js')
  await useStore.getState().boot()
  expect(useStore.getState().isGuest()).toBe(false)
  useStore.getState().setGuest(true)
  expect(useStore.getState().S.workouts.map(w => w.id)).toEqual(['guest-workout'])
  expect(fetch.mock.calls.filter(([u]) => !u.endsWith('/rpc/signup_config'))).toEqual([])   // only the public invite-only flag
})

it('mirrors password sign-in, token refresh and sign-out', async () => {
  const { useStore } = await import('./useStore.js')
  const { api } = await import('../lib/api.js')
  await useStore.getState().boot()
  await api('/api/login/password', { method: 'POST', body: JSON.stringify({ name: 'alex@example.test', password: 'pw' }) })
  expect(JSON.parse(native.files.get(sessionFile))).toMatchObject({ url, session: { access_token: 'access' } })

  localStorage.setItem('gym_sb_session', JSON.stringify({ ...session(), expires_at: 1 }))
  await api('/api/me')
  expect(JSON.parse(native.files.get(sessionFile)).session.access_token).toBe('renewed')

  await api('/api/logout', { method: 'POST' })
  expect(JSON.parse(native.files.get(sessionFile))).toEqual({ url, session: null })
  localStorage.clear()
  vi.resetModules()
  const fresh = (await import('./useStore.js')).useStore
  await fresh.getState().boot()
  expect(fresh.getState().user).toBeNull()
})
