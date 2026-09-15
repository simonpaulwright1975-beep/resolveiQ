/* ResolveIQ server.

   Serves the static console and three JSON endpoints:

     GET  /api/health            what is configured and reachable
     GET  /api/tickets           the queue (Sage CRM, or sample data)
     POST /api/suggest           draft a resolution for one ticket
     POST /api/cases             write a case to the central customer record

   Credentials live here and only here. The browser never receives the Sage
   password or the Anthropic API key. */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, claudeConfigured, clientiqConfigured } from './config.mjs';
import { suggestForTicket, SuggestionError } from './suggest.mjs';
import * as clientiq from './clientiq.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  /* Without this a module script is served as octet-stream and the browser
     refuses to execute it — silently, with the feature simply absent. */
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

/* Sample tickets, loaded from the same file the static page uses, so demo mode
   and live mode render through one code path. */
let sampleCache = null;
async function sampleTickets() {
  if (sampleCache) return sampleCache;
  const source = await readFile(join(root, 'assets/sample-data.js'), 'utf8');
  const sandbox = { window: {} };
  new Function('window', source)(sandbox.window);
  sampleCache = sandbox.window.RESOLVEIQ_DATA;
  return sampleCache;
}

/* Hold the result briefly so a room full of agents doesn't hammer the API. */
let queueCache = { at: 0, payload: null };

async function loadQueue() {
  const sample = await sampleTickets();

  if (!clientiqConfigured) {
    return { ...sample, source: 'sample', reason: 'ClientiQ is not configured' };
  }

  const fresh = Date.now() - queueCache.at < config.cacheSeconds * 1000;
  if (fresh && queueCache.payload) return queueCache.payload;

  try {
    const rows = await clientiq.openCases();

    /* One company lookup per distinct company, not per case. */
    const companyIds = [...new Set(rows.map((r) => r.company_id))];
    const companies = new Map();
    await Promise.all(
      companyIds.map(async (id) => {
        try {
          companies.set(id, await clientiq.company(id));
        } catch {
          companies.set(id, null);   // a missing company must not drop the case
        }
      })
    );

    const tickets = rows.map((r) =>
      clientiq.caseToTicket(r, { company: companies.get(r.company_id) })
    );

    const payload = {
      team: sample.team,
      /* The advisor, not the service account. Signing in as a machine
         credential must not make that machine the owner of every case. */
      currentAgent:
        config.identity.advisorEmail || config.identity.teamEmail || sample.currentAgent,
      metrics: deriveMetrics(tickets, sample.metrics),
      tickets,
      source: 'clientiq'
    };
    queueCache = { at: Date.now(), payload };
    return payload;
  } catch (error) {
    console.error('ClientiQ query failed:', error.message);
    if (queueCache.payload) {
      return { ...queueCache.payload, source: 'clientiq-stale', reason: error.message };
    }
    return { ...sample, source: 'sample', reason: `ClientiQ unreachable — ${error.message}` };
  }
}

/* Only report what can actually be answered. */
function deriveMetrics(tickets, base) {
  const open = tickets.filter((t) => t.status !== 'resolved');
  return {
    resolvedToday: null,
    resolvedYesterday: null,
    autoResolvedPct: null,
    autoResolvedPrevPct: null,
    avgHandleMins: null,
    prevHandleMins: null,
    csat: null,
    prevCsat: null,
    slaTargetPct: base?.slaTargetPct ?? 95,
    openCount: open.length
  };
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store'
  });
  res.end(payload);
}

async function readBody(req, limit = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new SuggestionError('Request body too large', 413);
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new SuggestionError('Request body is not valid JSON', 400);
  }
}

async function serveStatic(req, res, pathname) {
  /* '/' is the console. '/landing' is the WG Platforms entry page — accepted
     without the extension because it is a URL people type and share. */
  let rel;
  if (pathname === '/') rel = 'index.html';
  else if (pathname === '/landing') rel = 'landing.html';
  else rel = pathname.replace(/^\/+/, '');
  /* normalize + prefix check keeps ../ out of the served tree. */
  const target = normalize(join(root, rel));
  if (!target.startsWith(root)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const body = await readFile(target);
    res.writeHead(200, {
      'Content-Type': MIME[extname(target)] || 'application/octet-stream',
      'Content-Length': body.length
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
}

export function createApp() {
  return createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    try {
      if (url.pathname === '/api/health') {
        let reachable = null;
        if (clientiqConfigured) {
          try {
            await clientiq.openCases();
            reachable = true;
          } catch {
            reachable = false;
          }
        }
        return sendJson(res, 200, {
          ok: true,
          clientiq: { configured: clientiqConfigured, reachable, url: config.clientiq.url },
          claude: { configured: claudeConfigured, model: claudeConfigured ? config.claude.model : null }
        });
      }

      if (url.pathname === '/api/tickets') {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'Use GET' });
        return sendJson(res, 200, await loadQueue());
      }

      if (url.pathname === '/api/suggest') {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST' });

        if (!claudeConfigured) {
          return sendJson(res, 503, {
            error: 'No ANTHROPIC_API_KEY set — live drafting is off. Copy .env.example to .env and add a key.'
          });
        }

        const body = await readBody(req);
        const ticket = body?.ticket;
        if (!ticket || typeof ticket.subject !== 'string') {
          return sendJson(res, 400, { error: 'Send { "ticket": { ... } } with at least a subject.' });
        }

        const suggestion = await suggestForTicket(ticket);
        return sendJson(res, 200, suggestion);
      }

      /* Write a case, and mirror it into Sage CRM once it is resolved.
         Accepts a console ticket, or a raw case from another producer. */
      if (url.pathname === '/api/cases') {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST' });

        const body = await readBody(req);
        let caseFields = body?.case;
        let event = body?.event ?? null;

        if (!caseFields && body?.ticket) {
          const t = body.ticket;
          caseFields = {
            case_ref: t.id,
            company_id: t.companyId,
            person_id: t.personId ?? null,
            account_ref: t.accountRef ?? null,
            subject: t.subject,
            note: t.messages?.[0]?.text ?? null,
            channel: t.channel ?? null,
            intent: t.intent ?? null,
            category: t.intent ?? null,
            sentiment: t.sentiment ?? null,
            priority: t.priority ?? 'Medium',
            status: t.status,
            owner_email: t.assignee || body.agent || null,
            sla_minutes: t.slaMins ?? null,
            resolution: body.resolution ?? null,
            ai_summary: t.aiSummary ?? null,
            ai_confidence: typeof t.aiConfidence === 'number' ? t.aiConfidence : null,
            ai_escalate: typeof t.escalate === 'boolean' ? t.escalate : null,
            next_action: Array.isArray(t.nextSteps) ? t.nextSteps.join('; ') : null,
            source: 'resolveiq'
          };
          if (!event && body.resolution) {
            event = {
              kind: 'customer_message',
              direction: 'outbound',
              author: body.agent || t.assignee || 'resolveiq',
              body: body.resolution
            };
          }
        }

        if (!caseFields) {
          return sendJson(res, 400, { error: 'Send { "ticket": {...} } or { "case": {...} }.' });
        }

        const saved = await clientiq.upsertCase({ case: caseFields, event });
        queueCache = { at: 0, payload: null };   // the queue has changed

        /* "Saved" is true the moment the case is stored. The Sage CRM
           communication is queued, not sent — the worker applies it within
           about five minutes, so saying "saved to Sage CRM" here would be a
           lie for that whole window. */
        return sendJson(res, 200, {
          ok: true,
          case_ref: saved?.case?.case_ref ?? caseFields.case_ref,
          queued_to_sage: Boolean(saved?.queued_to_sage),
          sage_queue_id: saved?.sage_queue_id ?? null,
          warning: saved?.case?.status === 'resolved' && !saved?.queued_to_sage
            ? 'Saved here, but the Sage CRM copy could not be queued. Reps working in Sage will not see it.'
            : null
        });
      }

      /* Previous contact for one company — the panel that tells an advisor
         whether this customer has been here before. */
      if (url.pathname === '/api/history') {
        const companyId = url.searchParams.get('company_id');
        if (!companyId) return sendJson(res, 400, { error: 'company_id is required' });
        return sendJson(res, 200, { history: await clientiq.activity(companyId) });
      }

      /* Where a queued Sage CRM change has got to. */
      if (url.pathname === '/api/sage-status') {
        const queueId = url.searchParams.get('queue_id');
        if (!queueId) return sendJson(res, 400, { error: 'queue_id is required' });
        return sendJson(res, 200, { status: await clientiq.sageQueueStatus(queueId) });
      }

      /* People at a company, for the contact picker. */
      if (url.pathname === '/api/contacts') {
        const companyId = url.searchParams.get('company_id');
        if (!companyId) return sendJson(res, 400, { error: 'company_id is required' });
        return sendJson(res, 200, { contacts: await clientiq.contacts(companyId) });
      }

      /* Company search, for attaching a case to a customer. */
      if (url.pathname === '/api/companies') {
        const q = url.searchParams.get('q');
        return sendJson(res, 200, { companies: await clientiq.findCompanies(q) });
      }

      if (url.pathname.startsWith('/api/')) {
        return sendJson(res, 404, { error: 'No such endpoint' });
      }

      return await serveStatic(req, res, url.pathname);
    } catch (error) {
      const status = error.status || 500;
      if (status >= 500) console.error('Request failed:', error);
      return sendJson(res, status, { error: error.message || 'Server error' });
    }
  });
}

/* Only listen when run directly, so tests can import createApp(). */
if (process.argv[1] && process.argv[1].endsWith('server/index.mjs')) {
  createApp().listen(config.port, () => {
    console.log(`ResolveIQ on http://localhost:${config.port}`);
    console.log(`  ClientiQ: ${clientiqConfigured ? config.clientiq.url : 'not configured — serving sample data'}`);
    console.log(`  Claude:   ${claudeConfigured ? config.claude.model : 'not configured — drafting disabled'}`);
  });
}
