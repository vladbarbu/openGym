import { DEFAULT_LIMITS, MB } from './media-limits.js'
import { HASH_RE, MEDIA_MIMES, referencedHashes } from './media-refs.js'
import { inspectMp4, inspectWebm } from './media-sniff.js'

const OBJECT = '/storage/v1/object'
const PAGE_SIZE = 100
const QUOTA_BYTES = DEFAULT_LIMITS.quotaMB * MB
const sizeOf = file => Number(file.metadata?.size) || 0
const usageOf = files => ({ bytes: files.reduce((sum, file) => sum + sizeOf(file), 0), count: files.length, quotaBytes: QUOTA_BYTES })
const validHash = hash => typeof hash === 'string' && HASH_RE.test(hash)

export default function media({ URL, KEY, call, session, fail }) {
  async function account(init) {
    const s = await session()
    if (!s?.user?.id) throw fail(401, 'not signed in')
    const expected = new Headers(init?.headers).get('X-OpenGym-Account')
    if (expected && expected !== s.user.id) throw fail(409, 'signed in as another account now', 'account-mismatch')
    return s
  }

  async function request(s, path, { headers, ...init }, fetchImpl = globalThis.fetch) {
    let res
    try {
      res = await fetchImpl(URL + OBJECT + path, {
        ...init, headers: { apikey: KEY, Authorization: 'Bearer ' + s.access_token, ...headers },
      })
    } catch { throw fail(undefined, 'The server could not be reached.', 'offline') }
    if (res.ok) return res
    const data = await res.json().catch(() => null)
    const status = Number(data?.statusCode) || res.status
    const message = data?.message || 'HTTP ' + status
    const code = { 404: 'media-missing', 413: 'media-too-large', 415: 'media-type' }[status]
    const error = fail(status, message, code, data)
    if (status === 429) error.retryAfter = Number(res.headers.get('Retry-After')) || 60
    throw error
  }

  async function json(s, path, method, body) {
    const res = await request(s, path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    return res.json()
  }

  async function list(s) {
    const files = new Map()
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const page = await json(s, '/list/media', 'POST', {
        prefix: s.user.id, limit: PAGE_SIZE, offset, sortBy: { column: 'name', order: 'asc' },
      })
      for (const file of page) if (validHash(file.name)) files.set(file.name, file)
      if (page.length < PAGE_SIZE) return [...files.values()]
    }
  }

  return {
    'PUT /api/media/{hash}': async (_body, _query, init, hash) => {
      const s = await account(init)
      if (!validHash(hash)) throw fail(404, 'no such file', 'media-missing')
      const blob = init.body
      const mime = (new Headers(init.headers).get('Content-Type') ?? blob?.type ?? '').split(';')[0].trim().toLowerCase()
      if (!Object.hasOwn(MEDIA_MIMES, mime)) throw fail(415, 'that file type is not accepted', 'media-type')
      if (!(blob instanceof Blob) || !blob.size) throw fail(400, 'bad request', 'bad-request')
      const { kind } = MEDIA_MIMES[mime]
      // ponytail: the 100 MiB bucket cap is the hard limit. Smaller type limits are checked here.
      const maxMB = kind === 'audio' ? 2 : DEFAULT_LIMITS[`${kind}MB`]
      if (blob.size > maxMB * MB) throw fail(413, 'that file is too large', 'media-too-large', { maxMB })
      if (kind === 'video') {
        const webm = mime === 'video/webm'
        const bytes = new Uint8Array(await (webm ? blob.slice(0, MB) : blob).arrayBuffer())
        const info = webm ? inspectWebm(bytes) : inspectMp4(bytes)
        if (!info) throw fail(415, 'that video could not be read', 'media-invalid')
        const maxSec = DEFAULT_LIMITS.videoSec
        if (info.durationSec != null && info.durationSec > maxSec + 1) throw fail(413, 'that video is too long', 'media-too-long', { maxSec })
      }
      try {
        await request(s, `/media/${s.user.id}/${hash}`, {
          method: 'POST', headers: { 'Content-Type': mime, 'x-upsert': 'true' }, body: blob,
        })
      } catch (e) {
        // Storage may report only the trigger's SQLSTATE, without its message.
        const usage = /media-quota:([\d.]+)/.exec(e.message)
        if (!usage && e.message !== 'database error, code: OG001') throw e
        const usedMB = usage ? Number(usage[1]) : usageOf(await list(s)).bytes / MB
        throw fail(413, 'your space for photos and videos is full', 'media-quota', { usedMB, quotaMB: DEFAULT_LIMITS.quotaMB })
      }
      return { ok: true, hash, mime, size: blob.size, existed: false }
    },

    'GET /api/media/{hash}': async (_body, _query, init, hash) => {
      const s = await account(init)
      if (!validHash(hash)) throw fail(404, 'no such file', 'media-missing')
      const res = await request(s, `/authenticated/media/${s.user.id}/${hash}`, { method: 'GET', cache: 'no-store' }, init?.fetchImpl)
      const expectSize = init?.expectSize
      const max = typeof expectSize === 'number' && expectSize >= 0 ? expectSize + 1024 : DEFAULT_LIMITS.videoMB * MB
      const tooLarge = () => fail(res.status, 'that file is too large', 'too-large')
      if (Number(res.headers.get('Content-Length')) > max) {
        await res.body?.cancel().catch(() => {})
        throw tooLarge()
      }
      const blob = await res.blob()
      if (blob.size > max) throw tooLarge()
      return blob
    },

    'POST /api/media/missing': async (body, _query, init) => {
      const s = await account(init)
      const hashes = body?.hashes
      if (!Array.isArray(hashes) || hashes.length > 1000 || !hashes.every(validHash)) {
        throw fail(400, 'hashes must be a list of at most 1000 lowercase sha256 hex strings', 'bad-request')
      }
      const files = await list(s)
      const present = new Set(files.filter(file => sizeOf(file) > 0).map(file => file.name))
      return { missing: [...new Set(hashes)].filter(hash => !present.has(hash)), usage: usageOf(files) }
    },

    'POST /api/media/sweep': async (_body, _query, init) => {
      const s = await account(init)
      const files = await list(s)
      let removed = 0, freedBytes = 0
      if (files.length) {
        // Read the state with the same token that listed the files, even if the session changes.
        const { state } = await call('/rest/v1/rpc/get_state', { method: 'POST', body: {}, token: s.access_token })
        if (state && typeof state === 'object' && !Array.isArray(state)) {
          const refs = referencedHashes(state)
          const unused = files.filter(file => !refs.has(file.name))
          for (let start = 0; start < unused.length; start += 1000) {
            const batch = unused.slice(start, start + 1000)
            const deleted = await json(s, '/media', 'DELETE', { prefixes: batch.map(file => `${s.user.id}/${file.name}`) })
            const names = new Set(deleted.map(file => file.name))
            for (const file of batch) if (names.has(`${s.user.id}/${file.name}`)) {
              removed++
              freedBytes += sizeOf(file)
            }
          }
        }
      }
      const usage = usageOf(files)
      return { removed, freedBytes, usage: { ...usage, bytes: usage.bytes - freedBytes, count: usage.count - removed } }
    },
  }
}
