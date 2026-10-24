/* The leaderboard's server half: participation, published reports, periodic cheers, suspension.
 *
 * State lives in leaderboard.json through community/store.js — every mutation is one
 * transaction, every read a snapshot. What this module enforces, from the PRD:
 *
 *   - Joining is a consent to a numbered disclosure text; members confirmed on an older text
 *     are hidden (not silently re-published) when the text changes. The public member id is
 *     minted once and never regenerated, so rejoining restores the same identity and the rank
 *     tie-break stays stable.
 *   - Withdrawing deletes the published days and lifetime but keeps the cheers received (they
 *     are hidden while out, restored on rejoin — Q05) and bumps the member's consent sequence,
 *     which is what makes a stale device's old report or "re-enable" answer 409 instead of
 *     quietly undoing the withdrawal (LB-04).
 *   - A report fully replaces the member's buckets inside its declared coverage; the server
 *     keeps only what the current windows can need and prunes the rest. requestId makes
 *     retries free; the same id with different content is a conflict, not an update.
 *   - An admin suspension is per-member, reasoned and idempotent by actionId, and survives
 *     withdraw/rejoin and new devices — the member row is never deleted, only emptied (Q20).
 *
 * Errors are thrown as LeaderboardError(status, code) with stable codes for the client's
 * translated lines; success values are plain objects built field by field — nothing internal
 * (uid, received-like records, raw buckets of other members) is ever serialized out. */
import crypto from 'node:crypto';
import { windowFor, rankRows, beijingDayKey, CALENDAR_VERSION } from './windows.js';

export const DISCLOSURE_VERSION = 1;
export const REPORT_SCHEMA_VERSION = 1;
export const REPORT_ALGORITHM_VERSION = 1;
export const REPORT_CALENDAR_VERSION = CALENDAR_VERSION;
export const RETAINED_DAYS = 93;

const DAY = 86400000;
const TOTALS_FIELDS = ['gymMs', 'syncedMs', 'gymSessions', 'syncedSessions'];

export class LeaderboardError extends Error {
  constructor(status, code, extra = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const isCount = v => Number.isSafeInteger(v) && v >= 0 && v <= 1000;
// A lifetime covers decades of training (Q03: all history counts) — 10 million sessions is
// beyond a century of ten-a-day, so it bounds junk without ever rejecting real history the
// way the day cap did when it was shared (R13).
const isLifetimeCount = v => Number.isSafeInteger(v) && v >= 0 && v <= 1e7;
const isMs = v => Number.isSafeInteger(v) && v >= 0 && v < 1000 * 365 * DAY; // ≤ 1000 years
// 'YYYY-MM-DD' that is a real calendar day: Date.parse normalizes Feb 30 to Mar 2, so the
// key has to survive the round trip back to itself (S09).
const isDayKey = v => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const ms = Date.parse(v + 'T00:00:00Z');
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === v;
};
const keyToMs = k => Date.parse(k + 'T00:00:00Z');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);

export function createLeaderboard({ store, now = Date.now }) {
  const memberOf = (data, uid) => data.members[uid] || null;

  function requireMember(data, uid) {
    const m = memberOf(data, uid);
    if (!m) throw new LeaderboardError(403, 'not-participating');
    return m;
  }

  /** Sum a member's buckets for a window: the stored days for week/month, lifetime for all. */
  function totalsFor(m, w) {
    if (w.windowType === 'all') return m.lifetime;
    const t = { gymMs: 0, syncedMs: 0, gymSessions: 0, syncedSessions: 0 };
    for (const [dayKey, b] of Object.entries(m.days || {})) {
      if (dayKey < w.startKey || dayKey >= w.endKey) continue;
      for (const f of TOTALS_FIELDS) t[f] += b[f] || 0;
    }
    return t;
  }

  const visible = m => m.enabled && !m.suspended && m.disclosureVersion === DISCLOSURE_VERSION;

  /** One pass over the like table for the whole board, instead of one pass per member —
   *  the difference between milliseconds and the ~11 s the per-member scan took at 500
   *  members / 100k likes (R06). */
  function likeCounts(data, w) {
    const counts = new Map();
    for (const key of Object.keys(data.likes)) {
      const parts = key.split('|');
      if (parts[2] === w.windowType && parts[3] === w.windowKey) {
        counts.set(parts[1], (counts.get(parts[1]) || 0) + 1);
      }
    }
    return counts;
  }

  /** Drop cheers whose period is over for good: nobody can see or add them any more (the
   *  server refuses expired window keys), and the PRD keeps only the current week/month and
   *  the all-time counter. Current-period and 'all' records always stay — which is what
   *  preserves the received cheers across a withdraw/rejoin (Q05). Pure: `data` is mutated. */
  function pruneLikes(data, nowMs) {
    const week = windowFor('week', nowMs).windowKey;
    const month = windowFor('month', nowMs).windowKey;
    for (const key of Object.keys(data.likes)) {
      const [actor, target, type, win] = key.split('|');
      if (type === 'week' && win < week) delete data.likes[key];
      else if (type === 'month' && win < month) delete data.likes[key];
    }
  }
  const PRUNE_AT_LIKES = 2000; // amortized: pruned inside a like transaction past this size

  return {
    DISCLOSURE_VERSION,

    /** What /api/leaderboard/me answers: the member's own state, never anyone else's. */
    me(uid) {
      const data = store.read();
      const m = memberOf(data, uid);
      return {
        enabled: !!m?.enabled,
        suspended: !!m?.suspended,
        suspendedReason: m?.suspended ? (m.suspendedReason || '') : undefined,
        disclosureVersion: m?.disclosureVersion ?? null,
        consentVersion: m?.consentSeq ?? 0,
        reportRev: m?.reportSeq ?? 0,
        dataAsOf: m?.dataAsOf ?? null,
        publicMemberId: m?.publicMemberId ?? null,
        displayName: m?.displayName ?? null,
        emoji: m?.emoji ?? null,
        currentDisclosureVersion: DISCLOSURE_VERSION
      };
    },

    /** Join or withdraw (FR: 参与状态机). `baseConsentVersion` must match the member's current
     *  sequence — the stale-device guard. Joining requires confirming the CURRENT disclosure
     *  text; withdrawing keeps identity and received cheers, drops the published facts. */
    consent(uid, { enabled, disclosureVersion, baseConsentVersion, displayName }) {
      return store.txn(data => {
        const m = data.members[uid] || (data.members[uid] = {
          publicMemberId: crypto.randomBytes(8).toString('base64url'),
          displayName: '', emoji: '💪',
          enabled: false, disclosureVersion: null, consentSeq: 0,
          reportSeq: 0, reportRequests: {},
          suspended: false, suspendedReason: null, suspendedAt: null,
          days: {}, lifetime: { gymMs: 0, syncedMs: 0, gymSessions: 0, syncedSessions: 0 }, dataAsOf: null
        });
        if (typeof baseConsentVersion !== 'number' || baseConsentVersion !== m.consentSeq)
          throw new LeaderboardError(409, 'consent-stale', { consentVersion: m.consentSeq });
        if (enabled) {
          if (disclosureVersion !== DISCLOSURE_VERSION)
            throw new LeaderboardError(409, 'disclosure-stale', { currentDisclosureVersion: DISCLOSURE_VERSION });
          m.enabled = true;
          m.disclosureVersion = DISCLOSURE_VERSION;
          // The display name rides along at join time only; a rejoin keeps the stored one so a
          // withdrawn-then-back member does not change identity mid-period.
          if (!m.displayName && typeof displayName === 'string' && displayName.trim()) m.displayName = displayName.trim().slice(0, 40);
        } else {
          m.enabled = false;
          m.days = {};
          m.lifetime = { gymMs: 0, syncedMs: 0, gymSessions: 0, syncedSessions: 0 };
          m.dataAsOf = null;
          m.reportSeq = 0;
          m.reportRequests = {};
          // Suspended stays as it is: withdrawal must not launder a suspension away.
        }
        m.consentSeq += 1;
        return { enabled: m.enabled, consentVersion: m.consentSeq };
      }).then(({ out }) => out);
    },

    /** Publish a report (FR-1.5R). Full replacement inside the declared coverage; idempotent
     *  by requestId; optimistic by baseReportRev; bound to the current consent sequence. */
    report(uid, body) {
      const today = beijingDayKey(now());
      return store.txn(data => {
        const m = requireMember(data, uid);
        if (!m.enabled) throw new LeaderboardError(403, 'not-participating');
        if (m.suspended) throw new LeaderboardError(403, 'suspended');
        if (body.consentVersion !== m.consentSeq) throw new LeaderboardError(409, 'consent-stale', { consentVersion: m.consentSeq });
        if (body.schemaVersion !== REPORT_SCHEMA_VERSION || body.algorithmVersion !== REPORT_ALGORITHM_VERSION
          || body.calendarVersion !== REPORT_CALENDAR_VERSION)
          throw new LeaderboardError(409, 'version-stale', {
            schemaVersion: REPORT_SCHEMA_VERSION, algorithmVersion: REPORT_ALGORITHM_VERSION, calendarVersion: REPORT_CALENDAR_VERSION
          });
        if (typeof body.requestId !== 'string' || !body.requestId || body.requestId.length > 64)
          throw new LeaderboardError(400, 'request-id');

        // Idempotency before the optimistic compare: a network retry of an accepted report
        // carries the base it was built with, and must not pay for the revision it caused.
        const content = { days: body.days, lifetime: body.lifetime };
        const seen = m.reportRequests[body.requestId];
        if (seen) {
          // Same key, same content: the accepted answer again, for free. Different content
          // under a used key is a conflict the caller has to resolve visibly.
          if (seen.hash === hash(content)) return { reportRev: seen.rev, acceptedAt: seen.at, replayed: true };
          throw new LeaderboardError(409, 'request-conflict');
        }
        if (body.baseReportRev !== m.reportSeq)
          throw new LeaderboardError(409, 'report-stale', { reportRev: m.reportSeq });

        if (!isDayKey(body.coverageStart) || !isDayKey(body.coverageEnd) || body.coverageStart > body.coverageEnd)
          throw new LeaderboardError(400, 'coverage');
        if (keyToMs(body.coverageEnd) - keyToMs(body.coverageStart) > (RETAINED_DAYS - 1) * DAY)
          throw new LeaderboardError(400, 'coverage-too-wide');
        if (!Array.isArray(body.days) || body.days.length > RETAINED_DAYS * 2)
          throw new LeaderboardError(400, 'days');
        const days = {};
        for (const d of body.days) {
          if (!d || !isDayKey(d.date)) throw new LeaderboardError(400, 'day-key');
          if (d.date > today) throw new LeaderboardError(400, 'future-date', { today });
          if (d.date < body.coverageStart || d.date > body.coverageEnd) continue; // outside the declaration: dropped
          for (const f of TOTALS_FIELDS) {
            const valid = f === 'gymMs' || f === 'syncedMs' ? isMs(d[f]) : isCount(d[f]);
            if (!valid) throw new LeaderboardError(400, 'day-field', { date: d.date, field: f });
          }
          days[d.date] = { gymMs: d.gymMs, syncedMs: d.syncedMs, gymSessions: d.gymSessions, syncedSessions: d.syncedSessions };
        }
        const lifetime = {};
        for (const f of TOTALS_FIELDS) {
          const v = body.lifetime?.[f];
          const valid = f === 'gymMs' || f === 'syncedMs' ? isMs(v) : isLifetimeCount(v);
          if (!valid) throw new LeaderboardError(400, 'lifetime-field', { field: f });
          lifetime[f] = v;
        }
        if (Number.isFinite(body.dataAsOf) && body.dataAsOf > now() + DAY) throw new LeaderboardError(400, 'future-clock');

        // Keep only what the current week/month can still need; older buckets are dropped on
        // purpose (the client recomputes from full history on every publish anyway).
        const cutoff = keyToMs(today) - (RETAINED_DAYS - 1) * DAY;
        const kept = {};
        for (const [dayKey, b] of Object.entries(days)) if (keyToMs(dayKey) >= cutoff) kept[dayKey] = b;

        m.days = kept;
        m.lifetime = lifetime;
        m.dataAsOf = Number.isFinite(body.dataAsOf) ? body.dataAsOf : now();
        m.reportSeq += 1;
        const at = now();
        const requests = Object.entries({ ...m.reportRequests, [body.requestId]: { rev: m.reportSeq, at, hash: hash(content) } });
        m.reportRequests = Object.fromEntries(requests.slice(-20)); // bounded: retries, not history
        return { reportRev: m.reportSeq, acceptedAt: at };
      }).then(({ out }) => out);
    },

    /** The board itself. `viewerUid` null = guest view (viewerLiked always false, and the
     *  caller is expected to have checked the public-read switch before asking). Sync: it
     *  only reads a snapshot, and the routes validate the window type before calling. */
    board(windowType, viewerUid) {
      const w = windowFor(windowType, now());
      if (!w) throw new LeaderboardError(400, 'window');
      const data = store.read();
      const counts = likeCounts(data, w);
      const rows = [];
      for (const [uid, m] of Object.entries(data.members)) {
        if (!visible(m)) continue;
        const t = totalsFor(m, w);
        rows.push({
          publicMemberId: m.publicMemberId,
          displayName: m.displayName || '',
          emoji: m.emoji,
          gymMs: t.gymMs, syncedMs: t.syncedMs,
          gymSessions: t.gymSessions, syncedSessions: t.syncedSessions,
          totalMs: t.gymMs + t.syncedMs,
          likeCount: counts.get(uid) || 0,
          viewerLiked: viewerUid ? !!data.likes[`${viewerUid}|${uid}|${w.windowType}|${w.windowKey}`] : false,
          dataAsOf: m.dataAsOf
        });
      }
      return { window: { windowType: w.windowType, windowKey: w.windowKey, startKey: w.startKey, endKey: w.endKey, startMs: w.startMs, endMs: w.endMs, timezone: w.timezone, weekStart: w.weekStart, calendarVersion: w.calendarVersion }, rows: rankRows(rows) };
    },

    /** Set or clear a cheer (FR-1.13R). The window key is judged by the server's clock: a
     *  period that rolled over answers 409 with the current one, so a like can never land in
     *  a period nobody is looking at any more. First createdAt survives repeats. */
    async like({ actorUid, targetPublicId, windowType, windowKey, on }) {
      const w = windowFor(windowType, now());
      if (!w) throw new LeaderboardError(400, 'window');
      if (windowKey !== w.windowKey) throw new LeaderboardError(409, 'window-expired', { windowKey: w.windowKey });
      return store.txn(data => {
        let targetUid = null;
        let target = null;
        for (const [uid, m] of Object.entries(data.members)) {
          if (m.publicMemberId === targetPublicId) { targetUid = uid; target = m; break; }
        }
        if (!targetUid || !visible(target)) throw new LeaderboardError(404, 'no-such-member');
        if (targetUid === actorUid) throw new LeaderboardError(403, 'self');
        const key = `${actorUid}|${targetUid}|${w.windowType}|${w.windowKey}`;
        if (on) {
          if (!data.likes[key]) data.likes[key] = { createdAt: now() };
        } else {
          delete data.likes[key];
        }
        // Amortized lifecycle: past a working-set size, expired week/month cheers go — the
        // current period and the all-time counter are what anyone can still see or restore.
        if (Object.keys(data.likes).length > PRUNE_AT_LIKES) pruneLikes(data, now());
        const after = likeCounts(data, w).get(targetUid) || 0;
        return { liked: on, likeCount: after };
      }).then(({ out }) => out);
    },

    /** Admin suspension (Q20): reasoned, audited by the caller, idempotent by actionId, and
     *  immune to withdraw/rejoin — the member row is never deleted. */
    adminStatus({ actorUid, targetUid, suspended, reason, actionId }) {
      return store.txn(data => {
        const m = memberOf(data, targetUid);
        if (!m) throw new LeaderboardError(404, 'no-such-member');
        if (typeof actionId !== 'string' || !actionId || actionId.length > 64) throw new LeaderboardError(400, 'action-id');
        const prior = (data.adminActions || []).find(a => a.actionId === actionId);
        if (prior) return { ok: true, applied: false, at: prior.at };
        if (suspended) {
          const why = String(reason || '').trim();
          if (!why) throw new LeaderboardError(400, 'reason-required');
          m.suspended = true;
          m.suspendedReason = why.slice(0, 500);
          m.suspendedAt = now();
        } else {
          m.suspended = false;
          m.suspendedReason = null;
          m.suspendedAt = null;
        }
        const action = { actionId, at: now(), actor: actorUid, targetUid, suspended: !!suspended, reason: suspended ? m.suspendedReason : String(reason || '').slice(0, 500) };
        data.adminActions = [...(data.adminActions || []), action].slice(-500); // bounded, newest last
        return { ok: true, applied: true, at: action.at };
      }).then(({ out }) => out);
    },

    /** Account deletion (PRD §17): the shared file keeps nothing of a deleted account — not
     *  their member row (name, totals, identity) nor any like relationship they were part
     *  of, in either direction. Unlike a withdrawal this is a real removal: there is no
     *  account left to rejoin. Admin action records stay (audit trail, bounded). */
    forget(uid) {
      return store.txn(data => {
        const had = !!data.members[uid];
        delete data.members[uid];
        for (const key of Object.keys(data.likes)) {
          const [actor, target] = key.split('|');
          if (actor === uid || target === uid) delete data.likes[key];
        }
        return { removed: had };
      }).then(({ out }) => out);
    },

    /** Which uid a public id maps to — the admin card's view, never a client API. */
    uidOfPublicId(publicMemberId) {
      const data = store.read();
      for (const [uid, m] of Object.entries(data.members)) if (m.publicMemberId === publicMemberId) return uid;
      return null;
    }
  };
}
