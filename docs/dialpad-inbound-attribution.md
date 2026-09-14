# Why inbound calls have no rep, and what would fix it

For whoever owns the Dialpad sync in Call iQ.

**Short version: this cannot be fixed from the data already stored.** The person
who answered is not in the payload. It needs a change to what the sync captures.

---

## The problem

`dialpad_calls.rep_email` is null on **3,227 of 6,005 calls (54%)**, and worst
where it matters most:

| Direction | Calls | Attributed to a rep |
|---|---|---|
| Outbound | 4,347 | 2,279 — 52.4% |
| **Inbound** | **1,658** | **499 — 30.1%** |

Inbound is the customer-service case. Seven in ten of those calls do not record
who took them.

This blocks the "raise a case from a call" card
(`calliq-raise-a-case-spec.md`): the RLS policy on `dialpad_calls` shows a rep
their own calls, and a call with no rep belongs to nobody, so no card appears.

---

## Root cause

For the 1,167 unattributed inbound calls that still have their raw payload:

| What the payload says | Count |
|---|---|
| `target.type = 'department'` | 605 |
| `target.type = 'office'` | 531 |
| `target.type = 'coaching_team'` | 31 |
| **`target.type = 'user'`** | **0** |
| `entry_point_target.type = 'user'` | 0 |
| `proxy_target.type = 'user'` | 0 |
| `routing_breadcrumbs` non-empty | 0 |
| `transferred_from` present | **1,167 — all of them** |
| Payload mentions any `@waltergeering` address | 9 |

The call is recorded against **the department, office or team that received it**,
never the individual who picked up. `target.email` is populated on all 1,167 —
but it is the department's address, not a person's.

Every one of these calls was transferred, which fits: the call lands on a group
number, rings the group, and the webhook that gets stored describes the *group
leg*. The leg where a named user answers is a different call object.

### The answering leg is not stored either

`master_call_id` groups the legs of one call. Of the 1,167:

- 576 carry a `master_call_id`
- 284 have any sibling row stored at all
- **10 have a sibling that names a rep**

And `dialpad_call_events` — the obvious place for per-leg events — is **empty,
0 rows**.

So there is nothing to join to. The information has never been captured.

---

## What would fix it

### Option A — capture the operator leg (the real fix)

Dialpad emits an event per call leg. The stored payload is the group leg; the
one naming the user who answered is a separate object, reachable either by:

- subscribing to the per-user call events as well as the group ones, or
- on receiving a group-leg webhook, calling Dialpad's API for the call's
  participants / operator leg using `master_call_id` or `operator_call_id`
  (both are present in the payload today) and writing the answering user into
  `rep_email`.

The second needs no webhook reconfiguration — just an extra API call in the sync
when `target.type` is not `user`.

This is the only option that attributes a call to a person.

### Option B — attribute to the team instead

The department **is** reliably recorded — `target.email` and `target.name` are
present on 100% of these calls. So calls could be attributed to a team, and reps
could see their team's calls rather than only their own.

Fixable in the database, since it only re-reads `raw`. **Not applied** — it adds
a column to Call iQ's table and changes who can see what, so it is theirs to
decide:

```sql
alter table public.dialpad_calls
  add column if not exists answered_by_team text;

update public.dialpad_calls
set answered_by_team = raw->'target'->>'name'
where answered_by_team is null
  and raw->'target'->>'type' in ('department','office','coaching_team');
```

The policy would then need a membership table — which users are in which team —
and there is no such table today. `sage_user_map`, `crm_user_map` and
`hub_allowed_emails` exist but none of them is a team roster.

**Option B is weaker than it looks.** It tells you a call reached Customer
Service; it does not tell you who dealt with it, so per-advisor SLA, handling
time and workload stay unavailable.

### Option C — the server route, and no attribution at all

For the wrap-up card specifically, Call iQ can subscribe to Realtime from a
server using the service key, which bypasses RLS, and decide in its own code who
to show the card to. This works today with no changes.

It sidesteps the problem rather than solving it: the card can be shown, but the
resulting case still records no advisor, and `resolveiq_cases.owner_email` would
be whoever raised it rather than whoever took the call.

---

## Recommendation

**Option A.** It is the only one that produces a real answer, and everything
downstream — per-advisor SLA, handling time, who dealt with a customer, the
wrap-up card reaching the right person — depends on knowing who answered.

Until it is done, use **Option C** to unblock the card, and treat inbound
per-advisor reporting as unavailable rather than approximating it. A workload
figure built on 30% attribution is worse than no figure, because people will act
on it.

This is also bigger than the case card: **54% of all calls not being attributable
to a person** limits any coaching, scoring or performance work Call iQ does on
inbound.

---

## What was checked

All figures are from WG Main on 14 September 2026, against `dialpad_calls`
(6,005 rows), its `raw` payloads, and `dialpad_call_events` (0 rows). Nothing
was changed by this investigation.
