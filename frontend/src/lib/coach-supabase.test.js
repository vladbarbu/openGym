// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { store, api } = vi.hoisted(() => ({
  store: { user: { id: 'alice' }, coachLocal: null, S: {} },
  api: vi.fn(() => fetch('/api/coach/unexpected'))
}))
vi.mock('../store/useStore.js', () => ({ useStore: { getState: () => store } }))
vi.mock('./api.js', () => ({ api }))
vi.mock('./mobile.js', () => ({
  MOBILE: false,
  readJsonFile: vi.fn(async () => null),
  writeJsonFile: vi.fn(async () => {})
}))

beforeEach(() => {
  vi.resetModules()
  vi.stubEnv('VITE_SUPABASE_URL', 'https://supabase.example')
  vi.stubEnv('VITE_SUPABASE_KEY', 'test-key')
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('unmocked fetch') }))
  api.mockClear()
  localStorage.clear()
  store.user = { id: 'alice' }
  store.S = {}
  store.coachLocal = null
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

describe('Supabase browser coach', () => {
  it('routes status, disclosure, cohort and forget locally even before setup', async () => {
    const { coachVia, coachStatus, disclosure, cohortStats, setCohortShare, forgetCoach, scheduledNotice } = await import('./coach-api.js')
    expect(coachVia()).toBe('device')
    expect(await coachStatus()).toMatchObject({ job: null, pending: null })
    expect(await disclosure()).toMatchObject({ payer: 'you' })
    expect(await cohortStats()).toMatchObject({ enabled: false })
    await setCohortShare(false)
    await forgetCoach()
    await scheduledNotice()
    expect(api).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  }, 15000)

  it('shows the configured local coach without a server config block', async () => {
    const { coachAvailable } = await import('./coach.js')
    expect(coachAvailable({}, store.user, { coachMode: 'byok' })).toBe(true)
    expect(coachAvailable({ coach: { enabled: true } }, store.user)).toBe(false)
  })

  it('restores the key, proposal and run count after a reload and scopes them to the user', async () => {
    const { setApiKey } = await import('./coach-secrets.js')
    const { saveCoachDevice } = await import('./coach-device.js')
    const daily = { d: '2026-11-25', n: 2 }
    const pending = { id: 'p1', kind: 'review' }
    await setApiKey('test-provider-key', 'alice')
    await saveCoachDevice({ mode: 'byok', provider: 'openrouter', daily, pending }, 'alice')
    vi.resetModules()
    const { getApiKey, clearApiKey } = await import('./coach-secrets.js')
    const { loadCoachDevice } = await import('./coach-device.js')
    expect(await getApiKey('alice')).toBe('test-provider-key')
    expect(await loadCoachDevice('alice')).toMatchObject({ mode: 'byok', pending, daily })
    expect(await getApiKey('bob')).toBeNull()
    expect(await loadCoachDevice('bob')).toMatchObject({ mode: 'off', pending: null })
    await clearApiKey('alice')
    expect(await getApiKey('alice')).toBeNull()
  })

  it('runs the shared pipeline with the signed-in user’s key and restores the result after reload', async () => {
    const { setApiKey } = await import('./coach-secrets.js')
    const { saveCoachDevice } = await import('./coach-device.js')
    const { disclosure, coachStatus, requestReview } = await import('./coach-api.js')
    const { allowAi, consentTarget } = await import('./coach-consent.js')
    const review = { coach_contract: 1, nochange: true, reading: 'Keep the current plan.' }
    fetch.mockImplementation(async () => new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(review) } }]
    })))
    store.S = { coach: { consent: { agreedAt: '2026-11-25' } } }
    store.coachLocal = { mode: 'byok', provider: 'openai' }
    await setApiKey('alice-provider-key', 'alice')
    await setApiKey('bob-provider-key', 'bob')
    await saveCoachDevice(store.coachLocal, 'alice')
    await allowAi(consentTarget(await disclosure(), 'device'))

    const { job } = await requestReview()
    await vi.waitFor(async () => expect(await coachStatus()).toMatchObject({
      job: null, last: { id: job.id, outcome: 'nochange', reading: review.reading }, cap: { used: 1 }
    }))
    expect(api).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledExactlyOnceWith('https://api.openai.com/v1/chat/completions', expect.objectContaining({
      headers: expect.objectContaining({ authorization: 'Bearer alice-provider-key' })
    }))

    vi.resetModules()
    const reloaded = await import('./coach-api.js')
    expect(await reloaded.coachStatus()).toMatchObject({ job: null, last: { id: job.id, outcome: 'nochange' }, cap: { used: 1 } })
    store.user = { id: 'bob' }
    expect(await reloaded.coachStatus()).toMatchObject({ job: null, last: null, cap: { used: 0 } })
    store.user = { id: 'alice' }
    await reloaded.forgetCoach()
    expect(await reloaded.coachStatus()).toMatchObject({ last: null, cap: { used: 0 } })
  }, 15000)
})
