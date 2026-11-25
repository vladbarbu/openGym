// The Coach, on a phone that brings its own API key.
//
// No server. The pipeline the server runs — payload allowlist, prompt, provider call, parser,
// validator, one repair round — is imported from api/coach/core and run here, in-process, so
// the phone gets exactly the code the server has and not a second opinion of it. The apply
// engine, staleness, snapshot/revert and the log are the ones every build already uses.
//
// This module is the one static importer of the core, which makes `import('./coach-local.js')`
// the whole lazy chunk: the exercise catalogue, the prompts and the validator arrive together
// and only after the user chose this mode. coach-api.js dispatches here the same way it
// dispatches to the demo provider, so the screens never learn that there is no server.
//
// What is different from the server, and on purpose:
//   - the user pays. There is no cfg.caps to lean on, so a local daily cap is not optional —
//     but on a LAN model even that is friction, so it is one of the three dials the setup
//     screen's Advanced section keeps in the device file (#527).
//   - the pseudonym is drawn at random once and kept, rather than derived from a secret.
//   - a proposal waits in the device file, not in S, so it survives an app kill without
//     riding into a backup or a sync.
import * as payloadLib from '../../../api/coach/core/payload.js'
import { runPipeline } from '../../../api/coach/core/pipeline.js'
import { waitingProposal } from '../../../api/coach/core/pending.js'
import { isDue, FINAL_FAILURES, RETRY_AFTER_MS } from '../../../api/coach/core/due.js'
import { HTTP_PROVIDERS, baseUrlFor, phoneMayCall } from '../../../api/coach/core/providers.js'
import anthropic from '../../../api/coach/core/adapters/anthropic.js'
import openai from '../../../api/coach/core/adapters/openai.js'
import gemini from '../../../api/coach/core/adapters/gemini.js'
import minimax from '../../../api/coach/core/adapters/minimax.js'
import openrouter from '../../../api/coach/core/adapters/openrouter.js'
import compatible from '../../../api/coach/core/adapters/compatible.js'
import { modelSubstitute, compatProfile, rememberCompatProfile } from '../../../api/coach/core/adapters/http.js'
import { nativeFetch } from './capacitor-fetch.js'
import { getApiKey } from './coach-secrets.js'
import { loadCoachDevice, saveCoachDevice, coachLimits, webCoach } from './coach-device.js'
import { planHash } from './coach.js'
import { todayISO } from './format.js'
import { t, getLang } from './i18n.js'

export const ADAPTERS = { anthropic, openai, gemini, minimax, openrouter, compatible }
// Ten minutes for a cloud API: a thinking model can take several before its last word, and the
// answer streams (#1035), so a long wait is a live connection, not a hung one. A model on
// somebody's laptop is slower still, so the OpenAI-compatible endpoint gets the long budget.
export const TIMEOUT_MS = 10 * 60000
export const LOCAL_ENDPOINT_TIMEOUT_MS = 25 * 60000
export const timeoutFor = provider => (provider === 'compatible' ? LOCAL_ENDPOINT_TIMEOUT_MS : TIMEOUT_MS)
const PENDING_DAYS = 14
const HANDLE_LENGTH = 16

const sessions = new Map()
function session(userId = null) {
  userId ??= null
  if (!sessions.has(userId)) sessions.set(userId, { job: null, last: null, lastError: null })
  return sessions.get(userId)
}
// Reported to the screens through the same status shape the server answers with; a toast is
// also raised because on the server a failed job lands in the admin card, and here there is
// no admin card — the user is the operator.
let notify = null
export function setNotifier(fn) { notify = fn }

/* ---------- what this phone is configured with ---------- */

// Every request the phone's Coach sends goes through here: https:// anywhere, plain http:// only
// to an address on the home network (#913, providers.js phoneMayCall). The setup screen refuses
// anything else up front; this is the same rule at the moment of the call, for a device file
// written some other way and for every URL the adapters derive from the base.
export const guardedFetch = (url, init) => (phoneMayCall(url)
  ? webCoach() ? fetch(url, init) : nativeFetch(url, init)
  : Promise.reject(new Error(t('Plain http:// only works for an address on your home network, like 192.168.x.x, a .local name or a Tailscale 100.x address. Anything on the internet needs https://.'))))

const cfgOf = d => ({ provider: d.provider, providerOptions: d.baseUrl ? { [d.provider]: { baseUrl: d.baseUrl } } : {} })
const envOf = (d, key) => (key ? { [HTTP_PROVIDERS[d.provider].apiKeyEnv]: key } : {})

function mintHandle() {
  const bytes = new Uint8Array(12)
  ;(globalThis.crypto || {}).getRandomValues ? crypto.getRandomValues(bytes) : bytes.forEach((_, i) => { bytes[i] = Math.floor(Math.random() * 256) })
  let bin = ''; bytes.forEach(b => { bin += String.fromCharCode(b) })
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, HANDLE_LENGTH)
}
async function handle(d, userId) {
  if (d.handle && d.handle.length === HANDLE_LENGTH) return d.handle
  const h = mintHandle()
  await saveCoachDevice({ handle: h }, userId)
  return h
}

/* ---------- the cap ---------- */

function capState(d) {
  const today = todayISO()
  const used = d.daily && d.daily.d === today ? d.daily.n : 0
  return { used, limit: coachLimits(d).daily }
}
/* ---------- the API surface coach-api.js dispatches to ---------- */

export async function localStatus(userId) {
  let d = await loadCoachDevice(userId)
  if (d.pending?.expiresAt && d.pending.expiresAt < Date.now()) d = await saveCoachDevice({ pending: null }, userId)
  const runtime = session(userId)
  const { last = null, lastError = null } = webCoach() ? d : runtime
  return { job: runtime.job, pending: d.pending || null, cap: capState(d), lastError, last, maxMessageLen: coachLimits(d).maxMessageLen }
}

export const localReview = async (S, note, vitals, userId) => {
  const d = await loadCoachDevice(userId)
  return start(S, 'review', { note: note ? String(note).slice(0, coachLimits(d).maxMessageLen) : null, vitals: vitals || null }, userId)
}
export const localPlan = (S, intake, userId) => start(S, 'create', { intake: intake || null }, userId)
export const localRefine = async (S, text, userId) => {
  const d = await loadCoachDevice(userId)
  const pendingCreate = d.pending && d.pending.kind === 'create' ? d.pending : null
  return start(S, 'create', { refine: String(text || '').slice(0, coachLimits(d).maxMessageLen), previous: pendingCreate?.bundle || null, iteration: (pendingCreate?.iteration || 1) + 1 }, userId)
}
export const localDebrief = (S, workoutId, userId) => start(S, 'debrief', { workoutId: workoutId || null }, userId)
export const localAsk = async (S, text, today, vitals, routines, userId) => {
  const d = await loadCoachDevice(userId)
  return start(S, 'ask', { note: String(text || '').slice(0, coachLimits(d).maxMessageLen), today: today || null, vitals: vitals || null, routines: routines || null }, userId)
}

// An exercise of the running session, and why it needs a rethink (the `adapt` job).
export const localAdapt = async (S, { today, entry, reason, text, activeId } = {}, userId) => {
  const d = await loadCoachDevice(userId)
  return start(S, 'adapt', {
    today: today || null, focus: { entry, reason }, activeId: typeof activeId === 'string' ? activeId : null,
    note: text ? String(text).slice(0, coachLimits(d).maxMessageLen) : null,
  }, userId)
}

/* Automatic reviews. On a server the cadence tick runs them (api/coach/cadence.js); a phone with
   its own key has no server, and for a long time nothing ran them at all: the setting saved, the
   reviews never came (Discord, 10-19). So the phone asks the same question, with the same rule
   (core/due.js), whenever the app is open (lib/coach-schedule.js): right after a workout, and on
   the first open after a weekly slot. `reviewedAt` in the device file is the run marker, kept
   the way the server keeps its job history: a review the model answered counts, whether it
   proposed something, found nothing to change, or answered unusably (paid for all the same).
   Returns the started job, or null when nothing is due. Never throws: a skip is silent. */
let scheduledFailAt = 0
export async function localScheduled(S, now = new Date(), userId) {
  const cadence = S?.coach?.cadence
  if (session(userId).job || !cadence || cadence === 'off' || !S?.coach?.consent?.agreedAt) return null
  if (now.getTime() - scheduledFailAt < RETRY_AFTER_MS) return null
  const d = await loadCoachDevice(userId)
  if (d.mode !== 'byok' || !ADAPTERS[d.provider]) return null
  // A proposal nobody has answered is not replaced by the next one, as on the server.
  if (d.pending && !(d.pending.expiresAt && d.pending.expiresAt < now.getTime())) return null
  const cap = capState(d)
  if (cap.limit > 0 && cap.used >= cap.limit) return null
  const tz = deviceZone()
  if (!isDue(S.coach, S, wallClock(now), d.reviewedAt || 0, tz)) return null
  try { return await start(S, 'review', { scheduled: true }, userId) } catch { return null }
}
// The phone's own clock, in the shape the server's userNow() hands the tick.
export function wallClock(now) {
  const p = n => String(n).padStart(2, '0')
  return { date: `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`, hhmm: `${p(now.getHours())}:${p(now.getMinutes())}`, weekday: now.getDay() }
}
const deviceZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null } catch { return null } }
// A read answer gives back the proposal it was asked beside, as the server does.
export async function localResolve(userId) {
  const d = await loadCoachDevice(userId)
  await saveCoachDevice({ pending: d.pending?.kind === 'ask' || d.pending?.kind === 'adapt' ? waitingProposal(d.pending.prev) : null }, userId)
  return { ok: true }
}
export async function localForget(userId) {
  Object.assign(session(userId), { job: null, last: null, lastError: null })
  await saveCoachDevice({ pending: null, daily: null, reviewedAt: null, ...(webCoach() ? { last: null, lastError: null } : {}) }, userId)
  return { ok: true }
}

export async function localDisclosure(userId) {
  const d = await loadCoachDevice(userId)
  const meta = HTTP_PROVIDERS[d.provider] || {}
  const base = d.provider ? baseUrlFor(d.provider, cfgOf(d)) : ''
  return {
    provider: d.provider, providerLabel: meta.label || t('the configured AI provider'),
    categories: payloadLib.DATA_CATEGORIES, version: 1,
    // The honest difference from the self-hosted flow: it is the user's own account.
    payer: 'you', host: hostOf(base)
  }
}

/** The models the configured endpoint serves — the setup screen's list, and its reachability test. */
export async function localModels(settings, key) {
  const adapter = ADAPTERS[settings.provider]
  if (!adapter) return { ok: false, error: 'unknown provider', models: [] }
  return adapter.models(cfgOf(settings), envOf(settings, key), { fetch: guardedFetch, timeoutMs: 20000 })
}

const hostOf = url => { try { return new URL(url).host } catch { return url || '' } }

/* ---------- running a job ---------- */

async function start(S, kind, opts, userId = null) {
  if (!S?.coach?.consent?.agreedAt) throw Object.assign(new Error(t('The Coach needs your go-ahead first.')), { status: 403, code: 'consent' })
  const d = await loadCoachDevice(userId)
  const runtime = session(userId)
  if (runtime.job) throw Object.assign(new Error(t('The Coach is already thinking about your training.')), { status: 409, code: 'busy' })
  const adapter = ADAPTERS[d.provider]
  if (d.mode !== 'byok' || !adapter) throw Object.assign(new Error(webCoach() ? t('Off. Choose how the Coach should run.') : t('The Coach isn’t set up on this phone.')), { status: 503, code: 'off' })
  const cap = capState(d)
  // 0 is the documented "no limit" (the dial's own floor), same as the instance cap.
  if (cap.limit > 0 && cap.used >= cap.limit) throw Object.assign(new Error(webCoach() ? t('The Coach is taking a rest day. Try again tomorrow.') : t('The Coach is taking a breather. You’ve used today’s {0} runs on this phone.', cap.limit)), { status: 429, code: 'cap' })

  const job = { id: 'local-' + Date.now().toString(36), kind, state: 'running', startedAt: Date.now(), ...(opts.scheduled ? { trigger: 'scheduled' } : {}) }
  runtime.job = job
  runtime.lastError = null
  const isCurrent = () => runtime.job === job
  const save = patch => isCurrent() ? saveCoachDevice(patch, userId) : null
  const finish = async (outcome, error = null, patch = {}, reading) => {
    if (!isCurrent()) return
    const last = { id: job.id, kind, outcome, errorClass: error?.errorClass ?? null, at: Date.now(), ...(outcome === 'nochange' ? { reading } : {}) }
    Object.assign(runtime, { last, lastError: error })
    if (webCoach()) await save({ ...patch, last, lastError: error })
    else if (Object.keys(patch).length) await save(patch)
  }
  await save({ daily: { d: todayISO(), n: cap.used + 1 }, ...(webCoach() ? { lastError: null } : {}) })
  // The screens poll while the provider answers.
  if (isCurrent()) run(S, kind, opts, d, adapter, { userId, job, isCurrent, save, finish })
    .catch(e => finish('failed', { errorClass: 'internal', detail: String(e && e.message || e) }))
    .finally(() => { if (isCurrent()) runtime.job = null })
  return { job }
}

async function run(S, kind, opts, d, adapter, { userId, job, isCurrent, save, finish }) {
  const key = await getApiKey(userId)
  if (!isCurrent()) return
  // Web research on a chat question, with a provider that can search and the person's switch on.
  const useWeb = kind === 'ask' && !!HTTP_PROVIDERS[d.provider]?.web && S.coach?.web === true
  const payload = payloadLib.build(S, {
    handle: await handle(d, userId), kind, intake: opts.intake, note: opts.note, refine: opts.refine, previous: opts.previous, workoutId: opts.workoutId, today: opts.today, focus: opts.focus,
    vitals: opts.vitals || null, web: useWeb, routines: opts.routines || null,
    lang: getLang()   // what the app shows, which a profile that never picked a language does not store (#303)
  })
  if (!isCurrent()) return
  const model = d.model || HTTP_PROVIDERS[d.provider].defaultModel
  // What this endpoint and model needed last time (#804), so a gateway that only takes a
  // simpler request is asked that way first instead of paying for the same 400s every launch.
  const base = baseUrlFor(d.provider, cfgOf(d))
  if (d.compat && d.compat.provider === d.provider && d.compat.base === base && d.compat.model === model) rememberCompatProfile(d.provider, cfgOf(d), model, d.compat.steps)
  const attempt = await runPipeline({
    adapter, cfg: cfgOf(d), kind, payload,
    model, timeoutMs: timeoutFor(d.provider),
    invokeOpts: { env: envOf(d, key), fetch: guardedFetch, maxTokens: coachLimits(d).maxOutputTokens, ...(useWeb ? { web: true } : {}) }
  })
  // The saved model was refused and another one answered (#758): keep that one, so the next
  // launch does not pay for the same 404 again. The setup screen shows the new name.
  const swapped = model && modelSubstitute(d.provider, cfgOf(d), model)
  if (swapped && swapped !== d.model) await save({ model: swapped })
  // …and the request shape that endpoint took, the same way. Only a job that got an answer
  // teaches anything: compatProfile is cleared when every fallback was refused.
  const used = swapped || model
  const steps = compatProfile(d.provider, cfgOf(d), used)
  const had = d.compat && d.compat.provider === d.provider && d.compat.base === base && d.compat.model === used ? d.compat.steps : null
  if (JSON.stringify(steps || null) !== JSON.stringify(had || null)) await save({ compat: steps ? { provider: d.provider, base, model: used, steps } : null })
  if (!isCurrent()) return
  if (!attempt.ok) {
    // There is no admin card on a phone, so the reason has to reach the person holding it:
    // the provider's own words for a refusal, the validator's for an answer that did not fit.
    const detail = attempt.detail || (Array.isArray(attempt.errors) && attempt.errors.length
      ? attempt.errors.slice(0, 3).map(String).join(' · ').slice(0, 300)
      : null)
    const error = { errorClass: attempt.errorClass, detail }
    // A failure no retry fixes settles the round, as on the server (core/due.js); a passing one
    // waits a quarter of an hour before the schedule tries again, instead of every minute.
    const reviewed = kind === 'review' && FINAL_FAILURES.has(attempt.errorClass)
    if (kind === 'review' && opts.scheduled && !reviewed) scheduledFailAt = Date.now()
    await finish('failed', error, reviewed ? { reviewedAt: Date.now() } : {})
    if (isCurrent()) notify?.({ kind: 'failed', errorClass: attempt.errorClass, detail, scheduled: !!opts.scheduled }, userId)
    return
  }
  if (attempt.nochange) {
    await finish('nochange', null, kind === 'review' ? { reviewedAt: Date.now() } : {}, attempt.reading)
    if (isCurrent()) notify?.({ kind: 'nochange', reading: attempt.reading, scheduled: !!opts.scheduled }, userId)
    return
  }
  // A question whose answer is a plan or a change-set (core/ask-actions.js) waits as that kind.
  const as = attempt.kind || kind
  const pending = {
    id: job.id, kind: as, createdAt: Date.now(), expiresAt: Date.now() + PENDING_DAYS * 86400000,
    planHash: planHash(S), iteration: opts.iteration || 1,
    ...(kind === 'debrief' ? { workout: workoutMetaOf(S, opts.workoutId) } : {}),
    ...(as === 'ask' || as === 'adapt' ? { prev: waitingProposal((await loadCoachDevice(userId)).pending) } : {}),
    ...(as !== kind ? { from: kind } : {}),
    ...(kind === 'adapt' ? { activeId: opts.activeId || null, focus: payload.focus } : {}),
    ...attempt.result
  }
  await finish('ready', null, { pending, ...(kind === 'review' ? { reviewedAt: Date.now() } : {}) })
  if (isCurrent()) notify?.({ kind: 'ready', pending, scheduled: !!opts.scheduled }, userId)
}

// The session a debrief is about, in the shape the card reads. The core builds it for the
// server; the fallback covers a core that predates it.
function workoutMetaOf(S, workoutId) {
  if (typeof payloadLib.workoutMeta === 'function') return payloadLib.workoutMeta(S, workoutId)
  const all = (S.workouts || []).filter(w => w && w.d)
  const w = all.find(x => x.id === workoutId) || all[all.length - 1]
  return w ? { id: w.id, d: w.d, name: w.name || null } : null
}

// Test seam.
export function _resetLocal() {
  for (const s of sessions.values()) s.job = null
  sessions.clear()
}
