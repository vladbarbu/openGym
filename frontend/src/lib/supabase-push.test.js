// @vitest-environment happy-dom
// @vitest-environment-options { "url": "https://gym.test/" }
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

let supabaseApi
const endpoint = 'https://fcm.googleapis.com/fcm/send/example'
const keys = { p256dh: 'public', auth: 'auth' }
const deviceId = 'device_123'
const ok = { ok: true }

beforeEach(async () => {
  vi.resetModules()
  vi.stubEnv('VITE_SUPABASE_URL', 'http://sb.test')
  vi.stubEnv('VITE_SUPABASE_KEY', 'pk')
  vi.stubEnv('VITE_VAPID_PUBLIC_KEY', 'public-key')
  localStorage.setItem('gym_sb_session', JSON.stringify({ access_token: 'at', expires_at: Date.now() / 1000 + 3600 }))
  supabaseApi = (await import('./supabase.js')).supabaseApi
})

afterEach(() => {
  localStorage.clear()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

it('returns the configured VAPID public key without signing in or contacting Supabase', async () => {
  localStorage.clear()
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  await expect(supabaseApi('/api/push/public-key')).resolves.toEqual({ key: 'public-key' })
  expect(fetch).not.toHaveBeenCalled()
})

it.each([
  ['POST', '/api/push/subscribe', { subscription: { endpoint, keys }, deviceId }, 'push_subscribe', { endpoint, keys, device_id: deviceId }, ok],
  ['GET', '/api/push/status?endpoint=' + encodeURIComponent(endpoint), null, 'push_status', { endpoint }, { subscribed: true, deviceId }],
  ['POST', '/api/push/unsubscribe', { endpoint }, 'push_unsubscribe', { endpoint }, ok],
  ['POST', '/api/push/test', {}, 'push_test', {}, ok],
  ['POST', '/api/push/rest-timer', { seconds: '5.4', deviceId, next: 'Bench press' }, 'push_rest_timer', { seconds: 5, payload: { deviceId, next: 'Bench press' } }, ok],
  ['POST', '/api/push/rest-timer/cancel', { deviceId }, 'push_rest_timer_cancel', { device_id: deviceId }, ok],
  ['POST', '/api/activity', { active: true }, 'push_activity', { active: true, reason: null }, ok],
])('%s %s calls the matching authenticated RPC', async (method, path, body, fn, args, result) => {
  const fetch = vi.fn(async () => ({ ok: true, text: async () => JSON.stringify(result) }))
  vi.stubGlobal('fetch', fetch)
  await expect(supabaseApi(path, { method, ...(body && { body: JSON.stringify(body) }) })).resolves.toEqual(result)
  expect(fetch).toHaveBeenCalledOnce()
  expect(fetch).toHaveBeenCalledWith('http://sb.test/rest/v1/rpc/' + fn, {
    method: 'POST',
    headers: { apikey: 'pk', 'Content-Type': 'application/json', Authorization: 'Bearer at' },
    body: JSON.stringify(args),
  })
})

it('rejects an invalid rest duration before queuing it', async () => {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  await expect(supabaseApi('/api/push/rest-timer', { method: 'POST', body: '{"seconds":{}}' }))
    .rejects.toMatchObject({ status: 400 })
  expect(fetch).not.toHaveBeenCalled()
})

it.each([
  ['configured web build', '0', 'public-key', true],
  ['web build without a VAPID key', '0', '', false],
  ['native build', '1', 'public-key', false],
])('reports push support in a %s', async (_, mobile, vapid, expected) => {
  vi.resetModules()
  vi.stubEnv('VITE_MOBILE', mobile)
  vi.stubEnv('VITE_VAPID_PUBLIC_KEY', vapid)
  vi.stubGlobal('navigator', { serviceWorker: {} })
  vi.stubGlobal('PushManager', function () {})
  vi.stubGlobal('Notification', function () {})
  const { pushSupported } = await import('./push.js')
  expect(pushSupported()).toBe(expected)
})
