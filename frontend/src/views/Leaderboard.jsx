// The leaderboard screen: everyone on the instance who opted in, ranked by total movement
// time over a Beijing-time week, month, or all history — the gym/synced split and both session
// counts side by side, so a walk is never mistaken for a barbell session (PRD FR-1.6R).
//
// Nothing about joining is automatic: the join card shows the numbered disclosure — including
// that the admin may later open the board to visitors, which is exactly what the member is
// agreeing may happen — and joining is a deliberate checkbox + button. Publishing rides the
// view: on open (and whenever the local facts change while it is open) the device's own report
// is rebuilt from full history and pushed once, with the client-library's single-retry
// recovery; nothing here ever blocks finishing or saving a workout.
//
// Guests (signed out) see the board only when the instance opened public read — the server
// enforces it; this screen just renders what comes back, without a viewerLiked column.
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { t, tn } from '../lib/i18n.js'
import { fmtDur } from '../lib/format.js'
import { Button } from '../components/ui.jsx'
import Icon from '../components/Icon.jsx'
import { fetchBoard, fetchMe, joinLeaderboard, leaveLeaderboard, publishReport, setCheer } from '../lib/leaderboard-client.js'

const toast = m => useUI.getState().toast(m)
const WINDOWS = [['week', 'Week'], ['month', 'Month'], ['all', 'All']]
const fmtWhen = ms => (ms ? new Date(ms).toLocaleString() : '')

/** A cheap fingerprint of the local facts: republish only when something moved. Deliberately
 *  excludes the server's reportRev — bumping it after a publish must not re-trigger one. */
const factsOf = S => JSON.stringify([
  (S.workouts || []).length, (S.workouts || []).at(-1)?.end ?? 0,
  (S.activities || []).length
])

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
  const [busy, setBusy] = useState(false)
  const published = useRef('')

  const on = !!config?.leaderboard
  const myPublicId = me?.publicMemberId

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

  // Publish on open and on local change: the report is rebuilt from full history each time,
  // so a first join already includes everything recorded before it (LB-07).
  useEffect(() => {
    if (!on || !user || !me?.enabled || me?.suspended) return
    const fingerprint = factsOf(S)
    if (published.current === fingerprint) return
    published.current = fingerprint
    publishReport(S, me).then(r => {
      if (r.ok) setMe(m => ({ ...m, reportRev: r.reportRev }))
    })
  }, [on, user, me?.enabled, me?.suspended, me?.reportRev, S])

  if (!on) {
    return <div className="narrow">
      <div className="hdr"><div><h1>{t('Leaderboard')}</h1></div></div>
      <div className="card"><div className="muted">{t('The leaderboard is not enabled on this server.')}</div></div>
    </div>
  }

  async function join() {
    setBusy(true)
    try {
      await joinLeaderboard(me || { consentVersion: 0, currentDisclosureVersion: 1 }, user.name)
      const fresh = await fetchMe()
      setMe(fresh)
      published.current = '' // let the publish effect push the first report now
      await reload()
    } catch (e) { toast(e.message) }
    setBusy(false)
  }

  async function leave() {
    if (!window.confirm(t('Leave the leaderboard? Your published results are removed.'))) return
    setBusy(true)
    try {
      await leaveLeaderboard(me)
      published.current = ''
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

    {me?.suspended && <div className="card" style={{ borderColor: 'var(--danger, #c33)' }}>
      <h2 style={{ margin: 0 }}>{t('Paused by an administrator')}</h2>
      <div className="muted small" style={{ marginTop: 4 }}>{t('Your listing is paused. Your training and history are unaffected.')}</div>
      {me.suspendedReason ? <div className="small" style={{ marginTop: 6 }}>“{me.suspendedReason}”</div> : null}
    </div>}

    {user && me && !me.enabled && !me.suspended && <div className="card">
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

    {needSignin && <div className="card"><div className="muted">{t('Sign in to view the leaderboard')}</div></div>}
    {error && <div className="card"><div className="muted">{error}</div></div>}

    {board && (board.rows.length ? board.rows.map(row => (
      <div key={row.publicMemberId} className="card row between" style={{ alignItems: 'center', gap: 10 }}>
        <div className="row" style={{ gap: 10, minWidth: 0, alignItems: 'center' }}>
          <div className="muted" style={{ width: 30, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{row.rank}</div>
          <div style={{ fontSize: 22 }}>{row.emoji}</div>
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
            ? <Button size="sm" variant={row.viewerLiked ? 'tinted' : 'ghost'} disabled={busy} onClick={() => cheer(row)}>
              {t('Cheer')}{row.likeCount ? ' ' + row.likeCount : ''}
            </Button>
            : (row.likeCount ? <div className="muted small">♡ {row.likeCount}</div> : null)}
          <div className="muted" style={{ fontSize: 11 }}>{row.dataAsOf ? t('Updated {0}', fmtWhen(row.dataAsOf)) : ''}</div>
        </div>
      </div>
    )) : <div className="card"><div className="muted">{t('No one has joined yet')}</div></div>)}

    {user && me?.enabled && !me.suspended && <div className="card">
      <Button size="sm" variant="ghost" onClick={leave}>{t('Leave the leaderboard')}</Button>
    </div>}
  </div>
}
