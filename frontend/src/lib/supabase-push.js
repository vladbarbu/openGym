export const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY || ''

export default ({ rpc, fail }) => ({
  'GET /api/push/public-key': async () => {
    if (!VAPID_PUBLIC_KEY) throw fail(404, 'push notifications are unavailable')
    return { key: VAPID_PUBLIC_KEY }
  },
  'POST /api/push/subscribe': async body => {
    const { endpoint, keys } = body?.subscription || {}
    if (typeof endpoint !== 'string' || !keys?.p256dh || !keys?.auth) throw fail(400, 'invalid subscription')
    return rpc('push_subscribe', { endpoint, keys, device_id: body?.deviceId ?? null })
  },
  'GET /api/push/status': async (_, query) => rpc('push_status', { endpoint: query.get('endpoint') || '' }),
  'POST /api/push/unsubscribe': async body => rpc('push_unsubscribe', { endpoint: body?.endpoint ?? null }),
  'POST /api/push/test': async () => rpc('push_test'),
  'POST /api/push/rest-timer': async body => {
    const raw = body?.seconds
    const seconds = typeof raw === 'number' || typeof raw === 'string' ? Number(raw) : NaN
    if (!(seconds >= 1)) throw fail(400, 'seconds required')
    return rpc('push_rest_timer', {
      seconds: Math.min(3600, Math.round(seconds)),
      payload: { deviceId: body?.deviceId ?? null, next: typeof body?.next === 'string' ? body.next : null },
    })
  },
  'POST /api/push/rest-timer/cancel': async body => rpc('push_rest_timer_cancel', { device_id: body?.deviceId ?? null }),
  'POST /api/activity': async body => rpc('push_activity', { active: !!body?.active, reason: body?.reason ?? null }),
})
