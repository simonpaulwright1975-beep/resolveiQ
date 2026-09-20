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
const { createApp, deriveMetrics, londonMidnight } = await import('../server/index.mjs');

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
/* CSAT arrives from a public page a customer reaches from an email. It is the
   only unauthenticated write in the app, so what it cannot do matters as much
   as what it can. */
test('a feedback token only opens the case it was minted for', async () => {
  const fb = await import('../server/feedback.mjs');
  const { config } = await import('../server/config.mjs');
  /* The suite must not need an environment variable to run. */
  config.feedback.secret = config.feedback.secret || 'test-only-signing-secret';

  const id = 'case-aaaa-1111';
  const token = fb.mintToken(id);

  assert.equal(fb.verifyToken(id, token), true);

  for (const [what, run] of [
    ['another case', () => fb.verifyToken('case-bbbb-2222', token)],
    ['a tampered signature', () => fb.verifyToken(id, token.slice(0, -1) + 'X')],
    ['a forged timestamp', () => fb.verifyToken(id, 'v1.9999999999.' + token.split('.')[2])],
    ['junk', () => fb.verifyToken(id, 'not-a-token')],
    ['an empty token', () => fb.verifyToken(id, '')]
  ]) {
    assert.throws(run, /not valid/i, `${what} must be refused`);
  }

  /* A link in a year-old email should not still be scoreable. */
  assert.throws(() => fb.verifyToken(id, token, Date.now() + 400 * 86400 * 1000), /expired/i);
});

test('scores outside 1-5 are refused', async () => {
  const fb = await import('../server/feedback.mjs');
  assert.equal(fb.parseScore(1), 1);
  assert.equal(fb.parseScore('5'), 5);
  for (const bad of [0, 6, -1, 2.5, 'five', null, undefined, NaN, Infinity]) {
    assert.throws(() => fb.parseScore(bad), /1 to 5/, `${String(bad)} must be refused`);
  }
});

test('a case can only be rated once', async () => {
  const api = await fakeClientiq();
  const { config } = await import('../server/config.mjs');
  const realUrl = config.clientiq.url;
  config.clientiq.url = api.url;

  try {
    /* Create a case to rate. */
    const saved = await clientiq.upsertCase({
      case: { company_id: 23508, subject: 'Rate me', status: 'resolved' }
    });
    const id = saved.case.id;

    const first = await clientiq.setSatisfaction(id, 5, 'Very helpful');
    assert.ok(first, 'the first score is recorded');

    /* Same link, clicked again — the filter must match nothing rather than
       letting the score be changed. */
    const second = await clientiq.setSatisfaction(id, 1, 'Changed my mind');
    assert.equal(second, null, 'a second rating must not overwrite the first');
  } finally {
    config.clientiq.url = realUrl;
    await api.close();
  }
});

test('the rating page is served and reveals nothing about the customer', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync('feedback.html', 'utf8');

  /* It must not be indexed, and it must not carry case detail into the page. */
  assert.match(html, /name="robots"[^>]*noindex/, 'the rating page must not be indexed');
  assert.doesNotMatch(html, /companyId|company_id|owner_email/,
    'no customer or owner detail belongs on a public page');

  await withApp(async (base) => {
    const res = await fetch(`${base}/feedback`);
    assert.equal(res.status, 200, '/feedback must serve without an extension');
    assert.match(res.headers.get('content-type'), /text\/html/);
  });
});

/* The KPI row is computed from resolveiq_cases. Getting a day boundary or an
   average wrong here produces a number that looks plausible and is wrong, which
   is worse than a blank — so the arithmetic is pinned down. */
test('KPIs are computed from resolved cases, on UK days', async () => {
  const todayStart = londonMidnight(0);
  const yesterdayStart = londonMidnight(1);
  const at = (base, mins) => new Date(base.getTime() + mins * 60000).toISOString();

  const resolved = [
    /* today: 30 min, AI-assisted, inside a 60 min SLA */
    { opened_at: at(todayStart, 600), closed_at: at(todayStart, 630),
      sla_minutes: 60, priority: 'Medium', ai_confidence: 0.82, satisfaction_score: 5 },
    /* today: 90 min, unassisted, breaches the same window */
    { opened_at: at(todayStart, 600), closed_at: at(todayStart, 690),
      sla_minutes: 60, priority: 'Medium', ai_confidence: null, satisfaction_score: 3 },
    /* yesterday: must not count toward today */
    { opened_at: at(yesterdayStart, 60), closed_at: at(yesterdayStart, 120),
      sla_minutes: 60, priority: 'Medium', ai_confidence: 0.9, satisfaction_score: null }
  ];

  const tickets = [{ status: 'open' }, { status: 'new' }, { status: 'resolved' }];
  const m = deriveMetrics(tickets, { slaTargetPct: 95 }, resolved);

  assert.equal(m.resolvedToday, 2, 'only today\'s cases count as today');
  assert.equal(m.resolvedYesterday, 1, "yesterday's are counted separately");
  assert.equal(m.openCount, 2, 'resolved tickets are not open');
  assert.equal(m.avgHandleMins, 60, '(30 + 90) / 2');
  assert.equal(m.aiAssistedPct, 50, 'one of two used the draft');
  assert.equal(m.aiAssistedPrevPct, 100, "yesterday's single case used it");
  assert.equal(m.csat, 4, '(5 + 3) / 2');
  assert.equal(m.prevCsat, null, 'no scores yesterday means no figure, not zero');
  assert.equal(m.resolvedWithinSlaToday, 50, 'one of two beat its window');
});

test('a KPI with no source stays blank rather than reading zero', async () => {
  const m = deriveMetrics([{ status: 'open' }], { slaTargetPct: 95 }, []);

  /* Nothing resolved today. A count is genuinely zero; an average or a
     percentage over nothing is unknown, and must not render as 0. */
  assert.equal(m.resolvedToday, 0);
  assert.equal(m.avgHandleMins, null, 'no cases means no average, not 0m');
  assert.equal(m.aiAssistedPct, null, 'no cases means no percentage, not 0%');
  assert.equal(m.csat, null);
  assert.equal(m.resolvedWithinSlaToday, null);
});

test('the UK day boundary is not the UTC one', async () => {
  /* Through BST a UTC boundary puts an hour of every evening into tomorrow.
     23:30 London on a July night must belong to that day, not the next. */
  const july = new Date('2026-07-15T22:30:00Z');       // 23:30 London
  const start = londonMidnight(0, july);
  assert.ok(start.getTime() <= july.getTime(),
    'a 23:30 BST case falls on the day that has already started');

  const asLondonDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(july);
  assert.equal(asLondonDate, '2026-07-15');
  assert.equal(start.toISOString(), '2026-07-14T23:00:00.000Z',
    'London midnight on 15 July is 23:00 UTC on the 14th');
});

test('the KPI guide ships with the console and starts hidden', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync('index.html', 'utf8');

  assert.match(html, /id="tab-kpis"[\s\S]*?role="tab"/, 'a KPI tab must exist');
  assert.match(html, /id="view-kpis"[\s\S]*?hidden/, 'the guide starts hidden behind the queue');
  assert.match(html, /id="tab-queue"[\s\S]*?aria-selected="true"/, 'the queue is the default view');

  /* The guide must describe how CSAT is actually collected — it is the only
     figure that needs the advisor to do something to exist. */
  assert.match(html, /Ask for a rating/,
    'CSAT must point at the link that collects it');
  assert.doesNotMatch(html, /There is nothing\s+behind this yet/,
    'the guide must not still say CSAT has no source');
  assert.match(html, /id="sla-windows"/,
    'SLA windows are rendered from config, not written into the prose');
});

test('the SLA windows reach the browser however the queue was loaded', async () => {
  await withApp(async (base) => {
    /* The windows are server configuration, so the guide needs them even when
       the queue fell back to sample data. */
    const body = await (await fetch(`${base}/api/tickets`)).json();
    assert.ok(body.metrics.slaPolicy, 'slaPolicy must be sent');
    assert.equal(typeof body.metrics.slaPolicy.High, 'number');
    assert.equal(typeof body.metrics.slaPolicy.Default, 'number');
  });
});

/* The landing page is the WG Platforms entry screen, and is meant to be copied
   into every iQ app with only the config block changed. These guard the two
   things that would quietly break that: the route, and the config contract. */
test('the landing page is the front door, and the console is at /console', async () => {
  await withApp(async (base) => {
    /* '/' is the entry page, not the console. Getting this backwards would
       send everyone straight past the Walter Geering front door. */
    const rootHtml = await (await fetch(`${base}/`)).text();
    assert.match(rootHtml, /WG_APP/, '/ must serve the landing page');

    const consoleRes = await fetch(`${base}/console`);
    assert.equal(consoleRes.status, 200);
    const consoleHtml = await consoleRes.text();
    assert.match(consoleHtml, /id="new-case-btn"/, '/console must serve the console');
    assert.doesNotMatch(consoleHtml, /WG_APP/, '/console is not the landing page');

    /* A trailing slash would resolve the console's relative asset paths against
       /console/, 404-ing every stylesheet and script. */
    const slash = await fetch(`${base}/console/`, { redirect: 'manual' });
    assert.equal(slash.status, 301, '/console/ must redirect, not serve a broken page');
    assert.equal(slash.headers.get('location'), '/console');
  });
});

test('the landing page is also served at /landing and /landing.html', async () => {
  await withApp(async (base) => {
    for (const path of ['/landing', '/landing.html']) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 200, `${path} must serve`);
      assert.match(res.headers.get('content-type'), /text\/html/);
      const html = await res.text();
      assert.match(html, /WG_APP/, `${path} must carry the app config`);
    }
  });
});

test('the landing config exposes every variable the brief names', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync('landing.html', 'utf8');

  for (const key of ['APP_LOGO', 'APP_NAME', 'APP_STRAPLINE', 'APP_ENTRY_TEXT', 'APP_URL']) {
    assert.match(html, new RegExp(key + '\\s*:'), `${key} must be configurable`);
  }

  /* Both the config and the markup fallback must point at the console. If
     either still says '/', the entry button reloads the landing page and the
     app becomes unreachable through the front door. */
  assert.match(html, /APP_URL:\s*'\/console'/, 'APP_URL must point at the console');
  assert.match(html, /id="app-enter" href="\/console"/, 'the no-JS href must too');

  const css = readFileSync('assets/landing.css', 'utf8');
  /* Section 8 of the brief is specific about the entry button, and it is the
     one element every app shares. */
  assert.match(css, /\.panel__enter\b[\s\S]*?background:\s*var\(--accent\)/,
    'the entry button must use the brand accent, not a local colour');
  assert.match(css, /\.panel__enter:hover[\s\S]*?var\(--accent-2\)/,
    'hover must use the brand hover token');

  /* image-set() picks by type support, not by whether the file exists, so a
     .webp that has not been added yet silently kills the artwork layer.
     Comments are stripped first — the rule against it is itself explained in
     one, and matching that would fail for the wrong reason. */
  const cssRules = css.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(cssRules, /image-set\(/,
    'image-set would silently drop the artwork when a listed format is absent');
  assert.match(cssRules, /url\("landing-scene\.(webp|png|jpe?g)"\)/,
    'the artwork layer must be a plain url() naming one file');

  /* Whatever format the CSS asks for has to actually be on disk, or the front
     door silently falls back to the gradient and looks unfinished. */
  const { existsSync } = await import('node:fs');
  const named = cssRules.match(/url\("(landing-scene\.[a-z0-9]+)"\)/)[1];
  assert.ok(existsSync(`assets/${named}`), `assets/${named} is referenced but missing`);

  /* And the server must know its media type — an unknown extension is served
     as octet-stream, which browsers will not paint as a background. */
  const server = readFileSync('server/index.mjs', 'utf8');
  const ext = named.slice(named.lastIndexOf('.'));
  assert.match(server, new RegExp(`'\\${ext}':`), `${ext} must be in the MIME map`);
});

/* The ClientiQ sign-in is a machine credential. If it reaches a customer, or
   becomes the owner of a case, two different things have gone wrong: customers
   get a mailbox nobody reads, and the record of who handled a case is a robot. */
test('the service account never reaches a customer or owns a case', async () => {
  const { config } = await import('../server/config.mjs');
  const { readFileSync } = await import('node:fs');

  const serviceAccount = 'resolveiq-service@example.invalid';
  const realEmail = config.clientiq.email;
  config.clientiq.email = serviceAccount;

  try {
    /* What the browser is told the current agent is. */
    await withApp(async (base) => {
      const body = await (await fetch(`${base}/api/tickets`)).json();
      assert.notEqual(body.currentAgent, serviceAccount,
        'the signed-in machine account must not be presented as the advisor');
      assert.equal(body.currentAgent, config.identity.teamEmail,
        'with no advisor configured it should fall back to the team address');
    });

    /* What Claude is told to sign off as. */
    const prompt = readFileSync('server/suggest.mjs', 'utf8');
    assert.match(prompt, /teamEmail/, 'the draft prompt must name the team address');
    assert.doesNotMatch(prompt, /clientiq\.email/,
      'the draft prompt must never reference the sign-in account');
  } finally {
    config.clientiq.email = realEmail;
  }
});

test('customer-facing identity defaults to the shared mailbox, not a person', async () => {
  const { config } = await import('../server/config.mjs');
  assert.match(config.identity.teamEmail, /^customerservice@/,
    'replies must go out from the customer service mailbox by default');
  assert.ok(config.identity.teamName, 'a team name is needed for the sign-off');
});

/* The standalone artifact has no server and no sibling files. A script tag
   pointing at assets/ that survives the build ships a dead reference — which
   is how the New case button came to be present but inert in a static copy. */
test('the standalone artifact references no external files', async () => {
  const { execFileSync } = await import('node:child_process');
  const { readFileSync } = await import('node:fs');

  execFileSync(process.execPath, ['scripts/build-artifact.mjs'], { stdio: 'pipe' });
  const artifact = readFileSync('dist/artifact.html', 'utf8');

  assert.doesNotMatch(artifact, /src="assets\//, 'no asset script or image refs may survive');
  assert.doesNotMatch(artifact, /<script[^>]*\bsrc=/, 'the artifact must not load anything');
  assert.match(artifact, /RESOLVEIQ_readJson/, 'the JSON helper must be inlined');
  /* Raising a case needs a server, so the button must not look usable. */
  assert.match(artifact, /new-case-btn[\s\S]{0,400}disabled = true/, 'New case must be disabled');
});

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
    const page = await fetch(`${base}/console`);
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
