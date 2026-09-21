/* Stand-in servers for ClientiQ (Supabase/PostgREST) and the Anthropic API, so
   the real client code runs end to end without credentials or network. */

import { createServer } from 'node:http';

export function startServer(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        port,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => {
          /* fetch() keeps sockets alive; without this close() never settles. */
          server.closeAllConnections();
          server.close(r);
        })
      });
    });
  });
}

export const COMPANY = {
  company_id: 23508,
  name: 'J&A PELLING LTD',
  account_ref: null,           // 89.5% of companies look like this
  primary_contact_name: 'Owen Blake'
};

export const CASES = [
  {
    id: 'c1', case_ref: 'RQ-01000', company_id: 23508, person_id: 96695,
    account_ref: null, subject: 'Refund not received after 10 days',
    note: 'Ten days and still nothing back.', channel: 'Email',
    intent: 'Billing', sentiment: 'angry', priority: 'High', status: 'open',
    owner_email: 'priya@example.com', sla_minutes: 20,
    opened_at: new Date(Date.now() - 34 * 60000).toISOString(),
    closed_at: null, ai_confidence: null, ai_summary: null, ai_escalate: null,
    sage_queue_id: null
  },
  {
    id: 'c2', case_ref: 'RQ-01001', company_id: 24730,
    account_ref: 'AWAY01', subject: 'Parcel marked delivered but nothing arrived',
    note: null, channel: 'Chat', intent: 'Delivery', sentiment: 'frustrated',
    priority: 'Medium', status: 'new', owner_email: null, sla_minutes: 60,
    opened_at: new Date(Date.now() - 4 * 60000).toISOString(),
    closed_at: null, sage_queue_id: null
  }
];

/* Minimal PostgREST + GoTrue stand-in. Records requests so tests can assert on
   auth headers and payloads. */
export function fakeClientiq({ failWith = null, queueFails = false, signInFails = false } = {}) {
  const received = [];
  const stored = new Map();
  let nextQueueId = 1;

  return startServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    received.push({ method: req.method, url: req.url, headers: req.headers, body });

    const json = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    if (req.url.startsWith('/auth/v1/token')) {
      /* signInFails may be `true` (a 400, bad credentials) or a status code,
         so a test can exercise the non-credential failures too. */
      if (signInFails) {
        return json(signInFails === true ? 400 : signInFails, { error: 'sign_in_refused' });
      }
      return json(200, { access_token: 'test-access-token', expires_in: 3600 });
    }

    /* Every data request must carry the session token, not just the key. */
    if (req.headers.authorization !== 'Bearer test-access-token') {
      return json(401, { message: 'missing session' });
    }

    if (failWith) return json(failWith, { message: 'upstream refused' });

    /* PATCH on a case, used by the CSAT write. The important behaviour to
       reproduce is the satisfaction_score=is.null filter: PostgREST matches no
       rows when the case is already scored, so the second rating changes
       nothing and returns an empty array. */
    if (req.method === 'PATCH' && req.url.startsWith('/rest/v1/resolveiq_cases')) {
      const id = decodeURIComponent((req.url.match(/id=eq\.([^&]+)/) || [])[1] || '');
      const requiresUnrated = req.url.includes('satisfaction_score=is.null');
      const row = [...stored.values()].find((r) => r.id === id);
      if (!row) return json(200, []);
      if (requiresUnrated && row.satisfaction_score != null) return json(200, []);
      Object.assign(row, body);
      return json(200, [row]);
    }

    /* Narrow read for the rating page. */
    if (req.method === 'GET' && req.url.startsWith('/rest/v1/resolveiq_cases?id=eq.')) {
      const id = decodeURIComponent((req.url.match(/id=eq\.([^&]+)/) || [])[1] || '');
      const row = [...stored.values()].find((r) => r.id === id);
      return json(200, row ? [{ case_ref: row.case_ref, satisfaction_score: row.satisfaction_score ?? null }] : []);
    }

    if (req.url.startsWith('/rest/v1/rpc/resolveiq_upsert_case')) {
      const c = body?.payload?.case || {};
      if (!c.company_id) return json(400, { message: 'company_id is required' });

      /* Mirror the real function's cost-of-failure gate and its merge rules:
         an absent cof key leaves the existing decision alone. */
      const priorRow = stored.get(c.case_ref);
      let cof = {
        cof_status: priorRow?.cof_status ?? null,
        cof_amount: priorRow?.cof_amount ?? null,
        cof_reason: priorRow?.cof_reason ?? null,
        cof_note: priorRow?.cof_note ?? null,
        cof_recorded_by: priorRow?.cof_recorded_by ?? null
      };
      if (c.cof && typeof c.cof === 'object') {
        const st = c.cof.status || null;
        if (st && st !== 'none' && st !== 'cost') {
          return json(400, { message: `cof.status must be 'none' or 'cost'` });
        }
        if (st === 'cost' && !(Number(c.cof.amount) > 0)) {
          return json(400, { message: 'a cost needs an amount greater than zero' });
        }
        if (st === 'cost' && !String(c.cof.reason || '').trim()) {
          return json(400, { message: 'a cost needs a reason' });
        }
        cof = {
          cof_status: st,
          cof_amount: st === 'cost' ? Number(c.cof.amount) : null,
          cof_reason: st === 'cost' ? c.cof.reason : null,
          cof_note: c.cof.note ?? null,
          cof_recorded_by: c.cof.recorded_by ?? null
        };
      }
      if (c.status === 'resolved' && !cof.cof_status) {
        return json(400, {
          message: 'This case cannot be closed until its cost of failure is recorded — either an amount and a reason, or a note that it cost nothing.'
        });
      }
      const ref = c.case_ref || 'RQ-0' + (2000 + stored.size);
      const existing = stored.get(ref);
      const row = Object.assign({ id: 'uuid-' + stored.size, case_ref: ref }, existing, c, cof, {
        case_ref: ref,
        closed_at: c.status === 'resolved' ? new Date().toISOString() : null
      });
      if (c.status === 'resolved' && !row.sage_queue_id && !queueFails) {
        row.sage_queue_id = nextQueueId++;
      }
      stored.set(ref, row);
      return json(200, {
        case: row,
        queued_to_sage: Boolean(row.sage_queue_id),
        sage_queue_id: row.sage_queue_id ?? null
      });
    }

    /* Resolved cases, for the KPI row and the cost report. CASES is the open
       queue fixture, so these come from what the tests have actually stored —
       otherwise the report would sum fixtures nobody closed. */
    if (req.url.startsWith('/rest/v1/resolveiq_cases?status=eq.resolved')) {
      const since = decodeURIComponent((req.url.match(/closed_at=gte\.([^&]+)/) || [])[1] || '');
      const from = since ? new Date(since).getTime() : 0;
      return json(200, [...stored.values()].filter((r) =>
        r.status === 'resolved' &&
        r.closed_at &&
        new Date(r.closed_at).getTime() >= from));
    }

    if (req.url.startsWith('/rest/v1/resolveiq_cases')) return json(200, CASES);
    if (req.url.startsWith('/rest/v1/vw_crm_companies')) return json(200, [COMPANY]);
    if (req.url.startsWith('/rest/v1/vw_crm_company_contacts')) return json(200, []);
    if (req.url.startsWith('/rest/v1/vw_crm_company_activity')) {
      return json(200, [
        { comm_id: 1, comm_type: 'Phone', subject: 'Late delivery', note: 'Goodwill credit',
          occurred_at: '2026-08-12T09:00:00Z', logged_by: 'jordan', is_scheduled: false, source: 'sage_crm' },
        { comm_id: 2, comm_type: 'Task', subject: 'Review account', note: null,
          occurred_at: '2027-03-01T09:00:00Z', logged_by: 'jordan', is_scheduled: true, source: 'sage_crm' }
      ]);
    }
    if (req.url.startsWith('/rest/v1/vw_crm_company_list')) return json(200, [COMPANY]);
    if (req.url.startsWith('/rest/v1/vw_crm_outbox')) {
      return json(200, [{ status: 'pending', sage_crm_id: null, last_error: null }]);
    }

    json(404, { message: 'no such path' });
  }).then((s) => Object.assign(s, { received, stored }));
}

export function fakeAnthropic({ refuse = false } = {}) {
  const received = [];
  const suggestion = {
    intent: 'Billing', sentiment: 'angry',
    summary: 'Refund issued 10 days ago has not reached the customer.',
    reply: 'Hello Owen,\n\nThank you for chasing this.',
    nextSteps: ['Check the refund status', 'Confirm the card on file'],
    confidence: 0.83, escalate: false, escalationReason: ''
  };

  return startServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    received.push({ path: req.url, body });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'msg_test', type: 'message', role: 'assistant',
      model: body.model || 'claude-opus-5',
      content: refuse ? [] : [{ type: 'text', text: JSON.stringify(suggestion) }],
      stop_reason: refuse ? 'refusal' : 'end_turn',
      stop_details: refuse ? { type: 'refusal', category: 'other', explanation: 'declined' } : null,
      usage: { input_tokens: 400, output_tokens: 120 }
    }));
  }).then((s) => Object.assign(s, { received, suggestion }));
}
