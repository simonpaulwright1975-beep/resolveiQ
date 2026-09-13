# ResolveIQ

A customer care console for a support team: one screen showing what's waiting,
what's about to breach SLA, and what the AI layer suggests doing about it.

Cases come from **Sage CRM**. Draft replies come from **Claude**. Neither
credential ever reaches the browser.

## What it connects to

**ClientiQ** — the customer database in the WG Main Supabase project. Not Sage
CRM, and not the LAN: ResolveIQ never touches either, so it can run anywhere
with outbound HTTPS.

```
ResolveIQ ──read──►  public.vw_crm_*          companies, contacts, activity
ResolveIQ ──write─►  public.resolveiq_cases   its own cases
          └────────► crm_queue_change ──► on-prem worker ──► Sage CRM
```

Auth is the publishable key plus a **signed-in WG account**. The service-role
key is not supported — it bypasses every permission check, and the app warns
loudly if it finds one in its environment.

## Running it

```bash
npm install
cp .env.example .env     # ClientiQ account + an Anthropic key
npm start                # http://localhost:3000
npm test                 # 20 tests, no credentials needed
```

It runs with nothing configured: no ClientiQ means the sample queue, no API key
means "Draft a reply" explains it is off. The badge says which you are looking
at — `CLIENTIQ · LIVE`, `CLIENTIQ · STALE`, or `SAMPLE DATA`.

## What's on the screen

- **KPI row** — open tickets and the SLA dial are real. Resolved today, average
  handling time, auto-resolved and CSAT show `—` until something supplies them.
- **Open tickets by intent**, and an **SLA compliance dial**.
- **Live queue** — most urgent first: breached, then at risk, then longest
  waiting. Filter by status, search by customer, subject or reference.
- **Ticket drawer** — the case, **previous contact from the customer's real
  activity feed**, and a drafted resolution with a confidence score and an
  escalation flag.

## The key: company_id

Everything is keyed on `company_id`, the Sage CRM company id.

`account_ref` (the Sage 200 code) is carried where present but **never relied
on** — only 2,927 of 28,005 companies (10.5%) have one. A null `account_ref` is
normal, not missing data. An earlier version of this app keyed on `account_ref`
and could only ever have covered a tenth of the customer base.

## Previous contact

Read from `vw_crm_company_activity`, fetched when a case is opened rather than
for the whole queue. Scheduled items are flagged: `occurred_at` is the completed
time where there is one and the booked time where there is not, so a task
diarised for next March would otherwise read as this morning's call.

## Resolving a case

Resolving does two things — both, deliberately:

1. Writes the case to `public.resolveiq_cases`.
2. Queues a Sage CRM communication via `crm_queue_change`, so a rep working in
   Sage rather than ClientiQ still sees the care activity.

**The save happens first, and the case is only marked done if it succeeds.** If
the write fails the case stays open and the advisor is told it has not been
resolved — a case shown as finished when nothing was recorded is the failure
this app exists to prevent.

The Sage copy is **queued, not sent**: the on-prem worker applies it within about
five minutes. The app says "queued", never "saved to Sage CRM", until it is. A
failed queue does not fail the case; the case is saved and the advisor is told
the Sage copy did not go.

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
| `GET` | `/api/health` | What's configured and whether ClientiQ answers. |
| `GET` | `/api/tickets` | The queue. Cached briefly; serves the last good result if ClientiQ is unreachable. |
| `GET` | `/api/history?company_id=` | Previous contact for one company. |
| `GET` | `/api/companies?q=` | Company search, for attaching a case. |
| `GET` | `/api/sage-status?queue_id=` | Where a queued Sage CRM change has got to. |
| `POST` | `/api/suggest` | `{ "ticket": {...} }` → a drafted resolution. |
| `POST` | `/api/cases` | Write a case to the central customer record. Takes `{ "ticket": {...}, "resolution": "..." }` from the console, or `{ "case": {...}, "event": {...} }` from any other producer. |

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

`npm test` runs 20 tests against fake ClientiQ and Anthropic servers speaking
the real wire formats — the client, mapping, HTTP surface and error paths, with
no credentials or network.

**Not yet run against live ClientiQ or a real API key.** The RPC was smoke-tested
directly against WG Main — case stored, company linked, Sage communication
queued, idempotent on a second post — and the test row and its queue entry were
deleted before the on-prem worker could pick them up. Everything else is covered
by the fake servers.

Two things still to build:

1. **Creating a case.** Sage CRM cases are not mirrored into Supabase, so
   ResolveIQ's queue is its own cases and there is no way to raise one yet.
2. **Cases inside ClientiQ.** A third `union all` branch in
   `vw_crm_company_activity` with `source = 'resolveiq'`, plus an open-case count
   on the company card. The column names here (`company_id`, `opened_at`,
   `closed_at`, `status`, `subject`, `note`) were chosen to make that branch
   nearly trivial.

## Static build

`node scripts/build-artifact.mjs` inlines everything into `dist/artifact.html`,
a single self-contained file with no server and no network calls — it renders
the sample queue. Useful for sharing the interface without standing anything up.
