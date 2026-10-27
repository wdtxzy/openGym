// @vitest-environment happy-dom
// The leaderboard screen. What is worth pinning is the contract with the client library and
// the global coordinator: the join card cannot be pressed without the disclosure checkbox, a
// disclosure-version change shows the re-confirm card (R12), a publish failure surfaces with a
// retry (R10), a guest without public read sees the sign-in line, and a cheer carries the
// window the board was loaded with. Publishing itself is the coordinator's job and is NOT
// triggered from here — that inversion was the review's R05.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Leaderboard from './Leaderboard.jsx'
import { fetchBoard, fetchMe, joinLeaderboard, setCheer } from '../lib/leaderboard-client.js'

vi.mock('../lib/leaderboard-client.js', () => ({
  fetchBoard: vi.fn(),
  fetchMe: vi.fn(),
  joinLeaderboard: vi.fn(),
  leaveLeaderboard: vi.fn(),
  publishReport: vi.fn(),
  setCheer: vi.fn()
}))

const pub = vi.hoisted(() => {
  const state = { pending: false, lastOkAt: null, lastError: null, withdrawPending: false }
  const subs = new Set()
  return {
    state, subs,
    push: patch => { Object.assign(state, patch); for (const l of subs) l(state) },
    retryNow: vi.fn(), requestLeave: vi.fn(), invalidateMe: vi.fn(),
    resolveAmbiguousWithdraw: vi.fn(), resolveWithdrawConflict: vi.fn()
  }
})
vi.mock('../lib/leaderboard-publish.js', () => ({
  publishStatus: () => pub.state,
  onPublishStatus: l => { pub.subs.add(l); return () => pub.subs.delete(l) },
  retryNow: (...a) => pub.retryNow(...a),
  requestLeave: (...a) => pub.requestLeave(...a),
  invalidateMe: (...a) => pub.invalidateMe(...a),
  resolveAmbiguousWithdraw: (...a) => pub.resolveAmbiguousWithdraw(...a),
  resolveWithdrawConflict: (...a) => pub.resolveWithdrawConflict(...a)
}))

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => {
  const state = { S: { workouts: [], activities: [] }, user: null, config: null }
  state.snapshot = () => state
  return state
})
vi.mock('../store/useStore.js', () => {
  const useStore = selector => selector ? selector(mocks.snapshot()) : mocks.snapshot()
  useStore.getState = mocks.snapshot
  return { useStore }
})
vi.mock('../store/useUI.js', () => {
  const snap = () => ({ toast: vi.fn(), openSheet: vi.fn() })
  const useUI = selector => selector ? selector(snap()) : snap()
  useUI.getState = snap
  return { useUI }
})
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }))

let host, root
beforeEach(() => {
  vi.clearAllMocks()
  mocks.S = { workouts: [], activities: [] }
  mocks.user = null
  mocks.config = { leaderboard: { public_read: false } }
  Object.assign(pub.state, { pending: false, lastOkAt: null, lastError: null, withdrawPending: false, withdrawAmbiguous: false, withdrawConflict: false, withdrawSaved: false })
  pub.subs.clear()
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
})
const mount = () => act(() => root.render(<Leaderboard />))
const settle = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }) }
const textOf = () => host.textContent
const button = label => [...host.querySelectorAll('button')].find(b => b.textContent.includes(label))

const BOARD = {
  window: { windowType: 'week', windowKey: '2026-10-19', timezone: 'Asia/Shanghai' },
  rows: [
    { publicMemberId: 'pubA', displayName: 'Ana', emoji: '💪', rank: 1, gymMs: 3600000, syncedMs: 900000, totalMs: 4500000, gymSessions: 1, syncedSessions: 1, likeCount: 2, viewerLiked: false, dataAsOf: 1792000000000 },
    { publicMemberId: 'pubB', displayName: 'Bo', emoji: '🏋️', rank: 2, gymMs: 1800000, syncedMs: 0, totalMs: 1800000, gymSessions: 1, syncedSessions: 0, likeCount: 0, viewerLiked: false, dataAsOf: 1792000000000 }
  ]
}
const ME_JOINED = { enabled: true, suspended: false, consentVersion: 1, reportRev: 3, publicMemberId: 'pubA', displayName: 'Ana', disclosureVersion: 1, currentDisclosureVersion: 1 }

describe('Leaderboard view', () => {
  it('a switched-off instance explains instead of bouncing, and fetches nothing', async () => {
    mocks.config = null
    await mount(); await settle()
    expect(textOf()).toContain('not enabled')
    expect(fetchBoard).not.toHaveBeenCalled()
  })

  it('a joined member sees the board and their own mark; the view itself publishes nothing (R05)', async () => {
    mocks.user = { id: 'u1', name: 'Ana' }
    fetchBoard.mockResolvedValue(BOARD)
    fetchMe.mockResolvedValue(ME_JOINED)
    await mount(); await settle()
    expect(textOf()).toContain('Ana')
    expect(textOf()).toContain('You')
    expect(fetchBoard).toHaveBeenCalledWith('week')
    const { publishReport } = await import('../lib/leaderboard-client.js')
    expect(publishReport).not.toHaveBeenCalled()
  })

  it('a publish failure is shown with a retry that reaches the coordinator (R10)', async () => {
    mocks.user = { id: 'u1', name: 'Ana' }
    fetchBoard.mockResolvedValue(BOARD)
    fetchMe.mockResolvedValue(ME_JOINED)
    await mount(); await settle()
    act(() => pub.push({ lastError: 'network is down' }))
    expect(textOf()).toContain('failed')
    const retry = button('Retry')
    expect(retry).toBeTruthy()
    await act(async () => { retry.click() })
    expect(pub.retryNow).toHaveBeenCalled()
  })

  it('an accepted publish refreshes the board (R10)', async () => {
    mocks.user = { id: 'u1', name: 'Ana' }
    fetchBoard.mockResolvedValue(BOARD)
    fetchMe.mockResolvedValue(ME_JOINED)
    await mount(); await settle()
    fetchBoard.mockClear()
    act(() => pub.push({ lastOkAt: 12345, pending: false }))
    await settle()
    expect(fetchBoard).toHaveBeenCalled()
  })

  it('a stale disclosure text shows the re-confirm card instead of silently listing (R12)', async () => {
    mocks.user = { id: 'u1', name: 'Ana' }
    fetchBoard.mockResolvedValue(BOARD)
    fetchMe.mockResolvedValue({ ...ME_JOINED, disclosureVersion: 0 })
    await mount(); await settle()
    expect(textOf()).toContain('confirm to stay listed')
    const confirm = button('Confirm')
    expect(confirm.disabled).toBe(true)
    await act(async () => { host.querySelector('input[type=checkbox]').click() })
    expect(confirm.disabled).toBe(false)
    fetchMe.mockResolvedValue(ME_JOINED)
    await act(async () => { confirm.click() })
    await settle()
    // The re-confirm sends the view's own (stale) member state: the server takes the CURRENT
    // disclosure version from its own answer and the base sequence from what this device knows.
    expect(joinLeaderboard).toHaveBeenCalledWith({ ...ME_JOINED, disclosureVersion: 0 }, 'Ana')
    expect(pub.retryNow).toHaveBeenCalled()
  })

  it('the join card stays disabled until the disclosure is confirmed, then joins with the current versions', async () => {
    mocks.user = { id: 'u1', name: 'Ana' }
    fetchBoard.mockResolvedValue({ ...BOARD, rows: [] })
    fetchMe.mockResolvedValue({ enabled: false, suspended: false, consentVersion: 0, reportRev: 0, currentDisclosureVersion: 1 })
    await mount(); await settle()

    expect(textOf()).toContain('Join the leaderboard')
    const join = button('Join')
    expect(join.disabled).toBe(true)
    await act(async () => { host.querySelector('input[type=checkbox]').click() })
    expect(join.disabled).toBe(false)
    fetchMe.mockResolvedValue(ME_JOINED) // the reload after joining
    await act(async () => { join.click() })
    await settle()
    expect(joinLeaderboard).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false, currentDisclosureVersion: 1, consentVersion: 0 }),
      'Ana'
    )
    expect(pub.retryNow).toHaveBeenCalled()
  })

  it('a suspended member sees the banner and reason', async () => {
    mocks.user = { id: 'u1', name: 'Ana' }
    fetchBoard.mockResolvedValue({ ...BOARD, rows: [] })
    fetchMe.mockResolvedValue({ ...ME_JOINED, suspended: true, suspendedReason: 'checking numbers' })
    await mount(); await settle()
    expect(textOf()).toContain('Paused by an administrator')
    expect(textOf()).toContain('checking numbers')
  })

  it('a guest without public read sees the sign-in line, not an error', async () => {
    const e = new Error('not signed in'); e.status = 401
    fetchBoard.mockRejectedValue(e)
    await mount(); await settle()
    expect(textOf()).toContain('Sign in to view the leaderboard')
  })

  it('a cheer carries the window the board was loaded with, and applies the server count', async () => {
    mocks.user = { id: 'u2', name: 'Bo' }
    fetchBoard.mockResolvedValue(BOARD)
    fetchMe.mockResolvedValue({ ...ME_JOINED, publicMemberId: 'pubB' })
    setCheer.mockResolvedValue({ liked: true, likeCount: 3 })
    await mount(); await settle()

    const cheer = button('Cheer') // Ana's row — Bo's own row has none
    expect(cheer).toBeTruthy()
    await act(async () => { cheer.click() })
    await settle()
    expect(setCheer).toHaveBeenCalledWith('pubA', 'week', '2026-10-19', true)
    expect(textOf()).toContain('3')
  })

  it('leaving goes through the coordinator, so the intent survives being offline (R11)', async () => {
    mocks.user = { id: 'u1', name: 'Ana' }
    fetchBoard.mockResolvedValue(BOARD)
    fetchMe.mockResolvedValue(ME_JOINED)
    pub.requestLeave.mockResolvedValue({ ok: false })
    await mount(); await settle()
    window.confirm = () => true
    await act(async () => { button('Leave the leaderboard').click() })
    await settle()
    expect(pub.requestLeave).toHaveBeenCalledWith(ME_JOINED)
    act(() => pub.push({ withdrawPending: true, withdrawSaved: true })) // the coordinator's persisted intent
    expect(textOf()).toContain('when you are online')
  })

  it('B03: while a withdrawal is pending the join card stays closed, even when the page GET already says "out"', async () => {
    mocks.user = { id: 'u1', name: 'Ana' }
    fetchBoard.mockResolvedValue(BOARD)
    // The view's own GET shows the member OUT — without the gate this page would offer the
    // join form while the coordinator still holds the pending leave intent (O04).
    fetchMe.mockResolvedValue({ ...ME_JOINED, enabled: false })
    pub.state.withdrawPending = true
    pub.state.withdrawSaved = true
    await mount(); await settle()
    expect(textOf()).not.toContain('Join the leaderboard')
    expect(textOf()).toContain('still being confirmed')
    expect(joinLeaderboard).not.toHaveBeenCalled()
    // The coordinator's answer resolves the intent: the join card opens afterwards.
    act(() => pub.push({ withdrawPending: false }))
    await settle()
    expect(textOf()).toContain('Join the leaderboard')
  })
})
