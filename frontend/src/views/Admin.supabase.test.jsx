// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import Admin from './Admin.jsx'

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  confirm: vi.fn(),
  coach: vi.fn(),
  community: vi.fn(),
  oidc: vi.fn(),
}))

vi.mock('../lib/supabase.js', () => ({ SUPABASE: true }))
vi.mock('../lib/api.js', () => ({ api: mocks.api }))
vi.mock('../store/useStore.js', () => ({
  useStore: select => select({ user: { id: 'owner', admin: true } }),
}))
vi.mock('../store/useUI.js', () => ({ useUI: select => select({ toast: vi.fn(), openSheet: vi.fn() }) }))
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn(), useLocation: () => ({ state: null }) }))
vi.mock('../sheets.jsx', () => ({ confirmSheet: mocks.confirm }))
vi.mock('./AdminCoach.jsx', () => ({ default: mocks.coach }))
vi.mock('./AdminCommunity.jsx', () => ({ default: mocks.community }))
vi.mock('../components/AdminOidc.jsx', () => ({ default: mocks.oidc }))

globalThis.IS_REACT_ACT_ENVIRONMENT = true

it('shows supported cards and lets an owner turn on invite-only sign-up', async () => {
  mocks.api.mockImplementation(async path => {
    if (path === '/api/admin/users') return { users: [{ id: 'owner', name: 'Owner', admin: true, owner: true, workouts: 0 }], data_view: true }
    if (path === '/api/admin/invites') return { invites: [] }
    if (path === '/api/admin/invite-only') return { ok: true, invite_only: true }
    if (path.startsWith('/api/admin/audit?')) return { events: [], enabled: true, total: 0, retention: {} }
    throw new Error('No route for ' + path)
  })
  const host = document.createElement('div')
  const root = createRoot(host)
  try {
    await act(async () => root.render(<Admin />))
    expect(host.textContent).toContain('Invite codes')
    expect(host.textContent).toContain('Activity log')
    expect(host.textContent).not.toContain('Training now')
    expect(mocks.coach).not.toHaveBeenCalled()
    expect(mocks.community).not.toHaveBeenCalled()
    expect(mocks.oidc).not.toHaveBeenCalled()
    const toggle = [...host.querySelectorAll('button')].find(b => b.textContent === 'Require invite codes')
    act(() => toggle.click())
    await act(async () => mocks.confirm.mock.calls[0][0].onConfirm())
    expect(mocks.api).toHaveBeenCalledWith('/api/admin/invite-only', { method: 'POST', body: '{"invite_only":true}' })
    expect(host.textContent).toContain('Sign-up is invite-only')
  } finally {
    act(() => root.unmount())
  }
})
