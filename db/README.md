# Database

The shared WG customer record lives in the **WG Main** Supabase project, not in
a database belonging to ResolveIQ. ResolveIQ reads and writes it like any other
app in the estate.

## Status

**Nothing here has been applied.** These migrations are for review first —
`0001` adds a schema to a live database that several applications already use.

| File | What it does |
|---|---|
| `0001_core_customer_record.sql` | Creates the `core` schema: companies, contacts, cases, case events, and the customer timeline view. Additive only — it alters no existing table. |
| `0002_backfill_companies_from_sage.sql` | Populates `core.companies` from the 2,669 customers already synced in `public.sage_customers`. Re-runnable; never overwrites rows edited by hand. |

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
