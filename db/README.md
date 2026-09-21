# Database

ResolveIQ's cases live in **WG Main**, alongside ClientiQ, in `public`.

## Applied

| Object | What it is |
|---|---|
| `public.resolveiq_cases` | Customer care cases, keyed on `company_id` |
| `public.resolveiq_case_events` | What was done on a case, internal and customer-facing |
| `public.resolveiq_cases.cof_*` | Cost of failure, with a CHECK constraint that refuses to close an undecided case |
| `public.resolveiq_upsert_case(jsonb)` | The one write path: upserts a case and, once resolved, queues the Sage CRM communication exactly once. Accepts `source` and `source_ref` so a case raised by another app traces back to what produced it. |
| `public.vw_crm_company_activity` | **ClientiQ's view**, extended here with a third `union all` branch so cases appear in the company activity feed |
| `public.vw_crm_company_list` | **ClientiQ's view**, extended here with an `open_cases` count |

## Two ClientiQ views were changed — read this

`vw_crm_company_activity` and `vw_crm_company_list` belong to ClientiQ. Both
were changed **out of band** from this repo:

| File | Change |
|---|---|
| `0001_activity_feed_resolveiq_branch.sql` | A third `union all` branch, `source = 'resolveiq'` |
| `0002_company_list_open_case_count.sql` | An `open_cases` column appended |
| `0006_access_after_clientiq_0027.sql` | Restores writes after ClientiQ 0027, and closes `resolveiq_case_events` |

**Handed over 21 Sep 2026.** Branches are waiting in the owning repos:

| Repo | Branch | File |
|---|---|---|
| `simonpaulwright1975-beep/CRM` (ClientiQ) | `resolveiq/view-extensions-handover` | `db/migrations/0028_resolveiq_view_extensions.sql` |
| `simonpaulwright1975-beep/wg-calls` (Call iQ) | `resolveiq/dialpad-calls-access-handover` | `sql/dialpad_calls_resolveiq_access.sql` |

Both reproduce what is already live, so adopting either is a no-op. Neither has
a pull request open — that is for their owners to raise.

The ClientiQ branch also seeds `resolveiq@waltergeering.co.uk` onto
`clientiq_access`, so a rebuilt environment comes up with ResolveIQ working
rather than silently unable to read anything.

**The Call iQ one is not a formality.** It breaks a rule that app states in its
own CLAUDE.md: *"all RLS-on with NO policies — service-role only"*.
`dialpad_calls` is now the only one of its five tables with a policy and the
only one in the Realtime publication, and both are ours. The file says so, gives
the alternative design, and carries a revert block.

**Both need folding into ClientiQ's own migrations.** Otherwise their next
deploy silently drops ResolveIQ off the feed and blanks the open-case count —
and nobody notices until a rep asks where the care cases went.

### This has already happened once

**15 Sep 2026: `open_cases` was gone.** ClientiQ redeployed
`vw_crm_company_list` — adding spend, margin, product-line and VIP columns —
and the appended column went with it. Re-applied the same day; the view now has
60 columns, ClientiQ's 59 plus `open_cases`.

The activity-feed branch, the Realtime publication and the `dialpad_calls`
policy all survived. So this is not hypothetical and it is not uniform: assume
any out-of-band change is lost on the owning app's next deploy.

ResolveIQ itself did not break, because its company search does not select
`open_cases`. The `calliq-raise-a-case-spec.md` example does, and would have
started returning a PostgREST 400 with no obvious cause.

The list view's existing columns are preserved by reading the live definition
and wrapping it, rather than retyping them — which is why the re-apply picked
up ClientiQ's new columns rather than reverting them.

**`reloptions` are carried through, and this matters.**
`vw_crm_company_list` is `security_invoker=true`. A bare
`create or replace view` **resets reloptions to empty**, which would silently
turn it into a security-*definer* view — running as `postgres` and bypassing
RLS for every app that reads it. The first version of `0002` had exactly that
defect. The migration now reads the options from `pg_class`, re-applies them,
and raises an exception if `security_invoker` is not there afterwards rather
than trusting that it survived.

The existing branches are reproduced exactly. Verified before and after:
`sage_crm` 34,338 rows and `calliq` 2,004 rows, unchanged.

Two decisions in that branch:

- **`comm_id` is negated** (`-case_no`). The feed keys rows on a bigint and
  cases have a uuid; Sage comm_ids are positive, so a negative number cannot
  collide and a row's origin is obvious.
- **Dedup is on whether the Sage communication exists**, not on whether it has
  been queued. Resolving queues a note that lands about five minutes later —
  keying on "queued" would blank the case from the customer's record during
  that window; keying on nothing would leave every resolved case on the
  timeline twice, for ever.

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

### Running without the Sage copy, and catching up later

The Sage push is already decoupled: the case is written first and the queue is
best-effort, so **ResolveIQ works fully with the on-prem worker switched off,
unreachable, or Sage CRM retired entirely**. The only visible difference is a
warning on resolve saying the Sage copy did not go.

Nothing is lost by running that way, because the case row holds everything a
Sage communication needs: `company_id`, `person_id`, `subject`, `note`,
`resolution`, `channel`, `owner_email`, `opened_at` and `closed_at`.
`sage_queue_id` is null exactly when the copy never went, so the backlog
identifies itself:

```sql
select case_ref, company_id, person_id, subject, resolution, closed_at
from public.resolveiq_cases
where status = 'resolved' and sage_queue_id is null
order by closed_at;
```

Replaying those through `crm_queue_change` later is a loop over that query.
`resolveiq_upsert_case` sets `sage_queue_id` when it queues, so a replay is
idempotent per case and cannot double-post.

## Credentials

Publishable key plus a signed-in WG account. **No service-role key**, ever — it
bypasses every permission check. The app warns if it finds one in its
environment.


---

## ClientiQ 0027 broke ResolveIQ's writes — and what was done about it

On 21 September, ClientiQ applied `0027_clientiq_access.sql`, locking the
customer book to a curated list. Right call. Two side effects it did not intend:

**1. ResolveIQ could no longer write anything.** 0027 replaced
`resolveiq_cases_authenticated` (ALL) with `resolveiq_cases_read` (SELECT).
`resolveiq_upsert_case` is `security invoker`, so it runs as the signed-in
user — raising a case, resolving one, recording a cost of failure and storing a
satisfaction score were all denied. Verified: a probe insert as a real account
created 0 rows while reads returned fine.

**2. `resolveiq_case_events` was left wide open.** It kept its original
`using (true)` policy for ALL commands, so every account in the project —
including the five non-hub logins 0027 exists to shut out — could read and write
case notes and customer messages. Tightening the parent and missing the child
left the more sensitive of the two open.

`0006_access_after_clientiq_0027.sql` fixes both, gated on ClientiQ's own
`clientiq_can_read()` rather than a second list that would drift. **Net access
is tighter than before 0027**, not looser: case events go from any authenticated
account to the seven on the list.

Verified end to end as Cerian's account: raise → open, resolve with a
cost-of-failure decision → resolved with the Sage communication queued, and the
case event stored. Probe rows and the queued Sage entry were deleted.

### This cuts both ways

ResolveIQ changed two ClientiQ views without telling ClientiQ, and ClientiQ
broke ResolveIQ's writes without telling ResolveIQ. Same failure, opposite
directions, a week apart. The fix is the same in both: changes to a shared
database belong in the owning repo's migration chain, where the other app's
deploy cannot quietly undo them and the owner can see them coming.
