/* Stand-in servers for the two external systems, so the real client code can be
   exercised end to end without a CRM box or an API key.

   The Sage responses are Atom XML, matching what the Geerings install actually
   returns (it rejects Accept: application/json). Namespace prefixes are
   deliberately non-obvious here so the parser can't rely on them. The Anthropic
   response uses the Messages API shape the SDK parses. */

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

export const SAGE_CASES = [
  {
    $key: 41,
    $title: 'Refund not received',
    case_referenceid: 'CAS-0041',
    case_description: 'Refund not received after 10 days',
    case_problemnote: 'Ten days and still nothing back. This is the second time I have chased.',
    case_status: 'In Progress',
    case_priority: 'High',
    case_opened: new Date(Date.now() - 34 * 60000).toISOString(),
    case_assigneduserid: 'Priya S.',
    Company: { $key: 7, $title: 'Blake Retail Ltd' },
    Person: { $key: 19, $title: 'Owen Blake' }
  },
  {
    $key: 42,
    $title: 'Parcel missing',
    case_referenceid: 'CAS-0042',
    case_description: 'Parcel marked delivered but nothing arrived',
    case_problemnote: 'Tracking says delivered but there is no parcel and no card through the door.',
    case_status: 'New',
    case_priority: 'Medium',
    case_opened: new Date(Date.now() - 4 * 60000).toISOString(),
    Company: { $key: 8, $title: 'Booth Supplies' },
    Person: { $key: 20, $title: 'Hannah Booth' }
  },
  {
    /* Deliberately awkward: no reference, no prefix on field names, closed. */
    $key: 43,
    $title: 'CSV export question',
    description: 'How do I export my data to CSV?',
    status: 'Closed',
    priority: 'Low',
    opened: new Date(Date.now() - 300 * 60000).toISOString()
  }
];

export function fakeSage({ failWith = null, format = 'xml', onRequest = null } = {}) {
  return startServer((req, res) => {
    if (onRequest) onRequest(req);
    if (failWith) {
      res.writeHead(failWith, { 'Content-Type': 'text/plain' }).end('upstream error');
      return;
    }

    const url = new URL(req.url, 'http://localhost');
    const auth = req.headers.authorization || '';

    const expected = 'Basic ' + Buffer.from('apiuser:secret').toString('base64');
    if (auth !== expected) {
      res.writeHead(401, { 'Content-Type': 'text/plain' }).end('bad credentials');
      return;
    }

    const json = (body) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    const xml = (body) => {
      res.writeHead(200, { 'Content-Type': 'application/atom+xml; charset=utf-8' });
      res.end(body);
    };

    if (url.pathname.endsWith('/$prototypes')) {
      return json({ EntityList: [{ EntityName: 'case' }, { EntityName: 'company' }] });
    }

    if (url.pathname.endsWith('/case')) {
      return format === 'json'
        ? json({
            $totalResults: SAGE_CASES.length,
            $startIndex: 1,
            $itemsPerPage: SAGE_CASES.length,
            $resources: SAGE_CASES
          })
        : xml(feed(SAGE_CASES, 'case'));
    }

    if (url.pathname.endsWith('/communication')) {
      return xml(feed([{
        $key: 91,
        comm_datetime: '2026-08-12T09:00:00Z',
        comm_note: 'Late delivery — goodwill credit'
      }], 'communication'));
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('no such entity');
  });
}

/* Minimal Messages API stand-in. Records the request the SDK sent so the test
   can assert on model, thinking config and output schema. */
export function fakeAnthropic({ refuse = false } = {}) {
  const received = [];

  const suggestion = {
    intent: 'Billing',
    sentiment: 'angry',
    summary: 'Refund issued 10 days ago has not reached the customer.',
    reply: 'Hello Owen,\n\nThank you for chasing this.',
    nextSteps: ['Check the refund status against the acquirer', 'Confirm the card on file is current'],
    confidence: 0.83,
    escalate: false,
    escalationReason: ''
  };

  return startServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    received.push({ path: req.url, body });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: body.model || 'claude-opus-5',
        content: refuse ? [] : [{ type: 'text', text: JSON.stringify(suggestion) }],
        stop_reason: refuse ? 'refusal' : 'end_turn',
        stop_details: refuse ? { type: 'refusal', category: 'other', explanation: 'declined' } : null,
        usage: { input_tokens: 400, output_tokens: 120 }
      })
    );
  }).then((s) => Object.assign(s, { received, suggestion }));
}

/* ---------- Atom XML construction ---------- */

const escapeXml = (v) =>
  String(v).replace(/[<>&'"]/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

/* Render one fixture object as an SData payload element. Nested objects become
   linked entities carrying their own key, exactly as Sage returns them. */
function payload(record, entityName) {
  const key = record.$key;
  const fields = Object.entries(record)
    .filter(([k]) => !k.startsWith('$'))
    .map(([k, v]) => {
      if (v && typeof v === 'object') {
        const inner = Object.entries(v)
          .filter(([ik]) => !ik.startsWith('$'))
          .map(([ik, iv]) => `<${ik}>${escapeXml(iv)}</${ik}>`)
          .join('');
        const title = v.$title ? `<comp_name>${escapeXml(v.$title)}</comp_name>` : '';
        return `<${k} crm:key="${escapeXml(v.$key ?? '')}">${title}${inner}</${k}>`;
      }
      return `<${k}>${escapeXml(v)}</${k}>`;
    })
    .join('');

  return `<${entityName} crm:key="${escapeXml(key ?? '')}">${fields}</${entityName}>`;
}

export function feed(records, entityName) {
  const entries = records
    .map(
      (r) => `  <entry>
    <title>${escapeXml(r.$title || '')}</title>
    <crm:payload>${payload(r, entityName)}</crm:payload>
  </entry>`
    )
    .join('\n');

  /* "crm:" rather than the conventional "sdata:" — the parser must match on
     local names, not on a prefix it happens to expect. */
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:crm="http://schemas.sage.com/sdata/2008/1"
      xmlns:os="http://a9.com/-/spec/opensearch/1.1/">
  <os:totalResults>${records.length}</os:totalResults>
  <os:startIndex>1</os:startIndex>
  <os:itemsPerPage>${records.length}</os:itemsPerPage>
${entries}
</feed>`;
}
