# Database

ResolveIQ's cases live in **WG Main**, alongside ClientiQ, in `public`.

## Applied

| Object | What it is |
|---|---|
| `public.resolveiq_cases` | Customer care cases, keyed on `company_id` |
| `public.resolveiq_case_events` | What was done on a case, internal and customer-facing |
| `public.resolveiq_upsert_case(jsonb)` | The one write path: upserts a case and, once resolved, queues the Sage CRM communication exactly once |

## What was removed, and why

The `core` schema (companies, contacts, cases, case_events, customer_timeline)
was **dropped**. It was keyed on `account_ref`, and only **2,927 of 28,005
companies — 10.5% — have one**. It could never represent the customer base, and
it duplicated `sage_crm.companies`, which is the second customer table this work
was supposed to stop creating.

Nothing was lost: its companies were a backfill of data still present elsewhere,
and its case tables were empty.

## The key

`company_id` — the Sage CRM company id. Present on every company.

`account_ref` (the Sage 200 code) is carried where it exists but never relied
on. Treat a null `account_ref` as normal, not as missing data.

## Reading

Read ClientiQ's `public.vw_crm_*` views, never `sage_crm.*` directly — those are
a mirror whose shape follows Sage CRM's, which is not stable.

`vw_crm_companies` **times out on an unfiltered count**. Always filter by
`company_id`. Company search goes through `vw_crm_company_list`.

## Writing, and the Sage CRM mirror

`resolveiq_upsert_case` stores the case, then calls `crm_queue_change` to queue a
Sage CRM communication when the case is resolved. `sage_queue_id` records that it
has been queued, so it happens once per case however often the case is updated.

The queue is applied on-prem within about five minutes —
`pending` → `sending` → `sent`, or `dead` with a reason after five attempts. So
the app says "queued", never "saved to Sage CRM", until it actually is.

A failed queue does **not** fail the case: the case is saved and the caller is
told the Sage copy did not go, because losing the case would be worse.

## Credentials

Publishable key plus a signed-in WG account. **No service-role key**, ever — it
bypasses every permission check. The app warns if it finds one in its
environment.
