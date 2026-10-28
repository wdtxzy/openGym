// @vitest-environment happy-dom
// Round 16's two confirmations, pinned from the reviewer's own reproductions.
//
// T01 — replacing a pending leave wrote a durable completion record for the OLD intent
//       before the new mark was saved and before any server answer. One failed mark write
//       then left "the old intent is done" on disk while the new decision existed only in
//       that tab: a sibling tab released its block and published the very hour the person
//       was withdrawing. Replacement is not completion.
// T02 — a confirmed leave whose completion record the store refused answered `ok: true`
//       with persistence 'memory', and the page only reloaded: a plain "Join" card, no
//       hint that a reload would ask for the same leave again. The outcome now carries the
//       fact, the banner shows it, and the retry rewrites the SAME record (never a second
//       leave).
//
// Both drive the real factory and assert business facts — who is allowed to publish, what
// the server ended up holding, what a reload sees — not the shape of storage.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPublisher } from './leaderboard-publish.js'

const ME = {
  enabled: true, suspended: false, disclosureVersion: 1, currentDisclosureVersion: 1,
  consentVersion: 1, reportRev: 0
}
const ALPHA = 'https://alpha.example'
const HERE = `lb-withdraw:${ALPHA}:a`
const ackOf = (storage, id) => Object.keys(storage).filter(k => k.startsWith('lb-withdraw-ack:') && k.endsWith(`:${id}`))

/** The browser's localStorage as the factory sees it; `failNext` arms one refused write. */
function makeStorage() {
  const s = {
    failMark: 0,
    failAck: 0,
    getItem: k => (k in s ? s[k] : null),
    setItem: (k, v) => {
      if (k.startsWith('lb-withdraw-ack:') && s.failAck > 0) { s.failAck--; throw new Error('QuotaExceededError') }
      if (k.startsWith('lb-withdraw:') && s.failMark > 0) { s.failMark--; throw new Error('QuotaExceededError') }
      s[k] = String(v)
    },
    removeItem: k => { delete s[k] }
  }
  return s
}

function harness({ storage, client } = {}) {
  const state = {
    user: { id: 'a', name: 'A' }, S: { workouts: [], activities: [] }, config: { leaderboard: {} },
    sync: { status: 'ok', server: ALPHA, lastSynced: 1 }
  }
  state.pullState = vi.fn(async () => {})
  const subs = new Set()
  const store = { getState: () => state, subscribe: f => { subs.add(f); return () => subs.delete(f) } }
  const c = client || {
    fetchMe: vi.fn(async () => ({ ...ME })),
    leaveLeaderboard: vi.fn(async () => ({})),
    publishReport: vi.fn(async () => ({ ok: true, reportRev: 1, acceptedFingerprint: 'x' }))
  }
  const p = createPublisher({ store, client: c, clock: () => 1000, storage })
  const fire = () => { for (const f of subs) f() }
  /** This session's own confirmed personal exchange — what opens its publish gate. */
  const merged = () => { state.sync = { ...state.sync, lastSynced: state.sync.lastSynced + 1 }; fire() }
  return { state, client: c, storage, p, fire, merged }
}

const tick = async () => { await vi.advanceTimersByTimeAsync(10) }

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('T01 — a replaced leave is abandoned, never declared complete', () => {
  it('a replacement whose mark write failed leaves the old mark outstanding for every reader', async () => {
    const storage = makeStorage()
    // Tab A: one leave, saved but never delivered (offline before the server).
    const a = harness({ storage })
    a.client.leaveLeaderboard.mockRejectedValue(new Error('offline'))
    a.p.start(); await tick()
    const first = await a.p.requestLeave({ ...ME })
    expect(first.ok).toBe(false)
    expect(first.persistence).toBe('storage')          // the mark IS on disk — the tab is honest
    const oldId = JSON.parse(storage[HERE]).i

    // Tab B shares the same storage and correctly blocks on that mark.
    const b = harness({ storage })
    b.client.leaveLeaderboard.mockRejectedValue(new Error('offline'))
    b.p.start(); await tick()
    expect(b.p.publishStatus().withdrawPending).toBe(true)

    // Tab A asks again, and THIS time the new mark cannot be written.
    storage.failMark = 1
    const second = await a.p.requestLeave({ ...ME })
    expect(second.ok).toBe(false)
    expect(second.persistence).toBe('memory')          // the new decision lives in this tab only
    expect(a.p.publishStatus().withdrawSaved).toBe(false)

    // The replacement wrote NO durable completion for the old intent — that claim is what
    // released a sibling tab in the reviewer's reproduction.
    expect(ackOf(storage, oldId)).toEqual([])
    expect(JSON.parse(storage[HERE]).i).toBe(oldId)    // the old mark is still the only evidence

    // A sibling tab told about the writes must keep blocking and must not publish.
    window.dispatchEvent(Object.assign(new Event('storage'), { key: HERE }))
    b.merged(); await tick()
    expect(b.p.publishStatus().withdrawPending).toBe(true)
    expect(b.client.publishReport).not.toHaveBeenCalled()

    a.p.stop(); b.p.stop()
  })

  it('the normal path still resolves: a saved replacement and a confirmed exit owe nothing', async () => {
    const storage = makeStorage()
    const a = harness({ storage })
    a.client.leaveLeaderboard.mockRejectedValue(new Error('offline'))
    a.p.start(); await tick()
    await a.p.requestLeave({ ...ME })                  // intent 1: saved, undelivered

    a.client.leaveLeaderboard.mockResolvedValue({})
    const r = await a.p.requestLeave({ ...ME })        // intent 2: saved AND confirmed
    expect(r.ok).toBe(true)
    expect(r.persistence).toBe('storage')
    expect(a.p.publishStatus().withdrawPending).toBe(false)

    // A reload (a fresh publisher on the same storage) owes nothing: no ghost intent.
    const again = harness({ storage })
    again.client.leaveLeaderboard.mockRejectedValue(new Error('offline'))
    again.p.start(); await tick()
    expect(again.p.publishStatus().withdrawPending).toBe(false)
    expect(again.client.publishReport).not.toHaveBeenCalled()

    a.p.stop(); again.p.stop()
  })

  it('a confirmed exit settles the predecessor it captured, even when the new mark never saved', async () => {
    const storage = makeStorage()
    const a = harness({ storage })
    a.client.leaveLeaderboard.mockRejectedValue(new Error('offline'))
    a.p.start(); await tick()
    await a.p.requestLeave({ ...ME })
    const oldId = JSON.parse(storage[HERE]).i

    storage.failMark = 1                               // the replacement mark cannot be written
    a.client.leaveLeaderboard.mockResolvedValue({})    // …but the exit reaches the server
    const r = await a.p.requestLeave({ ...ME })
    expect(r.ok).toBe(true)
    expect(r.persistence).toBe('storage')              // the completion record landed
    // The captured mark was the OLD one (it is what was on disk when the request went out),
    // so the confirmed exit settled it — a third tab sees nothing owed.
    expect(ackOf(storage, oldId)).toHaveLength(1)
    const c = harness({ storage })
    c.p.start(); await tick()
    expect(c.p.publishStatus().withdrawPending).toBe(false)

    a.p.stop(); c.p.stop()
  })
})

describe('T02 — a completion record the device could not write is visible and retryable', () => {
  it('reports it, keeps the server fact, and lets the person retry the SAME record', async () => {
    const storage = makeStorage()
    const h = harness({ storage })
    h.p.start(); await tick()
    storage.failAck = 1                                // only the completion record is refused
    const r = await h.p.requestLeave({ ...ME })
    expect(r.ok).toBe(true)                            // the server DID confirm the exit
    expect(r.serverConfirmed).toBe(true)
    expect(r.persistence).toBe('memory')               // what this device could not do
    expect(r.saved).toBe(false)
    expect(h.p.publishStatus().withdrawPending).toBe(false)
    expect(h.p.publishStatus().completionUnsaved).toBe(true)  // the warning has something to say

    const callsBefore = h.client.leaveLeaderboard.mock.calls.length
    const retry = h.p.retryCompletions()
    expect(retry.ok).toBe(true)
    expect(retry.remaining).toBe(0)
    expect(h.p.publishStatus().completionUnsaved).toBe(false)
    // The retry wrote the record — it did NOT send another leave.
    expect(h.client.leaveLeaderboard.mock.calls.length).toBe(callsBefore)
    expect(Object.keys(storage).filter(k => k.startsWith('lb-withdraw-ack:'))).toHaveLength(1)

    // …and the reload the warning was about now owes nothing.
    const reopened = harness({ storage })
    reopened.p.start(); await tick()
    expect(reopened.p.publishStatus().withdrawPending).toBe(false)
    expect(reopened.p.publishStatus().completionUnsaved).toBe(false)

    h.p.stop(); reopened.p.stop()
  })

  it('a retry that fails again keeps the warning up instead of pretending success', async () => {
    const storage = makeStorage()
    const h = harness({ storage })
    h.p.start(); await tick()
    storage.failAck = 2
    await h.p.requestLeave({ ...ME })
    expect(h.p.publishStatus().completionUnsaved).toBe(true)
    const r = h.p.retryCompletions()
    expect(r.ok).toBe(false)
    expect(r.remaining).toBe(1)
    expect(h.p.publishStatus().completionUnsaved).toBe(true)
    // Nothing invented: still no completion record, still the same single intent on disk.
    expect(Object.keys(storage).filter(k => k.startsWith('lb-withdraw-ack:'))).toHaveLength(0)
    h.p.stop()
  })

  it('an unknown evidence writes nothing — a shared claim needs a nameable reason', async () => {
    const storage = makeStorage()
    const h = harness({ storage })
    h.p.start(); await tick()
    // "Keep the new join" is the confirmed path that builds its own evidence; a conflict
    // that was never detected has no targets, so it answers stale and writes nothing.
    const r = await h.p.resolveWithdrawConflict()
    expect(r.ok).toBe(false)
    expect(Object.keys(storage).filter(k => k.startsWith('lb-withdraw-ack:'))).toHaveLength(0)
    expect(h.p.publishStatus().completionUnsaved).toBe(false)
    h.p.stop()
  })
})
