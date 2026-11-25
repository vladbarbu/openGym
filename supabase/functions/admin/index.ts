const url = Deno.env.get('SUPABASE_URL')!
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const publicKey = Deno.env.get('SUPABASE_ANON_KEY')!
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'OPTIONS, POST',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { ...cors, 'Cache-Control': 'no-store' } })

class RequestError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

async function request(path: string, method: string, body?: unknown, userToken?: string) {
  const res = await fetch(url + path, {
    method,
    headers: {
      apikey: userToken ? publicKey : serviceKey,
      Authorization: 'Bearer ' + (userToken || serviceKey),
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  })
  const text = await res.text()
  const data = text ? JSON.parse(text) : null
  if (!res.ok) throw new RequestError(res.status, data?.msg || data?.message || 'The account change failed.')
  return data
}

const rpc = (name: string, body: unknown) => request('/rest/v1/rpc/' + name, 'POST', body)
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
  if (req.method !== 'POST') return json({ message: 'method not allowed' }, 405)
  const token = /^Bearer (\S+)$/i.exec(req.headers.get('Authorization') || '')?.[1]
  if (!token) return json({ message: 'not signed in' }, 401)
  try {
    // Auth verifies the user token even on projects that use the new JWT signing keys.
    const caller = await request('/auth/v1/user', 'GET', undefined, token)
    if (!caller?.id) return json({ message: 'not signed in' }, 401)
    const body = await req.json().catch(() => null)
    const { action, id } = body || {}
    if (typeof id !== 'string' || !uuid.test(id)) return json({ message: 'no such user' }, 404)
    if (!['disable', 'enable', 'delete', 'password-reset'].includes(action)) {
      return json({ message: 'invalid account change' }, 400)
    }

    const job = await rpc('admin_begin_auth_action', { actor_id: caller.id, uid: id, action })
    if (job.denied) return json({ message: job.denied }, 403)
    let result
    try {
      const userPath = '/auth/v1/admin/users/' + id
      switch (action) {
        case 'disable':
        case 'enable': {
          const disabled = action === 'disable'
          await request(userPath, 'PUT', { ban_duration: disabled ? '876000h' : 'none' })
          result = { ok: true, id, disabled }
          break
        }
        case 'delete':
          for (let start = 0; start < job.media.length; start += 1000) {
            await request('/storage/v1/object/media', 'DELETE', { prefixes: job.media.slice(start, start + 1000) })
          }
          await request(userPath, 'DELETE')
          result = { ok: true, id }
          break
        case 'password-reset': {
          // Change the old password and revoke its sessions before issuing a new recovery token.
          await request(userPath, 'PUT', { password: crypto.randomUUID() + '-Aa9!' })
          const link = await request('/auth/v1/admin/generate_link', 'POST', { type: 'recovery', email: job.email })
          if (link?.id !== id || !/^[0-9a-f]{64}$/i.test(link?.hashed_token || '')) {
            throw new Error('Auth did not return a recovery token for the account.')
          }
          result = { ok: true, name: job.name, code: link.hashed_token, expires: Date.now() + 3600_000 }
          break
        }
      }
    } finally {
      await rpc('admin_finish_auth_action', { claim: job.ticket, succeeded: !!result })
    }
    return json(result)
  } catch (err) {
    if (err instanceof RequestError && err.status < 500) return json({ message: err.message }, err.status)
    console.error('Admin account change failed.')
    return json({ message: 'The account change failed.' }, 500)
  }
})
