// @vitest-environment happy-dom
// The round-7 pairing integration (I02): the REAL publisher, the REAL client and the REAL
// domain together, with only the fetch layer mocked — the way the review reproduced both
// failures. (1) A second confirmed personal sync must be able to publish its updated totals:
// the session's credential moves with the sync, so a normal continuous-use path never wedges
// into an endless personal-stale loop. (2) A first publish must never borrow me.personalRev
// to label older confirmed facts: another device syncing the personal state ahead (without
// publishing anything) does not make the local rev-1 hour claimable as rev 2.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createSharedStore } from '../../../api/community/store.js'
import { createLeaderboard } from '../../../api/community/leaderboard.js'
import { createPublisher } from './leaderboard-publish.js'
import { api } from './api.js'

vi.mock('../store/useStore.js', () => ({ useStore: { getState: () => ({}), subscribe: () => () => {} } }))
vi.mock('./api.js', () => ({ api: vi.fn() }))

const live = []
const cleanup = []

afterEach(() => { live.splice(0).forEach(p => p.stop()); cleanup.splice(0).forEach(fn => fn()) })

beforeEach(() => { vi.useFakeTimers(); localStorage.clear() })

/** A real domain over a real shared file, a real client whose api() talks to that domain. */
function world() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-pairing-'))
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  let personalRev = 1
  let serverFacts = null
  const shared = createSharedStore({ file: path.join(dir, 'lb.json'), schemaVersion: 1, init: () => ({ members: {}, likes: {}, adminActions: [] }) })
  cleanup.push(() => shared.release())
  const lb = createLeaderboard({ store: shared, personalRevOf: () => personalRev })
  return { lb, shared, get personalRev() { return personalRev }, set personalRev(v) { personalRev = v }, get serverFacts() { return serverFacts }, set serverFacts(v) { serverFacts = v } }
}

function publisherOver(w) {
  let state = {
    user: { id: 'a' }, S: w.serverFacts, config: { leaderboard: {} },
    sync: { status: 'ok', lastSynced: 1, rev: 1, server: 'https://alpha.example' }
  }
  const subs = new Set()
  const store = { getState: () => state, subscribe: f => { subs.add(f); return () => subs.delete(f) } }
  const update = patch => { state = { ...state, ...patch }; for (const f of subs) f() }
  state.pullState = vi.fn(async () => { update({ S: w.serverFacts, sync: { ...state.sync, rev: w.personalRev, lastSynced: state.sync.lastSynced + 1 } }) })
  api.mockImplementation(async (url, opts) => {
    if (url.endsWith('/me')) return { ...w.lb.me('a'), personalRev: w.personalRev }
    const body = JSON.parse(opts.body)
    try { return await w.lb.report('a', body) } catch (e) { e.data = { error: e.code }; throw e }
  })
  const p = createPublisher({ store, storage: localStorage })
  live.push(p)
  p.start()
  return { p, getState: () => state, update }
}

it('I02: a second confirmed private sync can publish its updated totals', async () => {
  const now = Date.now()
  const facts = n => ({ workouts: [{ id: 'w' + n, start: now - n * 3600000, end: now }], activities: [] })
  const w = world(); w.serverFacts = facts(1)
  const h = publisherOver(w)
  api.mockImplementation(async (url, opts) => {
    if (url.endsWith('/me')) return { ...w.lb.me('a'), personalRev: w.personalRev }
    const body = JSON.parse(opts.body)
    try { return await w.lb.report('a', body) } catch (e) { e.data = { error: e.code }; throw e }
  })
  await w.lb.consent('a', { enabled: true, disclosureVersion: 1, baseConsentVersion: 0 })
  h.update({ sync: { ...h.getState().sync, lastSynced: 2 } })
  await vi.advanceTimersByTimeAsync(3000)
  expect(w.lb.board('all', 'a').rows[0].totalMs).toBe(3600000) // the first hour is published

  // A perfectly normal later sync: the personal state moves to rev 2 with new facts.
  w.personalRev = 2
  w.serverFacts = facts(2)
  h.update({ S: w.serverFacts, sync: { ...h.getState().sync, rev: 2, lastSynced: 3 } })
  await vi.advanceTimersByTimeAsync(6000)
  await h.p.retryNow()
  await vi.advanceTimersByTimeAsync(3000)

  const total = w.lb.board('all', 'a').rows[0].totalMs
  expect(total).toBe(7200000) // the second hour publishes — no personal-stale wedge
  expect(h.p.publishStatus().pending).toBe(false)
  expect(h.p.publishStatus().lastError).toBe(null)
})

it('I02: the first report cannot borrow me.personalRev for older confirmed facts', async () => {
  const now = Date.now()
  const facts = n => ({ workouts: [{ id: 'w' + n, start: now - n * 3600000, end: now }], activities: [] })
  const w = world(); w.serverFacts = facts(1)
  const sent = []
  const h = publisherOver(w)
  api.mockImplementation(async (url, opts) => {
    if (url.endsWith('/me')) return { ...w.lb.me('a'), personalRev: w.personalRev }
    const body = JSON.parse(opts.body)
    sent.push({ localRev: h.getState().sync.rev, claimedRev: body.personalRev, hours: body.lifetime.gymMs / 3600000 })
    try { return await w.lb.report('a', body) } catch (e) { e.data = { error: e.code }; throw e }
  })
  await w.lb.consent('a', { enabled: true, disclosureVersion: 1, baseConsentVersion: 0 })
  h.update({ sync: { ...h.getState().sync, lastSynced: 2 } })
  // This phone confirmed rev 1. Another device syncs rev 2 (a newer personal document,
  // facts(2)) BEFORE the first /me — without publishing a leaderboard report (reportRev
  // is still zero).
  w.personalRev = 2
  w.serverFacts = facts(2)
  await vi.advanceTimersByTimeAsync(3000)

  // Every send claims the rev its own facts were confirmed at: the first is refused
  // (personal-stale), the recovery merges and re-captures facts+rev TOGETHER, and the retry
  // is the merged snapshot — never the local hour wearing the server's newest label.
  expect(sent.length).toBeGreaterThanOrEqual(1)
  expect(sent.every(s => s.localRev === s.claimedRev)).toBe(true)
  expect(w.lb.board('all', 'a').rows[0].totalMs).toBe(7200000) // the merged facts publish
})
