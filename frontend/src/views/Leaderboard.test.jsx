// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { expect, it, vi } from 'vitest'
import { api } from '../lib/api.js'
import { EXIDX, isAssisted } from '../lib/exercises.js'
import Leaderboard from './Leaderboard.jsx'

vi.mock('../lib/api.js', () => ({ api: vi.fn() }))
vi.mock('../store/useStore.js', () => ({
  useStore: select => select({ user: { id: 'u_me' }, S: { unit: 'kg' } })
}))

globalThis.IS_REACT_ACT_ENVIRONMENT = true

it('opens the recap month and lets friends switch between the three standings', async () => {
  const bench = Object.values(EXIDX).find(ex => /bench press/i.test(ex.n) && !isAssisted(ex))
  const profile = { id: 'u_me', name: 'Alex', date: '2026-11-10' }
  api.mockResolvedValue({
    joined: true, notify: true, month: '2026-11', currentMonth: '2026-12', previousMonth: '2026-11',
    exercises: [{ exercise: bench.id, basis: 'logged', rows: [{ ...profile, weight: 100, reps: 3 }] }],
    heaviest: [{ ...profile, volume: 2400 }],
    consistency: [{ ...profile, weeks: 2, days: 8 }]
  })

  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const button = name => [...host.querySelectorAll('button')].find(el => el.textContent === name)
  try {
    await act(async () => root.render(
      <MemoryRouter initialEntries={['/leaderboard?month=2026-11']}><Leaderboard /></MemoryRouter>
    ))
    expect(api).toHaveBeenCalledWith('/api/leaderboard?month=2026-11')
    expect(host.textContent).toContain('Last month')
    expect(host.textContent).toContain('100 kg × 3')
    await act(async () => button('Heaviest day').click())
    expect(host.textContent).toMatch(/2,?400 kg/)
    await act(async () => button('Consistency').click())
    expect(host.textContent).toContain('2 wk')
    expect(host.textContent).toContain('Training days: 8')
    expect(host.querySelector('[role="switch"]').getAttribute('aria-checked')).toBe('true')
  } finally {
    act(() => root.unmount())
    host.remove()
  }
})
