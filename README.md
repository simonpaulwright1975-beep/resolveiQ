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
npm start                # http://localhost:3000  (console: /console)
npm test                 # 37 tests, no credentials needed
```

It runs with nothing configured: no ClientiQ means the sample queue, no API key
means "Draft a reply" explains it is off. The badge says which you are looking
at — `CLIENTIQ · LIVE`, `CLIENTIQ · STALE`, or `SAMPLE DATA`.

## What's on the screen

- **KPI row** — computed from `resolveiq_cases`: open tickets, resolved today
  (against yesterday), AI-assisted, average handling time, and the SLA dial.
  CSAT shows `—` because nothing collects a score yet.
- **What the numbers mean** — a tab explaining each figure, how it is worked out
  and what to do about it, written for the advisor rather than for a manager.
- **Open tickets by intent**, and an **SLA compliance dial**.
- **Live queue** — most urgent first: breached, then at risk, then longest
  waiting. Filter by status, search by customer, subject or reference.
- **Ticket drawer** — the case, **previous contact from the customer's real
  activity feed**, and a drafted resolution with a confidence score and an
  escalation flag.

## The KPI row

Every figure is counted from `resolveiq_cases`, and anything without a source
stays blank rather than reading zero — a dash is honest, an invented number gets
acted on.

| Figure | Where it comes from |
|---|---|
| Open tickets | Cases not resolved. |
| Resolved today | Closed since **London** midnight, against the same count yesterday. |
| AI-assisted | Share of today's resolved cases carrying an `ai_confidence`, i.e. where the drafted reply was used. |
| Avg handling time | Mean minutes from `opened_at` to `closed_at` across today's resolved cases. |
| CSAT | `satisfaction_score`. Nothing writes to it yet, so this shows `—`. |
| SLA compliance | Open cases still inside the window their priority gives them. |

**"Today" is a UK day, not a UTC one.** Through British Summer Time a UTC
boundary puts an hour of every evening into tomorrow's figures, so a case closed
at 11:30pm in July would land on the wrong day. The boundary is computed in
`Europe/London`, and a test pins it.

**Nothing is auto-resolved.** The card that used to say so had no source behind
it — every case is closed by a person. It now reports whether the AI draft was
used, which is a real, recorded thing.

If the KPI read fails, the queue is still served. Losing the figures must not
cost the advisor her work.

## Raising a case

**New case** in the masthead. Search for the customer by name or Sage account
code, pick them, optionally name a contact, then subject, detail, channel and
priority.

The company is not optional and the form will not submit without one — a case
with no `company_id` cannot reach a customer record, and the database refuses
it. Everything else can be filled in later.

The case reference is issued by the database rather than the browser, so two
agents raising a case at the same moment cannot collide. A new case is **not**
mirrored into Sage CRM; that happens when it is resolved.

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

## Email identity

ResolveIQ **sends no email**. There is no SMTP, no Graph, no mail integration
of any kind — it drafts a reply and the advisor sends it herself. So there is
no From address for the app to get wrong today. What there is, is identity that
must not leak.

Three addresses, deliberately separate:

| | Setting | What it is |
|---|---|---|
| **Customer-facing** | `RESOLVEIQ_TEAM_EMAIL` | `customerservice@waltergeering.co.uk`. What customers see and reply to. Drafts sign off as the team, point replies here, and are forbidden from naming an individual or inventing a direct line. |
| **Case owner** | `RESOLVEIQ_ADVISOR_EMAIL` | The advisor working the queue. There is no login, so it is configured. Blank falls back to the team address. |
| **Sign-in** | `RESOLVEIQ_SUPABASE_EMAIL` | A machine credential. Generic, internal, never customer-facing, and never the owner of a case. |

The third was previously presented to the browser as the current agent, which
meant a service account would have owned every case Cerian raised. It no longer
is, and a test fails if that ever comes back.

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

## Pages

| Path | What it is |
|---|---|
| `/` | The Walter Geering landing page — the WG Platforms front door. |
| `/console` | The customer care console. **Bookmark this** to go straight to work. |

The landing page is one reusable template shared across the iQ suite: the
illustrated environment and composition are fixed, and only the logo, name,
strapline and entry wording change. See `docs/wg-platforms-theme.md`.

The illustration is in place. `assets/landing-scene.png` is the master as
supplied (2.0 MB); `assets/landing-scene.webp` is what gets served (137 KB) —
regenerate it from the PNG if the artwork is ever revised.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | What's configured and whether ClientiQ answers. |
| `GET` | `/api/tickets` | The queue, the KPI figures and the SLA windows. Cached briefly; serves the last good result if ClientiQ is unreachable. |
| `GET` | `/api/history?company_id=` | Previous contact for one company. |
| `GET` | `/api/companies?q=` | Company search, for attaching a case. |
| `GET` | `/api/contacts?company_id=` | People at a company, for the contact picker. |
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

`npm test` runs 37 tests against fake ClientiQ and Anthropic servers speaking
the real wire formats — the client, mapping, HTTP surface and error paths, with
no credentials or network.

### The live smoke test

```bash
node scripts/smoke-live.mjs        # needs .env and outbound HTTPS to WG Main
```

This is the only thing that exercises the real path end to end: sign in to
GoTrue, read through PostgREST, raise a case through the RPC, confirm it reaches
the queue and the customer's timeline, then delete it again.

It refuses to run if a service-role key is set, because bypassing RLS would make
it pass for reasons that say nothing about a real session. It never resolves a
case, so it cannot put a note on a real customer's Sage record.

### What has actually been verified

| | |
|---|---|
| Write path, as a real advisor's account | **Verified.** Case raised against J&A PELLING LTD by `authenticated` with Cerian's claims, appeared on `vw_crm_company_activity` as `source='resolveiq'`, counted in `open_cases`, appeared in the open queue, then deleted — with no Sage queue entry created, which is correct for an unresolved case. |
| Read path, as a plain signed-in account | **Verified** by impersonation: all four `vw_crm_*` views, plus a live name search. |
| Everything else | Covered by the fake servers. |
| **The HTTP sign-in hop** | **Still unverified.** Needs a machine with outbound HTTPS to WG Main — run the smoke test above and it is closed. |

Still to build:

1. **Cases inside ClientiQ.** A third `union all` branch in
   `vw_crm_company_activity` with `source = 'resolveiq'`, plus an open-case count
   on the company card. The column names here (`company_id`, `opened_at`,
   `closed_at`, `status`, `subject`, `note`) were chosen to make that branch
   nearly trivial.

## Static build

`node scripts/build-artifact.mjs` inlines everything into `dist/artifact.html`,
a single self-contained file with no server and no network calls — it renders
the sample queue. Useful for sharing the interface without standing anything up.
