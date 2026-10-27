// The leaderboard screen: everyone on the instance who opted in, ranked by total movement
// time over a Beijing-time week, month, or all history — the gym/synced split and both session
// counts side by side, so a walk is never mistaken for a barbell session (PRD FR-1.6R).
//
// Publishing is NOT this page's job: the global coordinator (lib/leaderboard-publish.js) reacts
// to the personal facts wherever they change, merges before re-publishing on conflict, marks
// success only after the server accepted, and keeps failures pending and visible. The page
// shows the coordinator's status, retries on demand, and refreshes when a publish lands. A
// withdrawal goes through the coordinator too, so the intent is persisted before the request
// and survives going offline mid-way.
//
// Guests (signed out) see the board only when the instance opened public read — the server
// enforces it; this screen just renders what comes back, without a viewerLiked column. While
// the tab is visible it refreshes at most every 30 s, so a withdrawal or suspension made on
// another device disappears from an already-open page too (PRD §06).
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { t } from '../lib/i18n.js'
import { fmtDur } from '../lib/format.js'
import { Button } from '../components/ui.jsx'
import Icon from '../components/Icon.jsx'
import { fetchBoard, fetchMe, joinLeaderboard, saveProfile, setCheer } from '../lib/leaderboard-client.js'
import { invalidateMe, onPublishStatus, publishStatus, requestLeave, resolveAmbiguousWithdraw, resolveWithdrawConflict, retryNow } from '../lib/leaderboard-publish.js'
import { publishStatus as livePublishStatus } from '../lib/leaderboard-publish.js'
const toast = m => useUI.getState().toast(m)
const WINDOWS = [['week', 'Week'], ['month', 'Month'], ['all', 'All']]
const EMOJIS = ['💪', '🏋️', '🔥', '⚡', '🏃', '🚴', '🏅', '🧘']
const fmtWhen = ms => (ms ? new Date(ms).toLocaleTimeString() : '')

export default function Leaderboard() {
  const nav = useNavigate()
  const S = useStore(s => s.S)
  const user = useStore(s => s.user)
  const config = useStore(s => s.config)
  const [windowType, setWindowType] = useState('week')
  const [board, setBoard] = useState(null)
  const [me, setMe] = useState(null)
  const [error, setError] = useState('')
  const [needSignin, setNeedSignin] = useState(false)
  const [agreed, setAgreed] = useState(false)
  const [reagreed, setReagreed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [pub, setPub] = useState(publishStatus())
  const [alias, setAlias] = useState(null)     // the identity editor: null = closed
  const lastOkAt = useRef(null)

  const on = !!config?.leaderboard
  const myPublicId = me?.publicMemberId
  const disclosureStale = !!(me?.enabled && me.disclosureVersion != null && me.disclosureVersion !== me.currentDisclosureVersion)

  async function reload() {
    setError(''); setNeedSignin(false)
    try {
      setBoard(await fetchBoard(windowType))
      if (user) setMe(await fetchMe())
    } catch (e) {
      if (e.status === 401) setNeedSignin(true)
      else setError(e.message)
    }
  }

  useEffect(() => { if (on) reload() }, [on, windowType, user?.id])

  // A publish landing refreshes the board (the totals moved); the banner tracks coordinator state.
  useEffect(() => onPublishStatus(s => {
    setPub({ ...s })
    if (s.lastOkAt && s.lastOkAt !== lastOkAt.current) {
      lastOkAt.current = s.lastOkAt
      if (!s.pending) reload()
    }
  }), [])

  // While the tab is visible, what other devices changed shows up within 30 s (PRD §06).
  useEffect(() => {
    const tick = () => { if (document.visibilityState === 'visible') reload() }
    const iv = setInterval(tick, 30000)
    document.addEventListener('visibilitychange', tick)
    return () => { clearInterval(iv); document.removeEventListener('visibilitychange', tick) }
  }, [windowType, user?.id])

  if (!on) {
    return <div className="narrow">
      <div className="hdr"><div><h1>{t('Leaderboard')}</h1></div></div>
      <div className="card"><div className="muted">{t('The leaderboard is not enabled on this server.')}</div></div>
    </div>
  }

  async function join() {
    // O04/B03: the command entry re-checks the effective intent — a pending withdrawal is
    // retried, never overridden by a join that the page's own (possibly stale) GET invited.
    if (livePublishStatus().withdrawPending) { toast(t('Finish the pending withdrawal first.')); return }
    setBusy(true)
    try {
      await joinLeaderboard(me || { consentVersion: 0, currentDisclosureVersion: 1 }, user.name)
      invalidateMe()
      await reload()
      retryNow() // the first report of a fresh join goes out now, not at the next change
    } catch (e) { toast(e.message) }
    setBusy(false)
  }

  async function reconfirm() {
    // R03/B03: the disclosure re-confirm authorizes participation just like Join — the
    // same real-time withdrawal gate applies at the command entry, not only in the render.
    if (livePublishStatus().withdrawPending) { toast(t('Finish the pending withdrawal first.')); return }
    setBusy(true)
    try {
      await joinLeaderboard(me, user.name) // the same call: current disclosure + the member's seq
      invalidateMe()
      await reload()
      retryNow()
    } catch (e) { toast(e.message) }
    setBusy(false)
  }

  async function leave() {
    if (!window.confirm(t('Leave the leaderboard? Your published results are removed.'))) return
    setBusy(true)
    const r = await requestLeave(me)
    if (r.ok) await reload()
    // R02: the toast derives from the same saved fact as the persistent banner — a
    // memory-only decision (storage refused the mark) is never announced as "Saved".
    else toast(t(r.saved ? 'Saved. We will finish leaving the leaderboard when you are online.' : 'The leave request was not saved reliably'))
    setBusy(false)
  }

  async function saveIdentity() {
    setBusy(true)
    try {
      await saveProfile(alias)
      setAlias(null)
      invalidateMe()
      await reload()
    } catch (e) { toast(e.message) }
    setBusy(false)
  }

  async function cheer(row) {
    try {
      const r = await setCheer(row.publicMemberId, windowType, board.window.windowKey, !row.viewerLiked)
      // Optimistic-free: the server's likeCount is the truth, applied to the row in place.
      setBoard(b => ({ ...b, rows: b.rows.map(x => x.publicMemberId === row.publicMemberId ? { ...x, viewerLiked: r.liked, likeCount: r.likeCount } : x) }))
    } catch (e) {
      toast(e.message)
      if (e.status === 409) reload() // the period rolled over mid-scroll
    }
  }

  return <div className="narrow">
    <div className="hdr"><div><h1>{t('Leaderboard')}</h1><div className="sub">{t('Weeks run Monday to Sunday, Beijing time.')}</div></div>
      <button className="iconbtn" onClick={reload} aria-label={t('Refresh')}><Icon name="flame" /></button></div>

    <div className="card row" style={{ gap: 6, flexWrap: 'wrap' }}>
      {WINDOWS.map(([id, label]) => (
        <Button key={id} size="sm" variant={windowType === id ? 'tinted' : 'ghost'} onClick={() => setWindowType(id)}>{t(label)}</Button>
      ))}
    </div>

    {user && me?.enabled && pub.lastError && <div className="card" style={{ borderColor: 'var(--danger, #c33)' }} role="alert">
      <div className="small">{t('Publishing your totals failed. We will retry automatically.')}</div>
      <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>{String(pub.lastError).slice(0, 160)}</div>
      <div className="row" style={{ gap: 8, marginTop: 8 }}><Button size="sm" onClick={retryNow}>{t('Retry')}</Button></div>
    </div>}
    {/* G05: an ambiguous historical withdrawal waits for the person — the network cannot
        resolve whose server the old intent belonged to, so the card asks, and neither choice
        is made silently. */}
    {user && pub.withdrawAmbiguous && <div className="card" role="alert" style={{ borderColor: 'var(--danger, #c33)' }}>
      <h2 style={{ margin: 0 }}>{t('A saved leave-the-leaderboard request needs your confirmation')}</h2>
      <div className="muted small" style={{ marginTop: 4 }}>
        {t('An older version of the app saved a leave request without saying which server it was for. Until you decide, nothing is published and nothing is withdrawn.')}
      </div>
      <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <Button size="sm" disabled={busy} onClick={async () => { setBusy(true); await resolveAmbiguousWithdraw('leave', me || undefined); setBusy(false) }}>{t('It was for this server — leave it')}</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={async () => { setBusy(true); await resolveAmbiguousWithdraw('discard'); setBusy(false) }}>{t('It was for another server — discard it')}</Button>
      </div>
    </div>}
    {/* B02=A: a saved leave intent bound to an older authorization, while the server shows a
        newer join from another device — the person chooses; nothing fires without them. */}
    {user && pub.withdrawConflict && <div className="card" role="alert" style={{ borderColor: 'var(--danger, #c33)' }}>
      <h2 style={{ margin: 0 }}>{t('Your saved leave request conflicts with a newer join')}</h2>
      <div className="muted small" style={{ marginTop: 4 }}>
        {t('Another device joined the leaderboard again with a newer authorization. Your saved leave request is older than that — nothing is published and nothing is withdrawn until you choose.')}
      </div>
      <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <Button size="sm" disabled={busy} onClick={async () => { setBusy(true); await requestLeave(me || undefined); setBusy(false) }}>{t('Still leave the leaderboard')}</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={async () => { setBusy(true); await resolveWithdrawConflict(); setBusy(false) }}>{t('Keep the new join')}</Button>
      </div>
    </div>}
    {user && pub.withdrawPending && !pub.withdrawAmbiguous && !pub.withdrawConflict && !pub.withdrawSaved && <div className="card" role="alert" style={{ borderColor: 'var(--danger, #c33)' }}>
      {/* B04=A: the decision lives in memory only (storage refused the mark) — never promise
          it survives a restart; keep the warning up and offer the retry until it is saved. */}
      <h2 style={{ margin: 0 }}>{t('The leave request was not saved reliably')}</h2>
      <div className="muted small" style={{ marginTop: 4 }}>
        {t('Closing the app now may lose it. Until it is saved and the server confirms, nothing is published.')}
      </div>
      <div className="row" style={{ gap: 8, marginTop: 10 }}><Button size="sm" disabled={busy} onClick={retryNow}>{t('Retry')}</Button></div>
    </div>}
    {user && me?.enabled && pub.withdrawPending && !pub.withdrawAmbiguous && !pub.withdrawConflict && pub.withdrawSaved && <div className="card" role="status">
      <div className="small">{t('Saved. We will finish leaving the leaderboard when you are online.')}</div>
    </div>}
    {user && pub.withdrawPending && me && !me.enabled && !pub.withdrawConflict && <div className="card" role="status">
      {/* B03=A: the withdrawal is being confirmed — only the retry exists; joining again
          opens after the server confirms the exit, never beside a pending intent. */}
      <div className="small">{t('Your leave request is still being confirmed. You can join again once it finishes.')}</div>
    </div>}

    {me?.suspended && <div className="card" style={{ borderColor: 'var(--danger, #c33)' }}>
      <h2 style={{ margin: 0 }}>{t('Paused by an administrator')}</h2>
      <div className="muted small" style={{ marginTop: 4 }}>{t('Your listing is paused. Your training and history are unaffected.')}</div>
      {me.suspendedReason ? <div className="small" style={{ marginTop: 6 }}>“{me.suspendedReason}”</div> : null}
    </div>}

    {user && me && !me.enabled && !me.suspended && !pub.withdrawPending && <div className="card">
      <h2>{t('Join the leaderboard')}</h2>
      <div className="muted small" style={{ marginBottom: 8 }}>
        {t('Anyone who joins this instance sees your weekly, monthly and all-time training totals here. The administrator can also open the leaderboard to visitors — if they do, your results become visible to them too.')}
      </div>
      <label className="row" style={{ gap: 8, alignItems: 'center', marginBottom: 10 }}>
        <input type="checkbox" checked={agreed} onChange={e => setAgreed(e.target.checked)} />
        <span className="small">{t('I understand')}</span>
      </label>
      <Button disabled={!agreed || busy} onClick={join}>{t('Join')}</Button>
    </div>}

    {disclosureStale && !pub.withdrawPending && <div className="card">
      <h2>{t('The leaderboard terms changed — confirm to stay listed')}</h2>
      <div className="muted small" style={{ marginBottom: 8 }}>
        {t('Anyone who joins this instance sees your weekly, monthly and all-time training totals here. The administrator can also open the leaderboard to visitors — if they do, your results become visible to them too.')}
      </div>
      <label className="row" style={{ gap: 8, alignItems: 'center', marginBottom: 10 }}>
        <input type="checkbox" checked={reagreed} onChange={e => setReagreed(e.target.checked)} />
        <span className="small">{t('I understand')}</span>
      </label>
      <Button disabled={!reagreed || busy} onClick={reconfirm}>{t('Confirm')}</Button>
    </div>}

    {needSignin && <div className="card"><div className="muted">{t('Sign in to view the leaderboard')}</div></div>}
    {error && <div className="card"><div className="muted">{error}</div></div>}

    {board && (board.rows.length ? board.rows.map(row => (
      <div key={row.publicMemberId} className="card row between"
        style={{ alignItems: 'center', gap: 10, ...(row.publicMemberId === myPublicId ? { background: 'var(--tint, rgba(127,127,127,.12))', borderColor: 'var(--accent, #888)' } : {}) }}
        aria-label={row.publicMemberId === myPublicId ? t('You') : row.displayName || t('Anonymous lifter')}>
        <div className="row" style={{ gap: 10, minWidth: 0, alignItems: 'center' }}>
          <div className="muted" aria-label={t('Rank #{0}', row.rank)} style={{ width: 30, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{row.rank}</div>
          <div style={{ fontSize: 22 }} aria-hidden="true">{row.emoji}</div>
          <div style={{ minWidth: 0 }}>
            <div>{row.displayName || t('Anonymous lifter')}{row.publicMemberId === myPublicId ? <span className="muted"> · {t('You')}</span> : null}</div>
            <div className="muted small">
              {t('{0} workouts · {1} activities', row.gymSessions, row.syncedSessions)}
            </div>
            <div className="muted small">{fmtDur(row.gymMs)} {t('Gym')} · {fmtDur(row.syncedMs)} {t('Activity')}</div>
          </div>
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtDur(row.totalMs)}</div>
          {user && row.publicMemberId !== myPublicId
            ? <Button size="sm" variant={row.viewerLiked ? 'tinted' : 'ghost'} disabled={busy}
              aria-label={row.viewerLiked ? t('Remove your cheer for {0}', row.displayName || t('Anonymous lifter')) : t('Cheer {0}', row.displayName || t('Anonymous lifter'))}
              onClick={() => cheer(row)}>
              {t('Cheer')}{row.likeCount ? ' ' + row.likeCount : ''}
            </Button>
            : (row.likeCount ? <div className="muted small" aria-label={t('{0} cheers', row.likeCount)}>♡ {row.likeCount}</div> : null)}
          <div className="muted" style={{ fontSize: 11 }}>{row.dataAsOf ? t('Updated {0}', fmtWhen(row.dataAsOf)) : ''}</div>
        </div>
      </div>
    )) : <div className="card"><div className="muted">{t('No one has joined yet')}</div></div>)}

    {user && me?.enabled && !me.suspended && !disclosureStale && (alias === null
      ? <div className="card row between" style={{ alignItems: 'center', gap: 10 }}>
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 20 }}>{me.emoji}</span>
          <span>{me.displayName || t('Anonymous lifter')}</span>
        </div>
        <Button size="sm" variant="ghost" onClick={() => setAlias({ displayName: me.displayName || '', emoji: me.emoji || '💪' })}>{t('Edit')}</Button>
      </div>
      : <div className="card">
        <h2>{t('Your public name')}</h2>
        <div className="muted small" style={{ marginBottom: 8 }}>{t('This is what others see next to your totals.')}</div>
        <input value={alias.displayName} maxLength={40} style={{ width: '100%', marginBottom: 10 }}
          aria-label={t('Your public name')} onChange={e => setAlias({ ...alias, displayName: e.target.value })} />
        <div className="muted small" style={{ marginBottom: 6 }}>{t('Pick your emoji')}</div>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
          {EMOJIS.map(e => (
            <button key={e} className="chip" aria-label={e} aria-pressed={alias.emoji === e}
              style={{ fontSize: 18, borderColor: alias.emoji === e ? 'var(--accent, #888)' : undefined }}
              onClick={() => setAlias({ ...alias, emoji: e })}>{e}</button>
          ))}
        </div>
        <div className="row" style={{ gap: 8 }}>
          <Button disabled={busy} onClick={saveIdentity}>{t('Save')}</Button>
          <Button variant="ghost" disabled={busy} onClick={() => setAlias(null)}>{t('Cancel')}</Button>
        </div>
      </div>)}

    {user && me?.enabled && !me.suspended && !disclosureStale && <div className="card">
      <Button size="sm" variant="ghost" onClick={leave}>{t('Leave the leaderboard')}</Button>
    </div>}
  </div>
}

/** The Settings page's leaderboard section (S03): participation status straight from the
 *  server, the public identity as it stands, and the way in. Lives here so the status and the
 *  board it describes are one screen's worth of code, not two sources of truth. */
export function LeaderboardSettings() {
  const nav = useNavigate()
  const user = useStore(s => s.user)
  const [me, setMe] = useState(undefined) // undefined = asking, null = feature off
  useEffect(() => {
    if (!user) { setMe(null); return }
    let live = true
    fetchMe().then(m => { if (live) setMe(m) }).catch(() => { if (live) setMe(null) })
    return () => { live = false }
  }, [user?.id])

  const status = me?.suspended ? t('Paused by an administrator')
    : me?.enabled ? (me.disclosureVersion != null && me.disclosureVersion !== me.currentDisclosureVersion
        ? t('The leaderboard terms changed — confirm to stay listed') : t('Participating'))
    : t('Not participating')

  return <>
    <div className="card">
      <h2 style={{ margin: 0 }}>{t('Leaderboard')}</h2>
      <div className="muted small" style={{ marginTop: 4 }}>
        {t('Anyone who joins this instance sees your weekly, monthly and all-time training totals here. The administrator can also open the leaderboard to visitors — if they do, your results become visible to them too.')}
      </div>
      <div className="row" style={{ gap: 8, marginTop: 10, alignItems: 'center' }}>
        {me?.enabled && <span style={{ fontSize: 20 }}>{me.emoji || '💪'}</span>}
        <span>{status}</span>
      </div>
    </div>
    <div className="card">
      <Button onClick={() => nav('/leaderboard')}>{t('Open the leaderboard')}</Button>
    </div>
  </>
}
