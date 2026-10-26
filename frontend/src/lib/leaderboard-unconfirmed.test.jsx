// @vitest-environment happy-dom
// The round-8 recovery gate (J02): a 409 recovery that finds local facts the server has
// not confirmed must NOT publish them ahead of the personal save. The reproduction: the
// personal server holds rev 1 / one confirmed hour; another device's publish makes this
// device's first report answer report-stale; the recovery pulls (rev 1 / 1h confirmed);
// DURING the recovery's fresh me fetch a local edit lands (two hours, sync pending, the
// server still at rev 1) — the old client re-captured { facts: 2h, rev: 1 } and the server
// accepted it. The gate: the re-capture refuses unconfirmed facts, the publish waits for
// the personal sync, and the synced snapshot (2h, rev 2) is what finally publishes.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createSharedStore } from '../../../api/community/store.js'
import { createLeaderboard } from '../../../api/community/leaderboard.js'
import { buildReport } from './leaderboard.js'
import { syncFingerprint } from './sync-changes.js'
import { createPublisher } from './leaderboard-publish.js'
import { api } from './api.js'

vi.mock('../store/useStore.js', () => ({ useStore: { getState: () => ({}), subscribe: () => () => {} } }))
vi.mock('./api.js', () => ({ api: vi.fn() }))

const live = []
const cleanup = []
beforeEach(() => { vi.useFakeTimers(); localStorage.clear() })
afterEach(() => { live.splice(0).forEach(p => p.stop()); cleanup.splice(0).forEach(fn => fn()); vi.useRealTimers() })

it('J02: unconfirmed facts during a recovery wait for the personal sync, then publish confirmed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-j02-'))
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  const now = Date.now()
  const facts = n => ({ workouts: [{ id: 'w' + n, start: now - n * 3600000, end: now }], activities: [] })
  const confirmed = facts(1)
  let personalRev = 1
  const shared = createSharedStore({ file: path.join(dir, 'lb.json'), schemaVersion: 1, init: () => ({ members: {}, likes: {}, adminActions: [] }) })
  cleanup.push(() => shared.release())
  const lb = createLeaderboard({ store: shared, personalRevOf: () => personalRev })
  await lb.consent('a', { enabled: true, disclosureVersion: 1, baseConsentVersion: 0 })

  let state = {
    user: { id: 'a' }, S: confirmed, config: { leaderboard: {} },
    sync: { status: 'ok', lastSynced: 1, rev: 1, confirmedFp: JSON.stringify(syncFingerprint(confirmed)), server: 'https://alpha.example' }
  }
  const subs = new Set()
  const update = patch => { state = { ...state, ...patch }; for (const l of subs) l() }
  const store = { getState: () => state, subscribe: f => { subs.add(f); return () => subs.delete(f) } }
  state.pullState = vi.fn(async () => { /* the merge lands the server's confirmed copy */ })
  const sends = []
  api.mockImplementation(async (url, opts) => {
    if (url.endsWith('/me')) {
      // The SECOND me read is the recovery's fresh fetch: the local edit lands exactly
      // here, before the answer returns — the facts become unconfirmed mid-recovery.
      if (!api.meReads) api.meReads = 0
      if (++api.meReads === 2) update({ S: facts(2), sync: { ...state.sync, status: 'pending', pending: true, confirmedFp: state.sync.confirmedFp } })
      return { ...lb.me('a'), personalRev }
    }
    const body = JSON.parse(opts.body)
    if (!api.puts) api.puts = 0
    if (++api.puts === 1) {
      // Another device published the same hour first: this device's first report 409s.
      await lb.report('a', { ...buildReport(confirmed, { consentVersion: 1, baseReportRev: 0, requestId: 'other-device', now }), personalRev: 1 })
    }
    sends.push({ hours: body.lifetime.gymMs / 3600000, claimedRev: body.personalRev, syncStatus: state.sync.status })
    try { return await lb.report('a', body) } catch (e) { e.data = { error: e.code }; throw e }
  })
  const p = createPublisher({ store, storage: localStorage })
  live.push(p)
  p.start()
  update({ sync: { ...state.sync, lastSynced: 2 } })
  await vi.advanceTimersByTimeAsync(3000)

  // The unconfirmed hour was never sent: the server still holds one hour.
  expect(lb.board('all', 'a').rows[0].totalMs).toBe(3600000)
  expect(sends.every(s => s.syncStatus === 'ok')).toBe(true) // nothing left the device unconfirmed
  expect(p.publishStatus().pending).toBe(true)

  // The personal sync completes: the two hours are confirmed at rev 2 (fingerprint match).
  personalRev = 2
  update({ S: facts(2), sync: { status: 'ok', lastSynced: 3, rev: 2, confirmedFp: JSON.stringify(syncFingerprint(facts(2))), server: 'https://alpha.example' } })
  await vi.advanceTimersByTimeAsync(3000)
  await p.retryNow()
  await vi.advanceTimersByTimeAsync(3000)

  // The confirmed snapshot published: two hours, claiming rev 2.
  expect(lb.board('all', 'a').rows[0].totalMs).toBe(7200000)
  const last = sends[sends.length - 1]
  expect(last.hours).toBe(2)
  expect(last.claimedRev).toBe(2)
  expect(p.publishStatus().pending).toBe(false)
})
