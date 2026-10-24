// The leaderboard's client plumbing: the only place the app talks to the leaderboard API.
//
// Publishing is built around the three answers a healthy server can still give back: a 409
// report-stale (someone published from this account on another device — re-read the member and
// rebuild from the same local facts, never just re-send the old body with a fresh rev), a 409
// consent-stale (joined/left since — same recovery), and a 403 not-participating (the member
// left; nothing to publish). One recovery attempt, then the truth is shown — a silent retry
// loop is how a withdrawal gets undone by a phone that never heard of it.
import { api } from './api.js'
import { uid } from './format.js'
import { buildReport } from './leaderboard.js'

/** The member's own state; null when the feature is off (404) rather than an error. */
export async function fetchMe() {
  try { return await api('/api/leaderboard/me') }
  catch (e) {
    if (e.status === 404) return null
    throw e
  }
}

export async function joinLeaderboard(me, displayName) {
  return api('/api/leaderboard/consent', {
    method: 'PUT',
    body: JSON.stringify({
      enabled: true,
      disclosureVersion: me.currentDisclosureVersion,
      baseConsentVersion: me.consentVersion,
      displayName
    })
  });
}

export async function leaveLeaderboard(me) {
  return api('/api/leaderboard/consent', {
    method: 'PUT',
    body: JSON.stringify({ enabled: false, baseConsentVersion: me.consentVersion })
  });
}

export async function fetchBoard(windowType) {
  return api('/api/leaderboard?window=' + encodeURIComponent(windowType))
}

/** Set or clear a cheer for the window the board was loaded with — the server judges the
 *  period by its own clock, so an expired key answers 409 and the board simply reloads. */
export function setCheer(targetPublicId, windowType, windowKey, on) {
  if (on) {
    return api('/api/leaderboard/like', {
      method: 'PUT',
      body: JSON.stringify({ targetPublicId, windowType, windowKey })
    });
  }
  const q = `targetPublicId=${encodeURIComponent(targetPublicId)}&windowType=${encodeURIComponent(windowType)}&windowKey=${encodeURIComponent(windowKey)}`;
  return api('/api/leaderboard/like?' + q, { method: 'DELETE' });
}

/** Publish this device's facts. Returns { ok, reportRev?, acceptedAt?, reason?, error? }. */
export async function publishReport(S, me) {
  const send = (m, requestId) => api('/api/leaderboard/report', {
    method: 'PUT',
    body: JSON.stringify(buildReport(
      { workouts: S.workouts || [], activities: S.activities || [] },
      { consentVersion: m.consentVersion, baseReportRev: m.reportRev, requestId, now: Date.now() }
    ))
  });
  try {
    return { ok: true, ...(await send(me, uid())) };
  } catch (e) {
    const recoverable = e.status === 409 && (e.data?.error === 'report-stale' || e.data?.error === 'consent-stale');
    if (!recoverable) return { ok: false, error: e };
    const fresh = await fetchMe();
    if (!fresh || !fresh.enabled || fresh.suspended) return { ok: false, reason: 'disabled' };
    try {
      return { ok: true, ...(await send(fresh, uid())) };
    } catch (e2) {
      return { ok: false, error: e2 };
    }
  }
}
