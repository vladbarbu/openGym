import { timingSafeEqual } from 'node:crypto'
import webpush from 'npm:web-push@3.6.7'
import { monthToNotify } from '../../../api/leaderboard.js'
import { restTimerPush, testPush } from '../../../api/push-messages.js'
import { wrappedPushYear } from '../../../api/wrapped.js'
import { type Candidate, scheduledJobs } from './schedule.ts'

const url = Deno.env.get('SUPABASE_URL')
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
const secret = Deno.env.get('PUSH_CRON_SECRET')
const vapid = {
  subject: Deno.env.get('VAPID_SUBJECT'),
  publicKey: Deno.env.get('VAPID_PUBLIC_KEY'),
  privateKey: Deno.env.get('VAPID_PRIVATE_KEY'),
}
const utf8 = new TextEncoder()
const restMessage = restTimerPush as (lang: string | null, next?: string | null) => ReturnType<typeof restTimerPush>

function authorized(request: Request) {
  const supplied = utf8.encode(request.headers.get('X-Push-Secret') || '')
  const expected = utf8.encode(secret || '')
  return expected.length > 0 && supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

async function db<T>(path: string, method: string, body?: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${url}/rest/v1/${path}`, {
    method,
    headers: { apikey: serviceKey!, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  })
  const data = await response.text()
  if (!response.ok) throw new Error(`Push database request failed (${response.status})`)
  return (data ? JSON.parse(data) : null) as T
}

const rpc = <T>(name: string, body = {}) => db<T>('rpc/' + name, 'POST', body)

type Subscription = {
  endpoint: string
  keys: { p256dh: string; auth: string }
  user_id: string
  updated_at: string
}

type ClaimedJob = {
  kind: string
  payload: { next?: string | null }
  lang: string | null
  subscriptions: Subscription[] | null
}

async function deliver(sub: Subscription, payload: string) {
  try {
    // Use web-push for encryption and VAPID, and fetch for the timed, redirect-free request.
    const details = webpush.generateRequestDetails(sub, payload, { urgency: 'high' })
    const headers = new Headers()
    for (const [name, value] of Object.entries(details.headers)) {
      if (name.toLowerCase() !== 'content-length') headers.set(name, String(value))
    }
    const response = await fetch(sub.endpoint, {
      method: 'POST', headers, body: new Uint8Array(details.body), redirect: 'error', signal: AbortSignal.timeout(5000),
    })
    await response.body?.cancel()
    if ([403, 404, 410].includes(response.status)) {
      const query = new URLSearchParams({ endpoint: 'eq.' + sub.endpoint, user_id: 'eq.' + sub.user_id, updated_at: 'eq.' + sub.updated_at })
      await db('push_subscriptions?' + query, 'DELETE')
    } else if (!response.ok) console.error('Push rejected:', response.status)
  } catch (error) {
    console.error('Push delivery failed:', error instanceof Error ? error.name : 'unknown error')
  }
}

async function sendDue() {
  const jobs = await rpc<ClaimedJob[]>('push_claim')
  const deliveries = jobs.flatMap(job => {
    const message = job.kind === 'rest-timer' ? restMessage(job.lang, job.payload.next)
      : job.kind === 'test' ? testPush(job.lang) : job.payload
    const payload = JSON.stringify(message)
    return (job.subscriptions || []).map(sub => ({ sub, payload }))
  })
  let next = 0
  await Promise.all(Array.from({ length: Math.min(12, deliveries.length) }, async () => {
    while (next < deliveries.length) {
      const { sub, payload } = deliveries[next++]
      await deliver(sub, payload)
    }
  }))
  return jobs.length
}

async function enqueueScheduled() {
  const now = new Date()
  const month = monthToNotify(now)
  const year = wrappedPushYear(now)
  let after = null
  for (;;) {
    const candidates: Candidate[] = await rpc('push_candidates', {
      at_time: now.toISOString(), recap_month: month, wrapped_year: year, after_id: after,
    })
    if (!candidates.length) return
    const jobs = candidates.flatMap(row => {
      try { return scheduledJobs(row, month, year) }
      catch { console.error('Invalid state for scheduled push:', row.user_id); return [] }
    })
    if (jobs.length) await rpc('push_enqueue', { jobs })
    after = candidates[candidates.length - 1].user_id
  }
}

Deno.serve(async request => {
  if (request.method !== 'POST') return new Response(null, { status: 405 })
  if (!authorized(request)) return new Response(null, { status: 401 })
  if (!url || !serviceKey || !vapid.subject || !vapid.publicKey || !vapid.privateKey) {
    return new Response('Push is not configured', { status: 503 })
  }
  try {
    webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey)
    let scheduleFailed = false
    try { await enqueueScheduled() }
    catch { scheduleFailed = true; console.error('Could not queue scheduled push notifications') }
    const processed = await sendDue()
    return Response.json({ processed }, { status: scheduleFailed ? 500 : 200 })
  } catch {
    console.error('Could not process push notifications')
    return new Response(null, { status: 500 })
  }
})
