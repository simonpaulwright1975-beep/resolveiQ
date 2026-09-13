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
      if (signInFails) return json(400, { error: 'invalid_grant' });
      return json(200, { access_token: 'test-access-token', expires_in: 3600 });
    }

    /* Every data request must carry the session token, not just the key. */
    if (req.headers.authorization !== 'Bearer test-access-token') {
      return json(401, { message: 'missing session' });
    }

    if (failWith) return json(failWith, { message: 'upstream refused' });

    if (req.url.startsWith('/rest/v1/rpc/resolveiq_upsert_case')) {
      const c = body?.payload?.case || {};
      if (!c.company_id) return json(400, { message: 'company_id is required' });
      const existing = stored.get(c.case_ref);
      const row = Object.assign({ id: 'uuid-' + stored.size }, existing, c, {
        closed_at: c.status === 'resolved' ? new Date().toISOString() : null
      });
      if (c.status === 'resolved' && !row.sage_queue_id && !queueFails) {
        row.sage_queue_id = nextQueueId++;
      }
      stored.set(c.case_ref, row);
      return json(200, {
        case: row,
        queued_to_sage: Boolean(row.sage_queue_id),
        sage_queue_id: row.sage_queue_id ?? null
      });
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
