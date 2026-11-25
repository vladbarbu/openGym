// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import media from './supabase-media.js'
import { MB } from './media-limits.js'
import { webm } from './media-samples.test-util.js'

const hash = n => n.toString(16).padStart(64, '0')
const file = (n, size) => ({ name: hash(n), metadata: { size } })
const storage = 'https://sb.test/storage/v1/object'
const account = { apikey: 'key', Authorization: 'Bearer token' }
const list = { method: 'POST', headers: { ...account, 'Content-Type': 'application/json' } }
const response = data => new Response(JSON.stringify(data))
const fail = (status, message, code, data) => Object.assign(new Error(message), { status, code, data })

let routes, fetch, call, session

beforeEach(() => {
  fetch = vi.fn()
  call = vi.fn()
  session = vi.fn(async () => ({ access_token: 'token', user: { id: 'uid' } }))
  vi.stubGlobal('fetch', fetch)
  routes = media({ URL: 'https://sb.test', KEY: 'key', call, session, fail })
})

afterEach(() => vi.unstubAllGlobals())

function upload(blob, mime, headers = {}) {
  return routes['PUT /api/media/{hash}'](null, null, { body: blob, headers: { 'Content-Type': mime, ...headers } }, hash(1))
}

describe('Supabase media', () => {
  it('upserts raw bytes into the authenticated account folder using the explicit MIME', async () => {
    const blob = new Blob(['photo'], { type: 'application/octet-stream' })
    fetch.mockResolvedValueOnce(response({ Key: `media/uid/${hash(1)}` }))
    await expect(upload(blob, 'image/png')).resolves.toEqual({ ok: true, hash: hash(1), mime: 'image/png', size: blob.size, existed: false })
    expect(fetch).toHaveBeenCalledWith(`${storage}/media/uid/${hash(1)}`, {
      method: 'POST', headers: { ...account, 'Content-Type': 'image/png', 'x-upsert': 'true' }, body: blob,
    })
  })

  it('downloads an authenticated Blob and maps a missing object to the app error', async () => {
    const download = routes['GET /api/media/{hash}']
    fetch.mockResolvedValueOnce(new Response(new Blob(['photo'], { type: 'image/png' })))
    const blob = await download(null, null, { expectSize: 5 }, hash(1))
    expect(blob).toBeInstanceOf(Blob)
    expect(await blob.text()).toBe('photo')
    expect(fetch).toHaveBeenCalledWith(`${storage}/authenticated/media/uid/${hash(1)}`, {
      method: 'GET', headers: account, cache: 'no-store',
    })
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ statusCode: '404', message: 'Object not found' }), { status: 400 }))
    await expect(download(null, null, {}, hash(1))).rejects.toMatchObject({ status: 404, code: 'media-missing' })
  })

  it.each([['image/jpeg', 2], ['image/gif', 8], ['audio/wav', 2], ['video/mp4', 100]])('refuses %s over %s MiB before fetching', async (mime, maxMB) => {
    const blob = new Blob()
    Object.defineProperty(blob, 'size', { value: maxMB * MB + 1 })
    await expect(upload(blob, mime)).rejects.toMatchObject({ status: 413, code: 'media-too-large', data: { maxMB } })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('refuses unsupported types and videos beyond the Node duration tolerance', async () => {
    await expect(upload(new Blob(['a']), 'toString')).rejects.toMatchObject({ status: 415, code: 'media-type' })
    await expect(upload(new Blob([webm({ durationMs: 62000 })]), 'video/webm'))
      .rejects.toMatchObject({ status: 413, code: 'media-too-long', data: { maxSec: 60 } })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('refuses a missing session or a request meant for a different account', async () => {
    const blob = new Blob(['a'])
    await expect(upload(blob, 'image/png', { 'X-OpenGym-Account': 'other' })).rejects.toMatchObject({ status: 409, code: 'account-mismatch' })
    const missing = routes['POST /api/media/missing']
    await expect(missing({ hashes: [hash(1)] }, null, { headers: { 'X-OpenGym-Account': 'other' } }))
      .rejects.toMatchObject({ status: 409, code: 'account-mismatch' })
    session.mockResolvedValueOnce(null)
    await expect(upload(blob, 'image/png')).rejects.toMatchObject({ status: 401 })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('maps the quota trigger refusal to the sync error and usage', async () => {
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ message: 'database error, code: OG001' }), { status: 500 }))
    fetch.mockResolvedValueOnce(response([file(2, 199.5 * MB)]))
    await expect(upload(new Blob(['a']), 'image/png'))
      .rejects.toMatchObject({ status: 413, code: 'media-quota', data: { quotaMB: 200, usedMB: 199.5 } })
  })

  it('lists every page, deduplicates hashes and reports disk usage', async () => {
    fetch.mockResolvedValueOnce(response(Array.from({ length: 100 }, (_, i) => file(i + 1, 11))))
    fetch.mockResolvedValueOnce(response([file(101, 7), file(102, 0)]))
    const missing = routes['POST /api/media/missing']
    await expect(missing({ hashes: [hash(101), hash(102), hash(103), hash(103)] })).resolves.toEqual({
      missing: [hash(102), hash(103)], usage: { bytes: 1107, count: 102, quotaBytes: 200 * MB },
    })
    for (const [i, offset] of [0, 100].entries()) {
      expect(fetch).toHaveBeenNthCalledWith(i + 1, `${storage}/list/media`, {
        ...list, body: JSON.stringify({ prefix: 'uid', limit: 100, offset, sortBy: { column: 'name', order: 'asc' } }),
      })
    }
    for (const hashes of [[123], ['z'.repeat(64)], Array(1001).fill(hash(1))]) {
      await expect(missing({ hashes })).rejects.toMatchObject({ status: 400 })
    }
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('uses the stored state for sweep, keeping all kinds of references and their posters', async () => {
    const files = Array.from({ length: 9 }, (_, i) => file(i + 1, 30))
    fetch.mockResolvedValueOnce(response(files)).mockResolvedValueOnce(response([{ ...files[8], name: `uid/${hash(9)}` }]))
    call.mockResolvedValueOnce({ state: {
      customEx: [{ media: { hash: hash(1), poster: { hash: hash(2) } } }],
      workouts: [{ media: [{ hash: hash(3) }], entries: [{ sets: [{ media: [{ hash: hash(4) }] }] }] }],
      dayPhotos: { today: { m: { hash: hash(5) } } }, sounds: [{ m: { hash: hash(6) } }],
      avatar: { m: { hash: hash(7) } }, exMedia: { ex: { m: { hash: hash(8) } } },
    } })
    await expect(routes['POST /api/media/sweep']()).resolves.toEqual({ removed: 1, freedBytes: 30, usage: { bytes: 240, count: 8, quotaBytes: 200 * MB } })
    expect(call).toHaveBeenCalledWith('/rest/v1/rpc/get_state', { method: 'POST', body: {}, token: 'token' })
    expect(fetch).toHaveBeenLastCalledWith(`${storage}/media`, {
      method: 'DELETE', headers: list.headers, body: JSON.stringify({ prefixes: [`uid/${hash(9)}`] }),
    })
  })

  it('keeps files when the saved state is absent or cannot be fetched', async () => {
    const sweep = routes['POST /api/media/sweep']
    fetch.mockImplementation(async () => response([file(1, 7)]))
    call.mockResolvedValueOnce({ state: null }).mockRejectedValueOnce(new Error('unreachable'))
    await expect(sweep()).resolves.toEqual({ removed: 0, freedBytes: 0, usage: { bytes: 7, count: 1, quotaBytes: 200 * MB } })
    await expect(sweep()).rejects.toThrow('unreachable')
    expect(fetch.mock.calls.every(([url]) => url === `${storage}/list/media`)).toBe(true)
  })
})
