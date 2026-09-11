/* Stand-in servers for the two external systems, so the real client code can be
   exercised end to end without a CRM box or an API key.

   The Sage responses use the envelope documented by Sage's own reference client
   ($totalResults / $resources / $key), and the Anthropic response uses the
   Messages API shape the SDK parses. */

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

export function fakeSage({ failWith = null } = {}) {
  return startServer((req, res) => {
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

    if (url.pathname.endsWith('/$prototypes')) {
      return json({ EntityList: [{ EntityName: 'case' }, { EntityName: 'company' }] });
    }

    if (url.pathname.endsWith('/case')) {
      return json({
        $totalResults: SAGE_CASES.length,
        $startIndex: 1,
        $itemsPerPage: SAGE_CASES.length,
        $resources: SAGE_CASES
      });
    }

    if (url.pathname.endsWith('/communication')) {
      return json({
        $totalResults: 1,
        $resources: [{ comm_datetime: '2026-08-12T09:00:00Z', comm_note: 'Late delivery — goodwill credit' }]
      });
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
