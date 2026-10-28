// @vitest-environment happy-dom
// Round 15's three P2s, pinned from the reviewer's own reproductions.
//
// S01 — a history confirmation that fails on the network used to throw
//       `ReferenceError: intentId is not defined` out of resolveAmbiguousWithdraw, because its
//       failure path read a local of requestLeave. A controlled answer is the contract.
// S02 — a leave whose mark reached storage but whose request did not used to answer without
//       `saved`, so the page read undefined as false and announced "not saved reliably" over a
//       decision the banner was correctly showing as saved. One outcome shape, one fact.
// S03 — completion records were written and never read: a reload, a second tab or a fresh
//       sign-in started with an empty in-memory set, saw the mark the protocol deliberately
//       keeps, and called a finished intent outstanding again — the exit came back as a
//       pending withdrawal, or an old conflict blocked a legitimate rejoin.
//
// Every case below drives the real factory (injected store/client/clock/storage) and asserts
// the business fact — "nothing is owed", "this decision survives a restart" — not the shape of
// the storage.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPublisher } from './leaderboard-publish.js'

const ME = {
  enabled: true, suspended: false, disclosureVersion: 1, currentDisclosureVersion: 1,
  consentVersion: 1, reportRev: 0
}
const ALPHA = 'https://alpha.example'
const HERE = `lb-withdraw:${ALPHA}:a`
const UNKNOWN = 'lb-withdraw:https://older-server.example:a'
const ackLike = (storage, prefix = 'lb-withdraw-ack:') => Object.keys(storage).filter(k => k.startsWith(prefix))

/** The browser's localStorage as the factory sees it: marks are own enumerable keys. */
function makeStorage() {
  const s = {
    getItem: k => (k in s ? s[k] : null),
    setItem: (k, v) => { s[k] = String(v) },
    removeItem: k => { delete s[k] }
  }
  return s
}

function harness({ storage = makeStorage(), client } = {}) {
  const state = {
    user: { id: 'a', name: 'A' }, S: { workouts: [], activities: [] }, config: { leaderboard: {} },
    sync: { status: 'ok', server: ALPHA, lastSynced: 1 }
  }
  state.pullState = vi.fn(async () => {})
  const subs = new Set()
  const store = { getState: () => state, subscribe: f => { subs.add(f); return () => subs.delete(f) } }
  const c = client || {
    fetchMe: vi.fn(async () => ({ ...ME })),
    // Offline by default: otherwise the coordinator's own automatic retry settles every
    // pending intent during start(), and a test about "what is still owed" would be reading
    // the result of a leave nobody asked it to perform. Cases that want the leave to land
    // say so explicitly.
    leaveLeaderboard: vi.fn(async () => { throw new Error('offline') }),
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

describe('S01 — a failed history confirmation answers, it does not throw', () => {
  it('offline: controlled ok:false derived from this session, the intent still owed, retry works', async () => {
    const h = harness()
    h.storage[UNKNOWN] = JSON.stringify({ v: 3, i: 'hist-1', cv: 1 }) // no instance proof this device can show
    h.client.leaveLeaderboard.mockRejectedValue(new Error('offline'))
    h.p.start(); await tick()
    expect(h.p.publishStatus().withdrawAmbiguous).toBe(true)

    const r = await h.p.resolveAmbiguousWithdraw('leave', { ...ME })
    expect(r.ok).toBe(false)
    expect(r.error.message).toBe('offline')          // the original failure, not a ReferenceError
    expect(r.saved).toBe(true)                        // the mark is on disk: a restart keeps the decision
    expect(r.persistence).toBe('storage')
    expect(r.superseded).toBe(false)
    expect(r.target).toEqual({ uid: 'a', instance: ALPHA })
    expect(h.p.publishStatus().lastError).toBe('offline')
    expect(h.p.publishStatus().withdrawPending).toBe(true) // still owed — the gate stays closed

    // The person presses again; the same call now lands.
    h.client.leaveLeaderboard.mockResolvedValue({})
    const again = await h.p.resolveAmbiguousWithdraw('leave', { ...ME })
    expect(again.ok).toBe(true)
    expect(again.serverConfirmed).toBe(true)
    expect(h.p.publishStatus().withdrawPending).toBe(false)
    h.p.stop()
  })

  it('an answer from a session that has since been replaced is superseded, never the new one’s', async () => {
    const h = harness()
    h.storage[UNKNOWN] = JSON.stringify({ v: 3, i: 'hist-1', cv: 1 })
    let reject
    h.client.leaveLeaderboard.mockImplementation(() => new Promise((_, no) => { reject = no }))
    h.p.start(); await tick()
    const pending = h.p.resolveAmbiguousWithdraw('leave', { ...ME })
    // The account changes while the leave is on the wire.
    h.state.user = { id: 'b', name: 'B' }
    h.fire()
    reject(new Error('offline'))
    const r = await pending
    expect(r.ok).toBe(false)
    expect(r.superseded).toBe(true)
    expect(r.target).toBe(null)  // it does not name — or paint — the session that replaced it
    h.p.stop()
  })
})

describe('S02 — the button and the banner speak from the same fact', () => {
  it('saved locally, refused by the network: reported as saved (the banner already says so)', async () => {
    const h = harness()
    h.p.start(); await tick()
    h.client.leaveLeaderboard.mockRejectedValue(new Error('offline'))
    const r = await h.p.requestLeave({ ...ME })
    expect(r.ok).toBe(false)
    expect(h.p.publishStatus().withdrawSaved).toBe(true)  // what the persistent banner renders
    expect(r.saved).toBe(true)                            // what the toast must therefore say
    expect(r.persistence).toBe('storage')
    expect(r.error.message).toBe('offline')
    h.p.stop()
  })

  it('storage refused the mark: reported as memory-only, and never as durable', async () => {
    const h = harness()
    h.p.start(); await tick()
    h.client.leaveLeaderboard.mockRejectedValue(new Error('offline'))
    const realSet = h.storage.setItem
    h.storage.setItem = () => { throw new Error('quota') }
    const r = await h.p.requestLeave({ ...ME })
    expect(r.ok).toBe(false)
    expect(h.p.publishStatus().withdrawSaved).toBe(false)
    expect(r.saved).toBe(false)
    expect(r.persistence).toBe('memory')
    expect(h.p.publishStatus().withdrawPending).toBe(true) // the gate still holds, in memory
    h.storage.setItem = realSet
    h.p.stop()
  })

  it('a newer decision replaces the one in flight: that older answer is superseded', async () => {
    const h = harness()
    h.p.start(); await tick()
    let rejectFirst
    h.client.leaveLeaderboard.mockImplementationOnce(() => new Promise((_, no) => { rejectFirst = no }))
    const first = h.p.requestLeave({ ...ME })
    h.client.leaveLeaderboard.mockRejectedValue(new Error('second offline'))
    await h.p.requestLeave({ ...ME, consentVersion: 2 })  // a newer decision takes the goal
    rejectFirst(new Error('first offline'))
    const r = await first
    expect(r.ok).toBe(false)
    expect(r.superseded).toBe(true)
    expect(h.p.publishStatus().withdrawPending).toBe(true) // the NEWER decision is what is owed
    h.p.stop()
  })
})

describe('S03 — completion survives a reload, a second tab and a rejoin', () => {
  it('a confirmed exit stays finished after a restart, even though the mark stays on disk', async () => {
    const storage = makeStorage()
    const h = harness({ storage })
    h.client.leaveLeaderboard.mockResolvedValue({})
    h.p.start(); await tick()
    const r = await h.p.requestLeave({ ...ME })
    expect(r.ok).toBe(true)
    expect(r.persistence).toBe('storage')            // the completion record reached storage
    expect(h.p.publishStatus().withdrawPending).toBe(false)
    // The v3 mark is protocol evidence and is KEPT: the outstanding state must come from the
    // completion record, never from the mark's absence.
    expect(Object.keys(storage)).toContain(HERE)
    expect(ackLike(storage)).toHaveLength(1)
    h.p.stop()

    const reopened = harness({ storage })
    reopened.p.start(); await tick()
    expect(reopened.p.publishStatus().withdrawPending).toBe(false)
    expect(reopened.p.publishStatus().withdrawConflict).toBe(false)
    reopened.p.stop()
  })

  it('a legitimate rejoin after a confirmed exit is not blocked by the old intent', async () => {
    const storage = makeStorage()
    const first = harness({ storage })
    first.client.leaveLeaderboard.mockResolvedValue({})
    first.p.start(); await tick()
    await first.p.requestLeave({ ...ME })   // exit at consentVersion 1
    first.p.stop()

    // Same account, same device, now joined again with a NEWER authorization (cv 3).
    const again = harness({ storage })
    again.client.fetchMe.mockResolvedValue({ ...ME, enabled: true, consentVersion: 3 })
    again.p.start(); await tick()
    expect(again.p.publishStatus().withdrawPending).toBe(false)
    expect(again.p.publishStatus().withdrawConflict).toBe(false) // the old cv1 intent cannot resurrect it
    // …and the fresh participation publishes normally instead of being permanently gated.
    again.merged(); await vi.advanceTimersByTimeAsync(3000) // the publish pass is debounced
    expect(again.client.publishReport).toHaveBeenCalled()
    again.p.stop()
  })

  it('a second tab sees the first tab’s completion without restarting', async () => {
    const storage = makeStorage()
    const a = harness({ storage })
    a.p.start(); await tick()
    a.client.leaveLeaderboard.mockRejectedValue(new Error('offline'))
    await a.p.requestLeave({ ...ME })
    expect(a.p.publishStatus().withdrawPending).toBe(true)

    const b = harness({ storage })
    b.p.start(); await tick()
    expect(b.p.publishStatus().withdrawPending).toBe(true) // same storage, same pending decision

    a.client.leaveLeaderboard.mockResolvedValue({})
    await a.p.retryNow(); await tick()
    expect(a.p.publishStatus().withdrawPending).toBe(false)

    // The sibling's write arrives as a storage event — the only same-origin signal there is.
    const ackKey = ackLike(storage)[0]
    window.dispatchEvent(Object.assign(new Event('storage'), { key: ackKey }))
    expect(b.p.publishStatus().withdrawPending).toBe(false)
    a.p.stop(); b.p.stop()
  })

  it('a conflict resolved by a Keep does not come back on the next session', async () => {
    const storage = makeStorage()
    storage[HERE] = JSON.stringify({ v: 3, i: 'old-intent', cv: 1 })
    const h = harness({ storage })
    h.client.fetchMe.mockResolvedValue({ ...ME, consentVersion: 2 }) // another device joined again
    h.p.start(); await tick()
    h.p.retryNow(); await tick()
    expect(h.p.publishStatus().withdrawConflict).toBe(true)
    await h.p.resolveWithdrawConflict()
    expect(h.p.publishStatus().withdrawConflict).toBe(false)
    h.p.stop()

    const reopened = harness({ storage })
    reopened.p.start(); await tick()
    expect(reopened.p.publishStatus().withdrawConflict).toBe(false)
    reopened.p.stop()
  })

  it('a completion storage refused is not claimed across a restart', async () => {
    const storage = makeStorage()
    const realSet = storage.setItem
    storage.setItem = (k, v) => { if (k.startsWith('lb-withdraw-ack')) throw new Error('quota'); realSet(k, v) }
    const h = harness({ storage })
    h.client.leaveLeaderboard.mockResolvedValue({}) // the server confirms…
    h.p.start(); await tick()
    const r = await h.p.requestLeave({ ...ME })
    expect(r.ok).toBe(true)
    expect(r.persistence).toBe('memory') // honest: this session knows, the disk does not
    expect(r.saved).toBe(false)
    expect(h.p.publishStatus().withdrawPending).toBe(false) // settled here
    h.p.stop()

    // A restart re-runs the idempotent leave rather than pretending it was durable.
    storage.setItem = realSet
    const reopened = harness({ storage })
    reopened.p.start(); await tick()
    expect(reopened.client.leaveLeaderboard).toHaveBeenCalled() // the leave is attempted again…
    expect(reopened.p.publishStatus().withdrawPending).toBe(true) // …and while offline it stays owed
    reopened.p.stop()
  })
})

describe('S03 — a completion is bound to one account and one instance', () => {
  it('a record written for another instance never completes this one', async () => {
    const storage = makeStorage()
    storage[HERE] = JSON.stringify({ v: 3, i: 'same-id', cv: 1 })
    storage[`lb-withdraw-ack:https://beta.example:a:same-id`] = JSON.stringify({ v: 2, i: 'same-id', uid: 'a', instance: 'https://beta.example' })
    const h = harness({ storage })
    h.p.start(); await tick()
    expect(h.p.publishStatus().withdrawPending).toBe(true) // same id, different server: still owed
    h.p.stop()
  })

  it('a corrupt or foreign-version record is not a reliable completion', async () => {
    const storage = makeStorage()
    storage[HERE] = JSON.stringify({ v: 3, i: 'i1', cv: 1 })
    storage[`lb-withdraw-ack:${ALPHA}:a:i1`] = 'not json'
    const h = harness({ storage })
    h.p.start(); await tick()
    expect(h.p.publishStatus().withdrawPending).toBe(true)

    storage[`lb-withdraw-ack:${ALPHA}:a:i1`] = JSON.stringify({ v: 1, i: 'i1', at: 1 }) // wrong version at the v2 key
    h.p.stop()
    const again = harness({ storage })
    again.p.start(); await tick()
    expect(again.p.publishStatus().withdrawPending).toBe(true)
    again.p.stop()
  })

  it('an unreadable completion record keeps the intent pending — never a silent success', async () => {
    const storage = makeStorage()
    storage[HERE] = JSON.stringify({ v: 3, i: 'i1', cv: 1 })
    storage[`lb-withdraw-ack:${ALPHA}:a:i1`] = JSON.stringify({ v: 2, i: 'i1', uid: 'a', instance: ALPHA })
    const realGet = storage.getItem
    storage.getItem = k => { if (k.startsWith('lb-withdraw-ack')) throw new Error('io'); return realGet(k) }
    const h = harness({ storage })
    h.p.start(); await tick()
    expect(h.p.publishStatus().withdrawPending).toBe(true)
    h.p.stop()
  })

  it('a legacy record migrates only where the still-present mark proves which instance it was', async () => {
    const storage = makeStorage()
    storage[HERE] = JSON.stringify({ v: 3, i: 'proof-id', cv: 1 })
    storage['lb-withdraw-ack:a:proof-id'] = JSON.stringify({ v: 1, i: 'proof-id', at: 1 })
    const h = harness({ storage })
    h.p.start(); await tick()
    expect(h.p.publishStatus().withdrawPending).toBe(false)          // proven: honoured
    expect(storage[`lb-withdraw-ack:${ALPHA}:a:proof-id`]).toBeTruthy() // and migrated for good
    h.p.stop()
  })

  it('a legacy record nothing can attribute is left alone and completes nothing', async () => {
    const storage = makeStorage()
    storage[HERE] = JSON.stringify({ v: 3, i: 'current-id', cv: 1 })
    storage['lb-withdraw-ack:a:some-other-id'] = JSON.stringify({ v: 1, i: 'some-other-id', at: 1 })
    const h = harness({ storage })
    h.p.start(); await tick()
    expect(h.p.publishStatus().withdrawPending).toBe(true)
    expect(storage['lb-withdraw-ack:a:some-other-id']).toBeTruthy() // kept for an operator, not deleted
    h.p.stop()
  })
})
