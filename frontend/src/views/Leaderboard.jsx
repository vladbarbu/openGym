import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import Icon from '../components/Icon.jsx'
import { Button, Row, Section, Segmented, SelectRow, Switch } from '../components/ui.jsx'
import { api } from '../lib/api.js'
import { copyText } from '../lib/clipboard.js'
import { SUPABASE } from '../lib/supabase.js'
import { useUI } from '../store/useUI.js'
import { EXIDX, isAssisted } from '../lib/exercises.js'
import { fmtDate, fmtNum } from '../lib/format.js'
import { exerciseNameFor, t } from '../lib/i18n.js'
import { monthLabel } from '../lib/month-story.js'
import { LB_KG } from '../lib/units.js'
import { useStore } from '../store/useStore.js'

export default function Leaderboard() {
  const nav = useNavigate()
  const user = useStore(s => s.user)
  return <>
    <div className="hdr">
      <button className="iconbtn" data-back="/stats" onClick={() => nav('/stats')} aria-label={t('Stats')}>
        <Icon name="chevronLeft" />
      </button>
      <div style={{ flex: 1, marginInlineStart: 12 }}><h1>{t('Leaderboard')}</h1></div>
    </div>
    {user ? <GroupLeaderboard key={user.id} /> : <p className="small dim">{t('Sign in to join a leaderboard.')}</p>}
  </>
}

const boardKey = board => JSON.stringify([board.exercise, board.basis])

function GroupLeaderboard() {
  const [search, setSearch] = useSearchParams()
  const month = search.get('month') || 'all'
  const unit = useStore(s => s.S.unit) === 'lb' ? 'lb' : 'kg'
  const [view, setView] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [retry, setRetry] = useState(0)
  const [code, setCode] = useState('')
  const [groupName, setGroupName] = useState('')
  const [category, setCategory] = useState('lifts')
  const [exercise, setExercise] = useState('')

  useEffect(() => {
    let current = true
    setView(null)
    setError(null)
    api('/api/leaderboard?' + new URLSearchParams({ month })).then(result => {
      if (current) setView(result)
    }).catch(error => {
      if (current) setError(error)
    })
    return () => { current = false }
  }, [month, retry])

  async function changeMembership(body) {
    setBusy(true)
    setError(null)
    try {
      const membership = await api('/api/leaderboard', { method: 'POST', body: JSON.stringify(body) })
      if (membership.joined && view?.joined) setView(previous => previous?.joined ? { ...previous, ...membership } : previous)
      else setRetry(value => value + 1)
      if (body.code) setCode('')
      if (body.create) setGroupName('')
      if (!membership.joined) setView(null)
    } catch (error) {
      setError(error)
    } finally {
      setBusy(false)
    }
  }

  if (!view) {
    if (!error) return <p role="status" className="small dim">{t('Loading…')}</p>
    return <div role="alert">
      <p>{error.status === 404 ? t('The leaderboard is unavailable on this server.') : t('Could not load the leaderboard.')}</p>
      {error.status !== 404 && <Button onClick={() => setRetry(value => value + 1)}>{t('Try again')}</Button>}
    </div>
  }

  // A Supabase answer carries its code on the error, a Node server's in the body (e.data).
  const failed = error && (error.code || error.data?.code)
  const message = error && <p role="alert" className="small">{failed === 'leaderboard-invite'
    ? t('That leaderboard invite code is incorrect.')
    : t('Could not update the leaderboard. Try again.')}</p>

  if (!view.joined) return <><Section title={t('Join the leaderboard')}>
    <form className="card" style={{ display: 'grid', gap: 12 }}
      onSubmit={event => { event.preventDefault(); changeMembership({ code: code.trim() }) }}>
      <div>{t('Joining shares your display name and leaderboard results with group members. You can leave at any time.')}</div>
      <label className="measure-date" style={{ marginBottom: 0 }}>
        <span>{t('Invite code')}</span>
        <input className="field" type={SUPABASE ? 'text' : 'password'} value={code} autoComplete="off" maxLength={128}
          required onChange={event => setCode(event.target.value)} />
      </label>
      {message}
      <Button type="submit" variant="primary" disabled={busy || !code.trim()}>{t('Join')}</Button>
    </form>
  </Section>
    {/* On Supabase each group of friends has its own code; whoever starts one shares it. */}
    {SUPABASE && <Section title={t('Start a group')}>
      <form className="card" style={{ display: 'grid', gap: 12 }}
        onSubmit={event => { event.preventDefault(); changeMembership({ create: groupName.trim() }) }}>
        <div>{t('You get an invite code to share with your friends.')}</div>
        <label className="measure-date" style={{ marginBottom: 0 }}>
          <span>{t('Group name')}</span>
          <input className="field" value={groupName} autoComplete="off" maxLength={64}
            required onChange={event => setGroupName(event.target.value)} />
        </label>
        <Button type="submit" disabled={busy || !groupName.trim()}>{t('Start a group')}</Button>
      </form>
    </Section>}
  </>

  const periods = [
    { value: 'all', label: t('All time') },
    { value: view.currentMonth, label: t('This month') },
    { value: view.previousMonth, label: t('Last month') },
  ]
  if (!periods.some(option => option.value === month)) periods.push({ value: month, label: monthLabel(month) })

  const exercises = view.exercises.filter(board => Object.hasOwn(EXIDX, board.exercise) && !isAssisted(EXIDX[board.exercise]))
    .map(board => {
      const name = exerciseNameFor(EXIDX[board.exercise])
      const label = board.basis === 'each' ? t('{0} (per dumbbell)', name)
        : board.basis === 'total' ? t('{0} (combined load)', name) : name
      return { value: boardKey(board), label, board }
    }).sort((a, b) => a.label.localeCompare(b.label))
  const lift = exercises.find(option => option.value === exercise) || exercises[0]
  const options = [
    { value: 'lifts', label: t('Exercise PRs') },
    { value: 'volume', label: t('Heaviest day') },
    { value: 'streak', label: t('Consistency') },
  ]
  const formatWeight = kg => `${fmtNum(Math.round((unit === 'lb' ? kg / LB_KG : kg) * 100) / 100)} ${unit}`
  const rows = category === 'lifts' ? lift?.board.rows || [] : category === 'volume' ? view.heaviest : view.consistency
  const score = row => category === 'lifts' ? `${row.weight}|${row.reps}` : category === 'volume' ? row.volume : row.weeks
  let rank = 0

  return <>
    <Section title={view.group?.name || t('Friends leaderboard')}>
      <SelectRow title={t('Period')} value={month} options={periods} onChange={value => setSearch(value === 'all' ? {} : { month: value })} />
    </Section>
    <Segmented value={category} options={options} onChange={setCategory} of={t('Leaderboard')} />
    {category === 'lifts' && lift &&
      <Section><SelectRow title={t('Exercise')} value={lift.value} options={exercises} onChange={setExercise} search /></Section>}
    {category === 'volume' && <p className="small dim">{t('Total working-set volume across all workouts on your heaviest day.')}</p>}
    {category === 'streak' && <p className="small dim">{t('Longest streak of weeks with at least three training days. Weeks start on Monday.')}</p>}
    <Section title={t('Standings')}>
      {!rows.length && <Row title={t('No results for this period yet.')} />}
      {rows.map((row, index) => {
        if (index === 0 || score(row) !== score(rows[index - 1])) rank = index + 1
        const value = category === 'lifts' ? `${formatWeight(row.weight)} × ${fmtNum(row.reps)}`
          : category === 'volume' ? formatWeight(row.volume) : t('{0} wk', fmtNum(row.weeks))
        const detail = category === 'streak' ? t('Training days: {0}', fmtNum(row.days)) : fmtDate(row.date, true, true)
        return <Row key={row.id} title={`${rank}. ${row.name}`} subtitle={detail} value={value} />
      })}
    </Section>
    <Section title={t('Group settings')}>
      {view.group?.code && <Row title={t('Invite code')} subtitle={t('Tap to copy, then send it to a friend.')} value={view.group.code}
        onClick={async () => useUI.getState().toast(await copyText(view.group.code) ? t('Copied') : view.group.code)} />}
      {/* ponytail: the Supabase build has no push yet, so no recap to switch on. */}
      {!SUPABASE && <Row title={t('Monthly notification')} subtitle={t('Get last month’s standings through OpenGym web push. Enable push notifications in Settings.')}>
        <Switch checked={view.notify} disabled={busy} onChange={() => changeMembership({ notify: !view.notify })} />
      </Row>}
      <Row title={t('Leave leaderboard')} accessory="chevron" onClick={busy ? undefined : () => changeMembership({ leave: true })} />
    </Section>
    {message}
  </>
}
