/* Test suite. Runs against fake Sage CRM and Anthropic servers — no real
   credentials, no network. Run with: npm test */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import Anthropic from '@anthropic-ai/sdk';
import { fakeSage, fakeAnthropic, SAGE_CASES, feed } from './fakes.mjs';

/* Config is read at import time, so the environment must be set before the
   modules under test are loaded. */
const sageServer = await fakeSage();
process.env.SAGE_BASE_URL = `${sageServer.url}/sdata/crmj/sagecrm/-/`;
process.env.SAGE_USER = 'apiuser';
process.env.SAGE_PASSWORD = 'secret';
process.env.SAGE_CACHE_SECONDS = '0';
process.env.ANTHROPIC_API_KEY = 'test-key';
/* Pin these so an ambient RESOLVEIQ_/CLAUDE_ variable can't change the result. */
process.env.RESOLVEIQ_MODEL = 'claude-opus-5';
process.env.RESOLVEIQ_EFFORT = 'medium';

const { SageClient, mapCase, pick, slaMinutesFor } = await import('../server/sage.mjs');
const { parseFeed } = await import('../server/sdata-xml.mjs');
const { suggestForTicket, SuggestionError } = await import('../server/suggest.mjs');
const { createApp } = await import('../server/index.mjs');

/* ---------- field resolution ---------- */

test('pick() resolves prefixed, unprefixed and differently-cased names', () => {
  const record = { case_description: 'Refund query', Status: 'Open', comp_name: 'Acme' };
  assert.equal(pick(record, ['description']), 'Refund query');
  assert.equal(pick(record, ['case_description']), 'Refund query');
  assert.equal(pick(record, ['status']), 'Open');
  assert.equal(pick(record, ['name']), 'Acme');
  assert.equal(pick(record, ['nothing_here'], 'fallback'), 'fallback');
});

test('pick() skips empty values rather than returning them', () => {
  assert.equal(pick({ case_description: '', description: 'real' }, ['case_description', 'description']), 'real');
});

/* ---------- case mapping ---------- */

test('mapCase() maps a standard Sage case onto the ticket shape', () => {
  const ticket = mapCase(SAGE_CASES[0]);
  assert.equal(ticket.id, 'CAS-0041');
  assert.equal(ticket.crmId, 41);
  assert.equal(ticket.customer, 'Owen Blake');
  assert.match(ticket.account, /Blake Retail Ltd/);
  assert.equal(ticket.status, 'open');
  assert.equal(ticket.intent, 'Billing');          // "refund" in the text
  assert.equal(ticket.sentiment, 'frustrated');    // "still ... chased"
  assert.equal(ticket.slaMins, 20);                // High priority
  assert.equal(ticket.assignee, 'Priya S.');
  assert.ok(ticket.waitMins >= 33 && ticket.waitMins <= 36, `waitMins was ${ticket.waitMins}`);
});

test('mapCase() handles records with no reference and unprefixed fields', () => {
  const ticket = mapCase(SAGE_CASES[2]);
  assert.equal(ticket.id, 'CASE-43');
  assert.equal(ticket.subject, 'How do I export my data to CSV?');
  assert.equal(ticket.status, 'resolved');
  assert.equal(ticket.waitMins, 0, 'resolved cases should not accrue wait time');
  assert.equal(ticket.customer, 'Unknown contact');
});

test('mapCase() never throws on an empty record', () => {
  const ticket = mapCase({});
  assert.equal(ticket.subject, '(no description)');
  assert.equal(ticket.status, 'open');
  assert.equal(ticket.intent, 'Other');
});

test('status vocabulary maps onto the four the UI knows', () => {
  assert.equal(mapCase({ case_status: 'Closed' }).status, 'resolved');
  assert.equal(mapCase({ case_status: 'Awaiting Customer' }).status, 'pending');
  assert.equal(mapCase({ case_status: 'New' }).status, 'new');
  assert.equal(mapCase({ case_status: 'Anything Else' }).status, 'open');
});

test('SLA policy maps priority to a window, case-insensitively', () => {
  assert.equal(slaMinutesFor('High'), 20);
  assert.equal(slaMinutesFor('low'), 240);
  assert.equal(slaMinutesFor('Nonsense'), 60);   // Default
});

/* ---------- live Sage client ---------- */

test('SageClient sends Basic auth and parses the SData envelope', async () => {
  const client = new SageClient();
  const { total, records } = await client.collection('case');
  assert.equal(total, 3);
  assert.equal(records.length, 3);
});

test('SageClient.tickets() returns mapped tickets', async () => {
  const tickets = await new SageClient().tickets();
  assert.equal(tickets.length, 3);
  assert.equal(tickets[0].id, 'CAS-0041');
});

test('SageClient surfaces HTTP failures with status and body', async () => {
  const broken = await fakeSage({ failWith: 503 });
  const client = new SageClient({ baseUrl: `${broken.url}/sdata/crmj/sagecrm/-/`, user: 'u', password: 'p' });
  await assert.rejects(() => client.tickets(), (err) => {
    assert.equal(err.status, 503);
    assert.match(err.message, /Sage CRM 503/);
    return true;
  });
  await broken.close();
});

test('SageClient sends the password in the Basic header and surfaces a 401', async () => {
  const wrong = new SageClient({ password: 'not-the-password' });
  await assert.rejects(() => wrong.tickets(), (err) => {
    assert.equal(err.status, 401);
    return true;
  });
  /* And the correct password is accepted — proving the header is really checked. */
  const right = new SageClient();
  assert.equal((await right.tickets()).length, 3);
});

/* ---------- SData Atom XML ---------- */

test('parseFeed() reads the Atom envelope counts', () => {
  const { total, startIndex, perPage, records } = parseFeed(feed(SAGE_CASES, 'case'));
  assert.equal(total, 3);
  assert.equal(startIndex, 1);
  assert.equal(perPage, 3);
  assert.equal(records.length, 3);
});

test('parseFeed() flattens a payload into the record shape mapCase() expects', () => {
  const [first] = parseFeed(feed([SAGE_CASES[0]], 'case')).records;
  assert.equal(first.$key, 41);
  assert.equal(first.case_referenceid, 'CAS-0041');
  assert.equal(first.case_description, 'Refund not received after 10 days');
  assert.equal(first.case_priority, 'High');
});

test('parseFeed() keeps linked entities as nested objects with a title', () => {
  const [first] = parseFeed(feed([SAGE_CASES[0]], 'case')).records;
  assert.equal(typeof first.Company, 'object');
  assert.equal(first.Company.$key, 7);
  assert.equal(first.Company.$title, 'Blake Retail Ltd');
  assert.equal(first.Person.$title, 'Owen Blake');
});

test('XML records map to exactly the same tickets as the JSON shape did', () => {
  const fromXml = parseFeed(feed(SAGE_CASES, 'case')).records.map(mapCase);
  const fromJson = SAGE_CASES.map(mapCase);
  assert.equal(fromXml.length, fromJson.length);
  for (let i = 0; i < fromXml.length; i++) {
    /* waitMins is clock-derived, so compare everything else. */
    const { waitMins: xw, ...x } = fromXml[i];
    const { waitMins: jw, ...j } = fromJson[i];
    assert.deepEqual(x, j, `ticket ${i} differs between XML and JSON paths`);
    assert.ok(Math.abs(xw - jw) <= 1);
  }
});

test('parseFeed() survives an empty feed and a malformed payload', () => {
  assert.deepEqual(parseFeed(feed([], 'case')).records, []);
  const odd = parseFeed('<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>');
  assert.deepEqual(odd.records, []);
});

test('the client sends an XML-first Accept header', async () => {
  let seen = null;
  const probe = await fakeSage({ onRequest: (req) => { seen = req.headers.accept; } });
  const client = new SageClient({ baseUrl: `${probe.url}/sdata/crmj/sagecrm/-/` });
  await client.tickets();
  assert.match(seen, /application\/atom\+xml/);
  assert.ok(seen.indexOf('atom+xml') < seen.indexOf('json'), 'XML must be preferred over JSON');
  await probe.close();
});

test('the client still accepts a JSON install', async () => {
  const jsonServer = await fakeSage({ format: 'json' });
  const client = new SageClient({ baseUrl: `${jsonServer.url}/sdata/crmj/sagecrm/-/` });
  const tickets = await client.tickets();
  assert.equal(tickets.length, 3);
  assert.equal(tickets[0].id, 'CAS-0041');
  await jsonServer.close();
});

/* ---------- Claude suggestion ---------- */

const TICKET = {
  id: 'CAS-0041',
  customer: 'Owen Blake',
  account: 'Blake Retail Ltd',
  channel: 'Email',
  subject: 'Refund not received after 10 days',
  waitMins: 34,
  slaMins: 20,
  priority: 'High',
  value: 214.5,
  messages: [{ who: 'Owen Blake', at: '08:30', text: 'Ten days and still nothing back.' }],
  history: []
};

test('suggestForTicket() sends a correctly shaped request and parses the result', async () => {
  const api = await fakeAnthropic();
  const client = new Anthropic({ apiKey: 'test-key', baseURL: api.url });

  const result = await suggestForTicket(TICKET, { client });

  assert.equal(result.intent, 'Billing');
  assert.equal(result.confidence, 0.83);
  assert.equal(result.escalate, false);
  assert.deepEqual(result.nextSteps.length, 2);
  assert.equal(result.usage.input, 400);

  const sent = api.received[0].body;
  assert.equal(sent.model, 'claude-opus-5');
  assert.deepEqual(sent.thinking, { type: 'adaptive' });
  assert.equal(sent.output_config.effort, 'medium');
  assert.equal(sent.output_config.format.type, 'json_schema');
  /* The schema must actually constrain the fields the UI reads. */
  const props = sent.output_config.format.schema.properties;
  for (const field of ['intent', 'sentiment', 'summary', 'reply', 'nextSteps', 'confidence', 'escalate']) {
    assert.ok(props[field], `schema is missing ${field}`);
  }
  /* The case details must reach the model. */
  assert.match(JSON.stringify(sent.messages), /Ten days and still nothing back/);
  assert.match(JSON.stringify(sent.messages), /CAS-0041/);

  await api.close();
});

test('suggestForTicket() treats a refusal as an error, not an empty draft', async () => {
  const api = await fakeAnthropic({ refuse: true });
  const client = new Anthropic({ apiKey: 'test-key', baseURL: api.url });

  await assert.rejects(() => suggestForTicket(TICKET, { client }), (err) => {
    assert.ok(err instanceof SuggestionError);
    assert.equal(err.status, 422);
    return true;
  });

  await api.close();
});

/* ---------- HTTP surface ---------- */

async function withApp(fn) {
  const app = createApp();
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.address().port}`;
  try {
    await fn(base);
  } finally {
    app.closeAllConnections();
    await new Promise((r) => app.close(r));
  }
}

test('GET /api/tickets serves the live CRM queue', async () => {
  await withApp(async (base) => {
    const res = await fetch(`${base}/api/tickets`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.source, 'sage');
    assert.equal(body.tickets.length, 3);
    assert.equal(body.tickets[0].id, 'CAS-0041');
  });
});

test('GET /api/health reports configuration without leaking credentials', async () => {
  await withApp(async (base) => {
    const res = await fetch(`${base}/api/health`);
    const body = await res.json();
    assert.equal(body.sage.configured, true);
    assert.equal(body.sage.reachable, true);
    assert.equal(body.claude.configured, true);
    const serialised = JSON.stringify(body);
    assert.doesNotMatch(serialised, /secret/, 'password must never be returned');
    assert.doesNotMatch(serialised, /test-key/, 'API key must never be returned');
  });
});

test('POST /api/suggest rejects a request with no ticket', async () => {
  await withApp(async (base) => {
    const res = await fetch(`${base}/api/suggest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.equal(res.status, 400);
  });
});

test('GET /api/suggest is rejected — it must be a POST', async () => {
  await withApp(async (base) => {
    const res = await fetch(`${base}/api/suggest`);
    assert.equal(res.status, 405);
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

    /* fetch() normalises ../ away, so hit the socket directly. */
    const raw = await new Promise((resolve, reject) => {
      const req = request(`${base}/`, { path: '/../../etc/passwd' }, (res) => {
        let data = '';
        res.on('data', (d) => (data += d));
        res.on('end', () => resolve({ status: res.statusCode, data }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.ok(raw.status === 403 || raw.status === 404, `traversal returned ${raw.status}`);
    assert.doesNotMatch(raw.data, /root:/);
  });
});

test.after(async () => {
  await sageServer.close();
});
