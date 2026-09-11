/* ResolveIQ server.

   Serves the static console and three JSON endpoints:

     GET  /api/health            what is configured and reachable
     GET  /api/tickets           the queue (Sage CRM, or sample data)
     POST /api/suggest           draft a resolution for one ticket

   Credentials live here and only here. The browser never receives the Sage
   password or the Anthropic API key. */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, sageConfigured, claudeConfigured } from './config.mjs';
import { SageClient } from './sage.mjs';
import { suggestForTicket, SuggestionError } from './suggest.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sage = sageConfigured ? new SageClient() : null;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
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

/* Hold the CRM result briefly so a room full of agents doesn't hammer it. */
let queueCache = { at: 0, payload: null };

async function loadQueue() {
  const sample = await sampleTickets();

  if (!sage) {
    return { ...sample, source: 'sample', reason: 'Sage CRM is not configured' };
  }

  const fresh = Date.now() - queueCache.at < config.sage.cacheSeconds * 1000;
  if (fresh && queueCache.payload) return queueCache.payload;

  try {
    const tickets = await sage.tickets();
    const payload = {
      team: sample.team,
      currentAgent: sample.currentAgent,
      metrics: deriveMetrics(tickets, sample.metrics),
      tickets,
      source: 'sage'
    };
    queueCache = { at: Date.now(), payload };
    return payload;
  } catch (error) {
    console.error('Sage CRM query failed:', error.message);
    /* Serving a stale queue beats serving none. */
    if (queueCache.payload) {
      return { ...queueCache.payload, source: 'sage-stale', reason: error.message };
    }
    return { ...sample, source: 'sample', reason: `Sage CRM unreachable — ${error.message}` };
  }
}

/* Only report what the CRM can actually answer. Handling time, CSAT and
   automation rate are not Sage CRM columns, so they come back null and the UI
   shows them as unavailable rather than borrowing a sample figure — a real
   number beside a fake comparator is worse than no number. */
function deriveMetrics(tickets, base) {
  const open = tickets.filter((t) => t.status !== 'resolved');
  return {
    resolvedToday: tickets.filter((t) => t.status === 'resolved').length,
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
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
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
        let sageReachable = null;
        if (sage) {
          try {
            await sage.entities();
            sageReachable = true;
          } catch {
            sageReachable = false;
          }
        }
        return sendJson(res, 200, {
          ok: true,
          sage: { configured: sageConfigured, reachable: sageReachable, baseUrl: redact(config.sage.baseUrl) },
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

/* Never echo credentials embedded in a URL back to a client. */
function redact(urlString) {
  if (!urlString) return null;
  try {
    const u = new URL(urlString);
    u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    return null;
  }
}

/* Only listen when run directly, so tests can import createApp(). */
if (process.argv[1] && process.argv[1].endsWith('server/index.mjs')) {
  if (config.sage.allowInsecureTls) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    console.warn('TLS verification disabled for Sage CRM (SAGE_ALLOW_INSECURE_TLS=true)');
  }
  createApp().listen(config.port, () => {
    console.log(`ResolveIQ on http://localhost:${config.port}`);
    console.log(`  Sage CRM: ${sageConfigured ? config.sage.baseUrl : 'not configured — serving sample data'}`);
    console.log(`  Claude:   ${claudeConfigured ? config.claude.model : 'not configured — drafting disabled'}`);
  });
}
