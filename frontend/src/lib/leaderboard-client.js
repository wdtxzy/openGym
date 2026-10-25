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
import { buildReport, fingerprintOf } from './leaderboard.js'

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

/** The member's public identity (S01/S02): display name and one of the server's emoji. */
export async function saveProfile({ displayName, emoji }) {
  return api('/api/leaderboard/profile', {
    method: 'PUT',
    body: JSON.stringify({ displayName, emoji })
  });
}

/** The admin card's member list (S05). */
export async function adminMembers() {
  return api('/api/admin/leaderboard/members');
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

/** Publish this device's facts. Returns { ok, reportRev?, acceptedFingerprint?, reason?, error? }.
 *
 *  On a stale base/consent/personal-state (another device published or synced, or the member
 *  joined/left) the PRD's rule is: merge personal state FIRST, then re-aggregate — `opts.pull`
 *  (the store's pullState) runs, and the retry is built from `opts.stateOf()` (the store's
 *  CURRENT state), never from the closure's stale copy.
 *
 *  G02: the answer names the fingerprint of the facts ACTUALLY accepted — the send may have
 *  been the merged retry, not the caller's original snapshot — so the coordinator records what
 *  the server really holds instead of guessing from the response-time store. G03: every send
 *  carries the member's `personalRev` (the personal-state revision the server reported); the
 *  server refuses the report when that no longer matches its live state, which is what closes
 *  the merge→read window where another device syncs in between. */
export async function publishReport(S, me, opts = {}) {
  const send = (facts, m, requestId) => {
    const body = buildReport(
      { workouts: facts.workouts || [], activities: facts.activities || [] },
      { consentVersion: m.consentVersion, baseReportRev: m.reportRev, requestId, now: Date.now() }
    );
    if (Number.isFinite(m.personalRev)) body.personalRev = m.personalRev;
    return api('/api/leaderboard/report', { method: 'PUT', body: JSON.stringify(body) })
      .then(out => ({ ...out, acceptedFingerprint: fingerprintOf(facts) }));
  };
  try {
    return { ok: true, ...(await send(S, me, uid())) };
  } catch (e) {
    const recoverable = e.status === 409 && (e.data?.error === 'report-stale' || e.data?.error === 'consent-stale' || e.data?.error === 'personal-stale');
    if (!recoverable) return { ok: false, error: e };
    // No source of merged facts, no retry: re-serializing the very facts that were just
    // refused is how a stale device overwrites a newer one's totals. The caller keeps the
    // publish pending and retries with a merge (the coordinator always passes both).
    if (typeof opts.stateOf !== 'function') return { ok: false, reason: 'needs-merge', error: e };
    // N03: the merge must actually land. pullState swallows its own errors, so the wrapper
    // answers true/false; a false (failed, offline, or held for adoption) leaves the publish
    // pending instead of re-sending the same outdated facts under a fresh revision.
    if (typeof opts.pull === 'function') {
      let merged = true;
      try { merged = await opts.pull() } catch { merged = false }
      if (merged === false) return { ok: false, reason: 'merge-failed', error: e };
    }
    const fresh = await fetchMe();
    if (!fresh || !fresh.enabled || fresh.suspended) return { ok: false, reason: 'disabled' };
    const facts = opts.stateOf();
    // N04: the account switched mid-recovery — the store no longer belongs to the publish.
    if (!facts) return { ok: false, reason: 'account-switched', error: e };
    try {
      return { ok: true, ...(await send(facts, fresh, uid())) };
    } catch (e2) {
      return { ok: false, error: e2 };
    }
  }
}
