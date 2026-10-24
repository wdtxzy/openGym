// @vitest-environment happy-dom
// The leaderboard screen. What is worth pinning is not markup but the contract with the client
// library and the server's answers: a first publish rides the view when joined (LB-07's client
// half — the report is the device's own facts), the join card cannot be pressed without the
// disclosure checkbox, a suspended member sees the banner and never publishes, a guest without
// public read sees the sign-in line, and a cheer carries the window the board was loaded with.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Leaderboard from './Leaderboard.jsx'
import { fetchBoard, fetchMe, joinLeaderboard, publishReport, setCheer } from '../lib/leaderboard-client.js'

vi.mock('../lib/leaderboard-client.js', () => ({
  fetchBoard: vi.fn(),
  fetchMe: vi.fn(),
  joinLeaderboard: vi.fn(),
  leaveLeaderboard: vi.fn(),
  publishReport: vi.fn(),
  setCheer: vi.fn()
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
const ME_JOINED = { enabled: true, suspended: false, consentVersion: 1, reportRev: 3, publicMemberId: 'pubA', displayName: 'Ana', currentDisclosureVersion: 1 }

describe('Leaderboard view', () => {
  it('a switched-off instance explains instead of bouncing, and fetches nothing', async () => {
    mocks.config = null
    await mount(); await settle()
    expect(textOf()).toContain('not enabled')
    expect(fetchBoard).not.toHaveBeenCalled()
  })

  it('a joined member sees the board, their own mark, and publishes their facts once', async () => {
    mocks.user = { id: 'u1', name: 'Ana' }
    fetchBoard.mockResolvedValue(BOARD)
    fetchMe.mockResolvedValue(ME_JOINED)
    publishReport.mockResolvedValue({ ok: true, reportRev: 4 })
    await mount(); await settle()

    expect(textOf()).toContain('Ana')
    expect(textOf()).toContain('You')            // the own row is marked, and has no cheer button
    expect(fetchBoard).toHaveBeenCalledWith('week')
    expect(publishReport).toHaveBeenCalledTimes(1)
    expect(publishReport.mock.calls[0][0]).toBe(mocks.S)
    expect(publishReport.mock.calls[0][1].consentVersion).toBe(1)
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
    expect(publishReport).toHaveBeenCalled() // the first report rides the enabled state
  })

  it('a suspended member sees the banner and reason, and nothing publishes', async () => {
    mocks.user = { id: 'u1', name: 'Ana' }
    fetchBoard.mockResolvedValue({ ...BOARD, rows: [] })
    fetchMe.mockResolvedValue({ ...ME_JOINED, suspended: true, suspendedReason: 'checking numbers' })
    await mount(); await settle()
    expect(textOf()).toContain('Paused by an administrator')
    expect(textOf()).toContain('checking numbers')
    expect(publishReport).not.toHaveBeenCalled()
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
    publishReport.mockResolvedValue({ ok: true })
    setCheer.mockResolvedValue({ liked: true, likeCount: 3 })
    await mount(); await settle()

    const cheer = button('Cheer') // Ana's row — Bo's own row has none
    expect(cheer).toBeTruthy()
    await act(async () => { cheer.click() })
    await settle()
    expect(setCheer).toHaveBeenCalledWith('pubA', 'week', '2026-10-19', true)
    expect(textOf()).toContain('3')
  })
})
