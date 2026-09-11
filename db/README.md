# Database

The shared WG customer record lives in the **WG Main** Supabase project, not in
a database belonging to ResolveIQ. ResolveIQ reads and writes it like any other
app in the estate.

## Status

**Applied to WG Main.**

| File | What it does |
|---|---|
| `0001_core_customer_record.sql` | Creates the `core` schema: companies, contacts, cases, case events, and the customer timeline view. Additive only — it alters no existing table. |
| `0002_backfill_companies_from_sage.sql` | Populates `core.companies` from the 2,669 customers already synced in `public.sage_customers`. Re-runnable; never overwrites rows edited by hand. |
| `0003_null_unknown_company_status.sql` | Corrects 0002: company status was being asserted from a Sage column that turned out to hold one value for every row. |

Live counts after applying:

| | |
|---|---|
| `core.companies` | 2,669 (2,150 with a phone, 2,557 with an email) |
| `core.contacts` | 0 — the Sage person sync has not run |
| `core.cases` | 0 — nothing writes them yet |
| `core.customer_timeline` | 27,824 rows across 1,693 accounts |

Timeline by source: `sage_crm` 26,388 · `calliq` 1,426 · `reorderradar` 10 ·
`resolveiq` 0. 1,671 of those accounts match a company row.

## Gaps found in the source data

Two things the customer card needs that Sage is not currently supplying. Both
are sync problems on WG-SQL-01, not schema problems:

- **Addresses are empty.** `sage_customers` has `address_line1`, `town` and
  `postcode` columns and all 2,669 rows are blank. No company has an address.
- **Customer status is unknowable.** `account_status` is `0` for every row, and
  `sage_orders` holds open orders only, so lapsed cannot be inferred from order
  recency either. Status is left NULL rather than guessed.

## Why `core` and not `resolveiq_*`

`public` already contains `meetiq_customers`, `appt_customers`,
`rebates_customers`, `reorder_customers`, `brochures_customers`,
`donna_customer_extras`, plus four separate contact tables. Every app brought
its own copy of the customer. Adding `resolveiq_customers` would repeat that.

`core` is the one place a customer exists. Apps join it; they don't copy it.

## What already exists

Most of the spine is there. This does not rebuild it:

- `public.sage_customers` — 2,669 customers, synced from Sage
- `public.crm_communications` — 26,388 communications across 1,615 accounts
- `public.dialpad_calls` — 5,771 calls with `customer_account_match` and AI recaps
- `public.call_transcripts` — 772 transcripts
- `public.crm_comm_pushes` — the Call iQ → Sage push queue
- `public.vw_customer_conversations` — the existing timeline view

`account_ref` (the Sage account reference) is already the join key across all of
them, so `core` keeps it.

## Sage independence

`sage_customers` is a mirror: its identity is Sage's `customer_id` and the sync
overwrites it. A record whose identity belongs to Sage cannot outlive Sage.

`core.companies` owns its own `id` and treats `account_ref` as one identifier
among several. When Sage is switched off, `account_ref` becomes ordinary legacy
reference data and nothing else has to change.

## Adding a source to the timeline

Add a `UNION ALL` branch to `core.customer_timeline`. Never copy rows into a
table — a copied timeline drifts from its sources.
