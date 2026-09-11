# ResolveIQ

A customer care console for a support team: one screen showing what's waiting,
what's about to breach SLA, and what the AI layer suggests doing about it.

Cases come from **Sage CRM**. Draft replies come from **Claude**. Neither
credential ever reaches the browser.

## Where this has to run

**Sage CRM is LAN-only.** It lives at `http://WG-SQL-01/...`, which is not
reachable from outside the Geerings network. So this app's server must run on
WG-SQL-01 or another machine on that LAN. A cloud-hosted copy will always fall
back to sample data, however it is configured.

Claude drafting needs outbound HTTPS to `api.anthropic.com`, so whichever box
runs it needs the CRM on one side and the internet on the other.

## Running it

```bash
npm install
cp .env.example .env     # fill in your Sage CRM details and API key
npm run check-sage       # verify the connection before starting
npm start                # http://localhost:3000
```

`npm run check-sage` reports what the CRM actually returns: whether it answers,
which entities are exposed to web services, the field names on the case entity,
and whether the mapping resolves them. It prints **names and counts only, never
field values**, so the output is safe to share.

It runs with nothing configured: no Sage CRM means the queue falls back to
bundled sample tickets, and no API key means the "Draft a reply" button returns
a clear message instead of a draft. The badge in the top right always says which
source you're looking at — `SAGE CRM · LIVE`, `SAGE CRM · STALE`, or
`SAMPLE DATA`.

```bash
npm test                 # 26 tests, no credentials needed
```

## What's on the screen

- **KPI row** — open tickets, resolved today, auto-resolved share, average
  handling time, CSAT.
- **Open tickets by intent** — where the volume actually is.
- **SLA compliance gauge** — share of open cases still inside their window.
- **Live queue** — sorted most urgent first: breaching, then at-risk, then
  longest waiting. Filter by status, search by customer, subject or reference.
- **Ticket drawer** — the conversation, previous contact, and a drafted
  resolution with a confidence score, suggested next steps and an escalation
  flag. Claim, snooze, or send-and-resolve.

## Sage CRM integration

`server/sage.mjs` talks to Sage CRM's SData REST API. The contract was taken
from Sage's own reference client
([Sage/sage_crm_rest_api_client](https://github.com/Sage/sage_crm_rest_api_client)):

| | |
|---|---|
| Base URL | `{server}/sdata/{install}j/{contract}/-/` |
| Geerings | `http://WG-SQL-01/sdata/crmj/sagecrm/-/` |
| Auth | HTTP Basic — the CRM user needs **Allow Webservices = True** |
| Format | **Atom XML.** This install errors on `Accept: application/json` |
| Collection | `GET {base}case` → an Atom feed of `<entry>` / `<payload>` elements |
| Record | `GET {base}case('41')` → a single entry |
| Metadata | `GET {base}$prototypes` — every entity exposed to web services |

The contract segment differs between installs (`sagecrm` here, `sagecrm2`
elsewhere), so it's configurable via `SAGE_CONTRACT`.

`server/sdata-xml.mjs` flattens the Atom feed into the same record shape a JSON
reply would give, so the mapping layer is unchanged by the transport. It matches
on **local element names**, not namespace prefixes, since servers choose their
own. If an install does serve JSON, the client still handles it — it branches on
the response content type.

Support **cases** are the queue. Linked `Company` and `Person` records supply
the customer, and `communication` records supply previous contact.

### Field names

Sage CRM installs rename columns and add custom fields, so nothing assumes a
single spelling. Every read goes through `pick()`, which tries a list of
candidates and matches case-insensitively with or without the entity prefix —
`case_description`, `Description` and `description` all resolve. A field it
can't find falls back to a default rather than throwing, so one renamed column
can't take the queue offline.

If your install uses names nothing matches, add them to the candidate lists in
`mapCase()` — that function is the whole mapping, and it's unit-tested.

### Derived fields

Three things the console shows are not Sage CRM columns, so they're computed:

- **SLA window** — from case priority, via `SLA_POLICY` (default: High 20min,
  Medium 60, Low 240). A case is *breached* once the wait exceeds the window and
  *at risk* from 70% of it.
- **Intent** and **sentiment** — keyword rules over the case text, as a first
  pass. When you draft a reply, Claude's own reading of both replaces the guess.
- **Status** — Sage's status/stage vocabulary is mapped onto the four the UI
  uses (`new`, `open`, `pending`, `resolved`); "Closed", "Awaiting Customer" and
  friends all land somewhere sensible.

Metrics the CRM genuinely cannot answer — average handling time, CSAT,
automation rate — render as `—` with "not tracked in Sage CRM" rather than
borrowing a number. Wire them to whatever system does hold them, or drop the
tiles.

### Writes need SOAP, not SData

SData is read-only. Creating or updating records goes through the SOAP endpoint
at `{server}/CRM/eware.dll/webservice` — logon, then carry the session in a
`<SessionHeader>` for add/update/query/delete. **This app does not write to the
CRM at all yet**; it only reads. The Call iQ worker
(`wg-calls/onprem/sage-crm-worker/`) has working SOAP helpers and the
hard-won gotchas (field-prefix stripping, the plural `users` entity, `comm_link`
linking, the buggy delete) if writes are added later.

## Claude integration

`server/suggest.mjs` calls the Messages API through the official SDK, on
`claude-opus-5` with adaptive thinking. The response is constrained by a schema,
so the UI gets a predictable object rather than prose to parse:

```
{ intent, sentiment, summary, reply, nextSteps[], confidence, escalate, escalationReason }
```

The system prompt tells the model it is drafting *for the agent*, forbids
inventing order numbers, refund amounts or policy terms, and asks it to flag
cases needing authority the agent may not have. Drafts are generated on request
— one call per click, never in bulk — and nothing is sent to a customer until
the agent sends it.

A policy decline (`stop_reason: "refusal"`) is surfaced as an error rather than
read as an empty draft. If you want the API to retry a refusal on a fallback
model inside the same call, add the `fallbacks` parameter — see the
[server-side fallbacks docs](https://platform.claude.com/docs/en/api/messages).

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | What's configured and whether the CRM answers. Credentials are redacted. |
| `GET` | `/api/tickets` | The queue. Cached for `SAGE_CACHE_SECONDS`; serves the last good result if the CRM goes down. |
| `POST` | `/api/suggest` | `{ "ticket": {...} }` → a drafted resolution. |

## Configuration

See `.env.example`. `.env` is gitignored — don't commit credentials.

App settings are namespaced `RESOLVEIQ_*` so they can't collide with an ambient
`CLAUDE_*` variable in your shell.

## Security notes

- The Sage password and the Anthropic API key stay in the server process. The
  browser only ever sees mapped ticket data and drafts.
- `/api/health` redacts any credentials embedded in the base URL.
- Static file serving is path-traversal checked (tested).
- `SAGE_ALLOW_INSECURE_TLS` exists for on-premise boxes with an internal CA. It
  disables certificate verification for the whole process — use it only on a
  trusted network, and prefer installing the CA certificate properly.

## Testing

`npm test` runs 26 tests against fake Sage CRM and Anthropic servers that speak
the real wire formats, so the client code, mapping, HTTP surface and error paths
are all exercised without credentials or network access.

**Not yet run against the live CRM or a real API key.** The transport details
(LAN-only, XML not JSON, the `sagecrm` contract segment, Basic auth) come from
the working Call iQ connection. The Atom element structure is the standard SData
shape and is covered by tests, but the first real response is what will confirm
it — that is what `npm run check-sage` is for.

Two things are genuinely unknown until then:

1. **Whether the `case` entity is exposed to web services** on this install. The
   Call iQ worker uses company/person/communication/comm_link/users. If cases
   aren't exposed, the queue needs either that entity enabled or a different
   source. `check-sage` answers this in section 2.
2. **The exact case field names.** `check-sage` prints them in section 3.

## Static build

`node scripts/build-artifact.mjs` inlines everything into `dist/artifact.html`,
a single self-contained file with no server and no network calls — it renders
the sample queue. Useful for sharing the interface without standing anything up.
