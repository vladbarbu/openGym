import { dueKeys, dueKind, checkinPush } from '../../../api/checkin-reminder.js'
import { leaderboardRecap } from '../../../api/leaderboard.js'
import { excusedOn, nudgeFor, nudgeWindowOpen, toneOf } from '../../../api/nudge.js'
import { dayReminderPush, nudgePush } from '../../../api/push-messages.js'
import { effectiveRoutineId } from '../../../api/queue.js'
import { wrappedPush, wrappedPushOwed, wrappedSummary } from '../../../api/wrapped.js'

export type Candidate = {
  user_id: string
  doc: Record<string, unknown> | null
  reminder_day: string | null
  nudge_day: string | null
  nudge_time: string
  checkin_day: string | null
  recap_joined: string | null
  wrapped_owed: boolean
}

type Notification = { title: string; body: string; tag: string; leaderboardMonth?: string }

type Job = { user_id: string; kind: string; period: string; payload: Notification }

export function scheduledJobs(row: Candidate, month: string | null, year: number | null) {
  const jobs: Job[] = []
  const add = (kind: string, period: string, payload: Notification) => jobs.push({ user_id: row.user_id, kind, period, payload })
  if (month && row.recap_joined) {
    const recap = leaderboardRecap({ leaderboardJoined: row.recap_joined }, month)
    if (recap) add('recap', month, recap)
  }

  const doc = row.doc
  if (!doc) return jobs
  const S = {
    ...doc,
    workouts: Array.isArray(doc.workouts) ? doc.workouts : [],
    routines: Array.isArray(doc.routines) ? doc.routines : [],
    reminder: doc.reminder as { time?: string } | undefined,
  }
  const routine = (id: string) => S.routines.find(r => r?.id === id)

  if (row.reminder_day && !S.workouts.some(w => w?.d === row.reminder_day) && !excusedOn(S, row.reminder_day)) {
    const id = effectiveRoutineId(S, row.reminder_day)
    if (id) add('reminder', row.reminder_day, dayReminderPush(doc.lang, routine(id)))
  }
  if (row.nudge_day && nudgeWindowOpen(S.reminder?.time, row.nudge_time)) {
    const id = nudgeFor(S, row.nudge_day)
    if (id) add('nudge', row.nudge_day, nudgePush(doc.lang, toneOf(S.reminder), routine(id), row.nudge_day))
  }
  if (row.checkin_day) {
    const kind = dueKind(dueKeys(S, row.checkin_day))
    if (kind) add('checkin', row.checkin_day, checkinPush(doc.lang, kind))
  }
  if (year && row.wrapped_owed) {
    const summary = wrappedSummary(S)
    if (wrappedPushOwed({}, summary, year)) add('wrapped', String(year), wrappedPush(summary.lang, year))
  }
  return jobs
}
