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

/** Publish a snapshot of this device's confirmed facts. Returns { ok, reportRev?,
 *  acceptedFingerprint?, acceptedRev?, reason?, error? }.
 *
 *  I02: the facts and the personal-state revision they were confirmed at travel together in
 *  ONE snapshot — { facts, rev } captured in the same read. A report never borrows the
 *  freshest me.personalRev to label older facts (the first publish of a phone whose account
 *  was synced ahead by another device would otherwise claim a pairing its facts do not
 *  have), and a 409 recovery re-captures the WHOLE snapshot after the merge
 *  (opts.snapshotOf), so the retry's facts and its revision can never come from different
 *  moments. On a stale base/consent/personal-state the PRD's rule is unchanged: merge
 *  personal state FIRST (opts.pull), then rebuild — never re-serialize the refused facts
 *  under a fresh revision.
 *
 *  G02: the answer names the fingerprint of the facts ACTUALLY accepted — the send may have
 *  been the merged retry, not the caller's original snapshot — plus the revision that
 *  pairing claimed (acceptedRev), so the coordinator records exactly what the server holds. */
export async function publishReport(snapshot, me, opts = {}) {
  const send = (snap, m, requestId) => {
    const body = buildReport(
      { workouts: snap.facts.workouts || [], activities: snap.facts.activities || [] },
      { consentVersion: m.consentVersion, baseReportRev: m.reportRev, requestId, now: Date.now() }
    );
    // The pairing is the snapshot's own rev, or nothing (a pre-pairing client): the newest
    // me label is never attached to facts it was not captured with.
    if (Number.isFinite(snap.rev)) body.personalRev = snap.rev;
    return api('/api/leaderboard/report', { method: 'PUT', body: JSON.stringify(body) })
      .then(out => ({ ...out, acceptedFingerprint: fingerprintOf(snap.facts), acceptedRev: snap.rev }));
  };
  try {
    return { ok: true, ...(await send(snapshot, me, uid())) };
  } catch (e) {
    const recoverable = e.status === 409 && (e.data?.error === 'report-stale' || e.data?.error === 'consent-stale' || e.data?.error === 'personal-stale');
    if (!recoverable) return { ok: false, error: e };
    // No source of merged facts, no retry: re-serializing the very facts that were just
    // refused is how a stale device overwrites a newer one's totals.
    if (typeof opts.snapshotOf !== 'function') return { ok: false, reason: 'needs-merge', error: e };
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
    const snap = opts.snapshotOf(); // facts and rev, re-captured together — or null on a switch
    if (!snap) return { ok: false, reason: 'account-switched', error: e };
    try {
      return { ok: true, ...(await send(snap, fresh, uid())) };
    } catch (e2) {
      return { ok: false, error: e2 };
    }
  }
}
