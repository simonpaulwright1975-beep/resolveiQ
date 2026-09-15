/* Runs against fake ClientiQ and Anthropic servers — no credentials, no network.
   npm test */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import Anthropic from '@anthropic-ai/sdk';
import { fakeClientiq, fakeAnthropic, CASES, COMPANY } from './fakes.mjs';

/* Config is read at import time, so the environment must be set first. */
const cq = await fakeClientiq();
process.env.SUPABASE_URL = cq.url;
process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test';
process.env.RESOLVEIQ_SUPABASE_EMAIL = 'care@example.com';
process.env.RESOLVEIQ_SUPABASE_PASSWORD = 'pw';
process.env.RESOLVEIQ_CACHE_SECONDS = '0';
process.env.ANTHROPIC_API_KEY = 'test-key';
process.env.RESOLVEIQ_MODEL = 'claude-opus-5';
process.env.RESOLVEIQ_EFFORT = 'medium';

const clientiq = await import('../server/clientiq.mjs');
const { suggestForTicket, SuggestionError } = await import('../server/suggest.mjs');
const { createApp } = await import('../server/index.mjs');

/* ---------- ClientiQ client ---------- */

test('signs in and sends the session token, never a service key', async () => {
  await clientiq.openCases();
  const signIn = cq.received.find((r) => r.url.startsWith('/auth/v1/token'));
  assert.ok(signIn, 'must sign in before reading');
  assert.equal(signIn.body.email, 'care@example.com');

  const dataCall = cq.received.find((r) => r.url.startsWith('/rest/v1/resolveiq_cases'));
  assert.equal(dataCall.headers.authorization, 'Bearer test-access-token');
  assert.equal(dataCall.headers.apikey, 'sb_publishable_test');

  const everything = JSON.stringify(cq.received);
  assert.doesNotMatch(everything, /service_role/, 'no service-role key anywhere in the path');
});

test('the session is reused rather than signing in per request', async () => {
  const before = cq.received.filter((r) => r.url.startsWith('/auth/v1/token')).length;
  await clientiq.openCases();
  await clientiq.company(23508);
  const after = cq.received.filter((r) => r.url.startsWith('/auth/v1/token')).length;
  assert.equal(after, before, 'should not re-authenticate while the token is valid');
});

test('caseToTicket() maps a stored case onto the console shape', () => {
  const t = clientiq.caseToTicket(CASES[0], { company: COMPANY });
  assert.equal(t.id, 'RQ-01000');
  assert.equal(t.companyId, 23508);
  assert.equal(t.customer, 'Owen Blake');
  assert.match(t.account, /J&A PELLING/);
  assert.equal(t.slaMins, 20);
  assert.equal(t.status, 'open');
  assert.ok(t.waitMins >= 33 && t.waitMins <= 36, `waitMins was ${t.waitMins}`);
});

test('a company with no account_ref still produces a usable ticket', () => {
  /* 89.5% of companies have no account_ref — this is the normal case. */
  const t = clientiq.caseToTicket(CASES[0], { company: COMPANY });
  assert.equal(t.accountRef, null);
  assert.equal(t.companyId, 23508);
  assert.ok(t.account.length > 0);
});

test('a resolved case accrues no waiting time', () => {
  const t = clientiq.caseToTicket({ ...CASES[0], status: 'resolved' }, { company: COMPANY });
  assert.equal(t.waitMins, 0);
});

test('activity() flags scheduled items so a future task is not read as today', async () => {
  const history = await clientiq.activity(23508);
  assert.equal(history.length, 2);
  assert.doesNotMatch(history[0].text, /^\[scheduled\]/);
  assert.match(history[1].text, /^\[scheduled\]/);
  assert.equal(history[0].at, '2026-08-12');
});

test('upsertCase() refuses a case with no company before calling out', async () => {
  const before = cq.received.length;
  await assert.rejects(
    () => clientiq.upsertCase({ case: { subject: 'orphan' } }),
    (e) => { assert.equal(e.status, 400); return true; }
  );
  assert.equal(cq.received.length, before, 'must not hit the network for an invalid case');
});

/* A 403 at sign-in is almost always a proxy or firewall, not a bad password.
   Reporting it as a credential problem sends whoever is setting this up
   looking in entirely the wrong place — which is exactly what happened the
   first time the live smoke test was run. */
test('sign-in failures name the real cause, not always the password', async () => {
  const { config } = await import('../server/config.mjs');
  const real = config.clientiq.url;

  const cases = [
    { status: 400, expect: /email or password is wrong/i, notExpect: /proxy|firewall/i },
    { status: 401, expect: /email or password is wrong/i, notExpect: /proxy|firewall/i },
    { status: 403, expect: /network policy, proxy or firewall/i, notExpect: /password is wrong/i },
    { status: 500, expect: /server error/i, notExpect: /password is wrong/i }
  ];

  for (const { status, expect, notExpect } of cases) {
    const broken = await fakeClientiq({ signInFails: status });
    config.clientiq.url = broken.url;
    try {
      await assert.rejects(() => clientiq.company(1), (e) => {
        assert.match(e.message, expect, `${status} should explain itself`);
        assert.doesNotMatch(e.message, notExpect, `${status} must not misdiagnose`);
        return true;
      });
    } finally {
      config.clientiq.url = real;
      await broken.close();
    }
  }
});

test('a failed sign-in is an error, not a silent empty queue', async () => {
  const broken = await fakeClientiq({ signInFails: true });
  const { config } = await import('../server/config.mjs');
  const real = config.clientiq.url;
  config.clientiq.url = broken.url;
  try {
    await assert.rejects(() => clientiq.company(1), (e) => {
      assert.match(e.message, /Could not sign in/);
      return true;
    });
  } finally {
    config.clientiq.url = real;
    await broken.close();
  }
});

/* ---------- Claude ---------- */

const TICKET = {
  id: 'RQ-01000', companyId: 23508, customer: 'Owen Blake', account: 'J&A PELLING LTD',
  channel: 'Email', subject: 'Refund not received after 10 days', waitMins: 34,
  slaMins: 20, priority: 'High', value: 0,
  messages: [{ who: 'Owen Blake', at: '08:30', text: 'Ten days and still nothing back.' }],
  history: []
};

test('suggestForTicket() sends a correctly shaped request and parses the result', async () => {
  const api = await fakeAnthropic();
  const client = new Anthropic({ apiKey: 'test-key', baseURL: api.url });
  const result = await suggestForTicket(TICKET, { client });

  assert.equal(result.intent, 'Billing');
  assert.equal(result.confidence, 0.83);
  const sent = api.received[0].body;
  assert.equal(sent.model, 'claude-opus-5');
  assert.deepEqual(sent.thinking, { type: 'adaptive' });
  assert.equal(sent.output_config.format.type, 'json_schema');
  assert.match(JSON.stringify(sent.messages), /Ten days and still nothing back/);
  await api.close();
});

test('suggestForTicket() treats a refusal as an error, not an empty draft', async () => {
  const api = await fakeAnthropic({ refuse: true });
  const client = new Anthropic({ apiKey: 'test-key', baseURL: api.url });
  await assert.rejects(() => suggestForTicket(TICKET, { client }), (e) => {
    assert.ok(e instanceof SuggestionError);
    assert.equal(e.status, 422);
    return true;
  });
  await api.close();
});

/* ---------- HTTP surface ---------- */

async function withApp(fn) {
  const app = createApp();
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.address().port}`;
  try { await fn(base); } finally {
    app.closeAllConnections();
    await new Promise((r) => app.close(r));
  }
}

test('GET /api/tickets serves the live ClientiQ queue', async () => {
  await withApp(async (base) => {
    const body = await (await fetch(`${base}/api/tickets`)).json();
    assert.equal(body.source, 'clientiq');
    assert.equal(body.tickets.length, 2);
    assert.equal(body.tickets[0].id, 'RQ-01000');
    assert.equal(body.tickets[0].companyId, 23508);
  });
});

test('GET /api/health reports configuration without leaking the password', async () => {
  await withApp(async (base) => {
    const body = await (await fetch(`${base}/api/health`)).json();
    assert.equal(body.clientiq.configured, true);
    assert.equal(body.clientiq.reachable, true);
    assert.doesNotMatch(JSON.stringify(body), /"pw"/);
  });
});

test('POST /api/cases stores a case and reports the Sage CRM queue', async () => {
  await withApp(async (base) => {
    const res = await fetch(`${base}/api/cases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ticket: { id: 'RQ-01000', companyId: 23508, subject: 'Refund not received',
                  status: 'resolved', priority: 'High', channel: 'Email' },
        agent: 'care@example.com',
        resolution: 'Refund re-issued'
      })
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.queued_to_sage, true, 'a resolved case must mirror into Sage CRM');
    assert.ok(body.sage_queue_id);
    assert.equal(body.warning, null);

    const sent = cq.received.at(-1).body.payload;
    assert.equal(sent.case.company_id, 23508);
    assert.equal(sent.event.direction, 'outbound');
  });
});

test('POST /api/cases warns when the Sage CRM copy could not be queued', async () => {
  const noQueue = await fakeClientiq({ queueFails: true });
  const { config } = await import('../server/config.mjs');
  const real = config.clientiq.url;
  config.clientiq.url = noQueue.url;
  try {
    await withApp(async (base) => {
      const body = await (await fetch(`${base}/api/cases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticket: { id: 'RQ-9', companyId: 23508, subject: 'x', status: 'resolved' } })
      })).json();
      assert.equal(body.queued_to_sage, false);
      assert.match(body.warning, /Reps working in Sage will not see it/);
    });
  } finally {
    config.clientiq.url = real;
    await noQueue.close();
  }
});

test('POST /api/cases rejects a case with no company', async () => {
  await withApp(async (base) => {
    const res = await fetch(`${base}/api/cases`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ case: { subject: 'orphan' } })
    });
    assert.equal(res.status, 400);
  });
});

test('GET /api/history returns previous contact for a company', async () => {
  await withApp(async (base) => {
    const body = await (await fetch(`${base}/api/history?company_id=23508`)).json();
    assert.equal(body.history.length, 2);
  });
});

test('GET /api/history without a company is rejected', async () => {
  await withApp(async (base) => {
    assert.equal((await fetch(`${base}/api/history`)).status, 400);
  });
});

test('GET /api/sage-status reports where a queued change has got to', async () => {
  await withApp(async (base) => {
    const body = await (await fetch(`${base}/api/sage-status?queue_id=1`)).json();
    assert.equal(body.status.status, 'pending');
  });
});

test('module scripts are served as JavaScript', async () => {
  /* Regression: .mjs was missing from the MIME map, so the browser refused to
     execute it and the New case dialog silently did not exist. */
  await withApp(async (base) => {
    const res = await fetch(`${base}/assets/new-case.mjs`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /javascript/);
  });
});

test('GET /api/contacts returns people for a company', async () => {
  await withApp(async (base) => {
    const res = await fetch(`${base}/api/contacts?company_id=23508`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray((await res.json()).contacts));
  });
});

test('GET /api/contacts without a company is rejected', async () => {
  await withApp(async (base) => {
    assert.equal((await fetch(`${base}/api/contacts`)).status, 400);
  });
});

test('POST /api/cases forwards what the agent chose, unaltered', async () => {
  /* Regression: the dialog re-rendered before reading its own fields, so
     priority, channel, note and contact were replaced by defaults. */
  await withApp(async (base) => {
    await fetch(`${base}/api/cases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        case: {
          company_id: 23508, person_id: 96695, subject: 'Damaged delivery',
          note: 'Four boxes crushed.', channel: 'Voice', priority: 'High',
          status: 'new', source: 'resolveiq'
        }
      })
    });
    const sent = cq.received.at(-1).body.payload.case;
    assert.equal(sent.priority, 'High');
    assert.equal(sent.channel, 'Voice');
    assert.equal(sent.note, 'Four boxes crushed.');
    assert.equal(sent.person_id, 96695);
    assert.equal(sent.status, 'new');
  });
});

test('a new case may omit case_ref — the database issues one', async () => {
  await withApp(async (base) => {
    const body = await (await fetch(`${base}/api/cases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ case: { company_id: 23508, subject: 'No ref supplied', status: 'new' } })
    })).json();
    assert.ok(body.case_ref, 'a reference must come back');
    assert.equal(body.queued_to_sage, false, 'a new case must not touch Sage CRM yet');
  });
});

test('unknown API routes 404 as JSON', async () => {
  await withApp(async (base) => {
    const res = await fetch(`${base}/api/nope`);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error, 'No such endpoint');
  });
});

test('static files are served and path traversal is refused', async () => {
  await withApp(async (base) => {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /ResolveIQ/);

    const raw = await new Promise((resolve, reject) => {
      const req = request(`${base}/`, { path: '/../../etc/passwd' }, (res) => {
        let data = '';
        res.on('data', (d) => (data += d));
        res.on('end', () => resolve({ status: res.statusCode, data }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.ok(raw.status === 403 || raw.status === 404);
    assert.doesNotMatch(raw.data, /root:/);
  });
});

test.after(async () => { await cq.close(); });
