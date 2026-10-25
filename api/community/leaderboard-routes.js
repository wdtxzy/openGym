/* The leaderboard's HTTP surface, wired the way the coach routes are.
 *
 * server.js spreads these in only when LEADERBOARD=1, so a switched-off instance has no
 * routes at all — an unanswered 404, not a guarded 403 (LB-01). Guests reach GET
 * /api/leaderboard only when the instance opened public read; the flag is passed in by
 * server.js, which owns it. Everything mutating requires the session; identity is always the
 * server's own (req → readSession), never a client-sent uid. Error bodies carry a stable
 * `code` for translated client copy plus the minimum the client needs to recover (the current
 * consent version, the current window key) — and never an internal uid or another member's
 * raw buckets. */
import { createWindow } from '../rate-limit.js';
import { LeaderboardError } from './leaderboard.js';
import { StoreError } from './store.js';

const LIKE_BUDGET = 30;      // per account per minute (PRD §15 governance numbers)
const LIKE_IP_BUDGET = 120;  // per address per minute across accounts: the bounded anti-abuse
                             // budget the PRD asks for next to the account one (S06)

export function leaderboardRoutes({ domain, json, readBody, readSession, requireAdmin, audit, personalRevOf, deliverAudits, publicRead, addressOf }) {
  const likeBudget = createWindow({ max: LIKE_BUDGET, windowMs: 60000 });
  const ipBudget = createWindow({ max: LIKE_IP_BUDGET, windowMs: 60000 });
  const ipOf = req => (addressOf ? addressOf(req) : '') || 'unknown';
  const tooMany = (res, wait) => json(res, 429, { error: 'too many', code: 'rate', retryAfter: wait }, { 'Retry-After': String(wait) });
  // Both budgets, account first (the honest user's own limit) then address (a burst of
  // accounts from one host). Either one answers 429 with Retry-After.
  const likeThrottled = (req, res, user) => {
    const waitAcct = likeBudget.take('like|' + user.id);
    if (waitAcct) { tooMany(res, waitAcct); return true; }
    const waitIp = ipBudget.take('like|ip|' + ipOf(req));
    if (waitIp) { tooMany(res, waitIp); return true; }
    return false;
  };

  // One error shape for both module families: product refusals carry their own status, a
  // refused store is always 503 "unavailable" (PRD §7) — never a generic 500.
  const fail = (res, e) => {
    if (e instanceof LeaderboardError) return json(res, e.status, { error: e.code, ...e.extra });
    if (e instanceof StoreError) return json(res, 503, { error: 'store unavailable', code: e.code });
    throw e;
  };

  const signedIn = (req, res) => {
    const user = readSession(req);
    if (!user) { json(res, 401, { error: 'not signed in', code: 'auth' }); return null; }
    return user;
  };

  return {
    'GET /api/leaderboard': async (req, res) => {
      const viewer = readSession(req);
      if (!viewer && !publicRead) return json(res, 401, { error: 'not signed in', code: 'auth' });
      const url = new URL(req.url, 'http://x');
      const windowType = url.searchParams.get('window') || 'week';
      if (!['week', 'month', 'all'].includes(windowType)) return json(res, 400, { error: 'bad window', code: 'window' });
      try {
        const board = domain.board(windowType, viewer ? viewer.id : null);
        // A guest never gets a viewer's-eye field at all, not even a false one a cache could
        // confuse for a member's answer (PRD §7: no member-perspective cache for guests).
        if (!viewer) for (const row of board.rows) delete row.viewerLiked;
        return json(res, 200, board);
      } catch (e) { return fail(res, e); }
    },

    'GET /api/leaderboard/me': async (req, res) => {
      const user = signedIn(req, res); if (!user) return;
      try {
        // personalRev: the live personal-state revision the client must build its report
        // against (G03); the server verifies the pairing at commit time.
        json(res, 200, { ...domain.me(user.id), ...(personalRevOf ? { personalRev: personalRevOf(user.id) } : {}) });
      } catch (e) { return fail(res, e); } // a refused store answers 503, not a 500 (N10)
    },

    'PUT /api/leaderboard/consent': async (req, res) => {
      const user = signedIn(req, res); if (!user) return;
      const body = await readBody(req);
      try {
        const out = await domain.consent(user.id, {
          enabled: !!body.enabled,
          disclosureVersion: body.disclosureVersion,
          baseConsentVersion: body.baseConsentVersion,
          displayName: body.displayName ?? user.name
        });
        audit(req, body.enabled ? 'leaderboard.join' : 'leaderboard.withdraw', { user, enabled: !!body.enabled });
        return json(res, 200, out);
      } catch (e) { return fail(res, e); }
    },

    'PUT /api/leaderboard/report': async (req, res) => {
      const user = signedIn(req, res); if (!user) return;
      const body = await readBody(req);
      try {
        return json(res, 200, await domain.report(user.id, body));
      } catch (e) { return fail(res, e); }
    },

    'PUT /api/leaderboard/like': async (req, res) => {
      const user = signedIn(req, res); if (!user) return;
      const body = await readBody(req);
      if (likeThrottled(req, res, user)) return;
      try {
        return json(res, 200, await domain.like({
          actorUid: user.id, targetPublicId: body.targetPublicId,
          windowType: body.windowType, windowKey: body.windowKey, on: true
        }));
      } catch (e) { return fail(res, e); }
    },

    'DELETE /api/leaderboard/like': async (req, res) => {
      const user = signedIn(req, res); if (!user) return;
      const p = new URL(req.url, 'http://x').searchParams;
      if (likeThrottled(req, res, user)) return;
      try {
        return json(res, 200, await domain.like({
          actorUid: user.id, targetPublicId: p.get('targetPublicId'),
          windowType: p.get('windowType'), windowKey: p.get('windowKey'), on: false
        }));
      } catch (e) { return fail(res, e); }
    },

    'PUT /api/leaderboard/profile': async (req, res) => {
      const user = signedIn(req, res); if (!user) return;
      const body = await readBody(req);
      try {
        return json(res, 200, await domain.profile(user.id, { displayName: body.displayName, emoji: body.emoji }));
      } catch (e) { return fail(res, e); }
    },

    'GET /api/admin/leaderboard/members': async (req, res) => {
      if (!requireAdmin(req, res)) return;
      try {
        return json(res, 200, { members: domain.adminMembers() });
      } catch (e) { return fail(res, e); }
    },

    'PUT /api/admin/leaderboard/member-status': async (req, res) => {
      const admin = requireAdmin(req, res); if (!admin) return;
      const body = await readBody(req);
      // G06: the disposition and its pending-audit event commit in ONE shared-file
      // transaction (audited:false); delivery to audit.log is a separate retryable step —
      // a failure there delays the audit trail but can no longer lose the action itself.
      try {
        const out = await domain.adminStatus({
          actorUid: admin.id, targetUid: body.targetUid,
          suspended: !!body.suspended, reason: body.reason, actionId: body.actionId
        });
        // H03: ONE delivery path. The disposition transaction already enqueued the pending
        // audit event (with operator/target/act/reason); the flush below is the same reliable
        // pipeline the boot and periodic deliverers use — no second, undeduplicated write.
        const flush = domain.flushAudits(({ actionId, actor, targetUid, suspended, reason, at }) =>
          audit(req, 'leaderboard.admin.status', {
            ok: true,
            user: { id: String(actor || '') },
            target: { id: String(targetUid || '') },
            act: (suspended ? 'suspend' : 'restore'),
            msg: String(reason || ''),
            meta: { actionId, applied: true }
          }));
        // Immediate delivery attempt; when anything remains (log or outbox unwritable),
        // the retry loop takes over so the audit is delayed, never lost (G06/G07).
        flush.then(f => { if (f.remaining > 0 && deliverAudits) deliverAudits(); }).catch(() => {});
        return json(res, 200, out);
      } catch (e) {
        if (e instanceof LeaderboardError) return fail(res, e);
        if (e instanceof StoreError) return fail(res, e);
        throw e;
      }
    }
  };
}
