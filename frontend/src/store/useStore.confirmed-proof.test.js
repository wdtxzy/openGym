// @vitest-environment happy-dom
// The round-9 confirmation proof (K04): a confirmed personal save updates the IN-MEMORY
// proof (sync.confirmedFp) from the copy the server actually accepted, regardless of
// whether the auxiliary localStorage keys can be written. The old order computed the
// fingerprint inside the same try that wrote gym_synced_at — a QuotaExceededError on the
// timestamp key skipped the update, the sync still read 'ok' with the OLD proof, and the
// publisher's snapshot gate blocked data that WAS synced from ever reaching the board.
// Real useStore and real coordinator; only the API answers and the one Storage write are
// controlled by the test.
import { expect, it, vi } from 'vitest'
import { syncFingerprint } from '../lib/sync-changes.js'

const h = vi.hoisted(() => ({ api: null }))
vi.mock('../lib/api.js', () => ({ api: (...a) => h.api(...a), setRemoteAuth: () => {} }))
vi.mock('./useUI.js', () => ({ useUI: { getState: () => ({ toast: () => {}, stopRest: () => {}, abandonWork: () => {} }) } }))

it('K04: a confirmed private save updates its memory proof even when the timestamp key cannot be written', async () => {
  let failSyncedAt = false
  let store = null
  let publisher = null
  const realSet = Storage.prototype.setItem
  const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (k, v) {
    if (failSyncedAt && k === 'gym_synced_at') throw new DOMException('quota', 'QuotaExceededError')
    return realSet.call(this, k, v)
  })
  try {
    localStorage.clear()
    localStorage.setItem('gym_owner', 'a')
    const { useStore, DEF } = await import('./useStore.js')
    store = useStore
    const facts = n => ({
      ...JSON.parse(JSON.stringify(DEF)), _ts: n * 100,
      workouts: [{ id: 'w' + n, d: '2026-10-26', start: Date.now() - n * 3600000, end: Date.now(), entries: [] }]
    })
    let rev = 0
    let privateState = null
    h.api = async (url, opts) => {
      if (url === '/api/data' && opts?.method === 'PUT') { privateState = JSON.parse(opts.body).state; return { ok: true, rev: ++rev } }
      throw new Error('unexpected ' + url)
    }
    useStore.setState({ S: facts(1), user: { id: 'a' }, ready: true, config: { leaderboard: {} }, sync: { status: 'ok', pending: false, lastSynced: 0, server: 'https://alpha.example' } })
    await useStore.getState().pushState()
    const oldProof = useStore.getState().sync.confirmedFp
    expect(oldProof).toBe(JSON.stringify(syncFingerprint(useStore.getState().S)))

    const { createPublisher } = await import('../lib/leaderboard-publish.js')
    const client = {
      fetchMe: vi.fn().mockResolvedValue({ enabled: true, suspended: false, disclosureVersion: 1, currentDisclosureVersion: 1, reportRev: 0, consentVersion: 1 }),
      publishReport: vi.fn().mockResolvedValue({ ok: true, reportRev: 1 }),
      leaveLeaderboard: vi.fn()
    }
    publisher = createPublisher({ store: useStore, client, storage: localStorage })
    publisher.start()
    await new Promise(r => setTimeout(r, 2))

    // The second save: the timestamp key refuses, the fingerprint key never gets a chance
    // in the old order — the proof must still describe the newly confirmed copy.
    failSyncedAt = true
    useStore.setState({ S: facts(2) })
    await useStore.getState().pushState()
    await publisher.retryNow()

    const st = useStore.getState()
    const expected = JSON.stringify(syncFingerprint(st.S))
    expect(st.sync.confirmedFp).toBe(expected) // the memory proof matches the confirmed copy
    expect(st.sync.status).toBe('ok')
    expect(JSON.stringify(privateState.workouts)).toBe(JSON.stringify(st.S.workouts)) // the server holds exactly this
    expect(client.publishReport.mock.calls.length).toBeGreaterThan(0) // the gate let the confirmed facts publish
    expect(publisher.publishStatus().pending).toBe(false)
  } finally {
    publisher?.stop()
    failSyncedAt = false
    store?.setState({ user: null, ready: false })
    spy.mockRestore()
    localStorage.clear()
  }
})
