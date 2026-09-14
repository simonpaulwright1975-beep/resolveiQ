# Call iQ — "Raise a case" on a finished call

A spec for whoever builds this in Call iQ. It lets a customer service advisor
turn a call into a ResolveIQ case with one tap, without leaving Call iQ.

Everything below is measured against WG Main, not assumed. The numbers are the
point: several of them argue against the obvious design.

---

## Why this belongs in Call iQ, not ResolveIQ

`dialpad_calls.dismissed_at` is set on **2,545 of 5,771 calls**. Advisors
already meet a post-call card in Call iQ and already act on it. A second popup,
from a second app, competing for the same three seconds after hang-up, gets both
of them ignored.

Call iQ owns the moment. ResolveIQ owns the case. This spec joins them.

---

## What the data actually supports

### The card appears *after* the call, not during it

There is **no row for a call in progress** — zero, across 5,771 calls. The row
is written when the call ends, and it arrives fast: **median 2 seconds**, 90th
percentile 4 seconds.

So this is a wrap-up prompt. That is probably better anyway: she knows what the
call was about once it has happened, and an advisor mid-call has a customer
talking at her.

*An in-call popup would need a Dialpad webhook on call **start**, which nothing
currently captures, and the row would have no AI recap yet. Out of scope unless
someone can justify the interruption.*

### The customer is unknown three times out of four

| `match_confidence` | Calls | |
|---|---|---|
| `none` | 4,335 | 75% |
| `normalised` | 1,361 | 24% |
| `ambiguous` | 65 | matches more than one company |

Only **1,426 of 5,771** calls resolve to an account from the phone number.

**Design for "we don't know who this is" as the normal case.** A card that
assumes pre-filled customer details will be wrong most of the time. It needs a
company search, and for the 65 ambiguous ones it must ask rather than guess.

### The AI recap is not there most of the time

| | Last 30 days | Older |
|---|---|---|
| Calls | 4,937 | 834 |
| With a recap | **804 (16.3%)** | 127 (15.2%) |
| Never processed (`processing_state = 'new'`) | 1,485 | 224 |
| With a stored transcript | **0** | **0** |

For calls over a minute — the ones likely to be real conversations — it is
better but still short of half: **628 of 1,314 (47.8%)**.

This is current behaviour, not a backlog: the recent rate matches the old one.

**So the advisor still writes the note.** The recap is a bonus when it exists,
not the mechanism. Build the card around a note field she fills, pre-filled from
`recap_summary` when there is one. Building it the other way round means five
cases out of six arrive with an empty description.

*Separately worth someone's attention: 1,485 recent calls sat in
`processing_state = 'new'` and 233 are `failed`. If that pipeline were healthy
this feature would be materially better. It is a Call iQ problem, not a blocker
for this.*

### A cold dropdown will not get filled in

`dialpad_calls.call_type` already exists. It is populated on **100 of 5,771**
calls — 1.7%.

A category field is already there and advisors do not use it. Asking "what type
of customer service call is this?" as a cold list will go the same way.

**Make raising the case one tap. Make the type a correction, not a decision.**
Pre-select it, let her change it if it is wrong. Confirming a suggestion is a
tap; choosing from a list under time pressure is work.

There is no existing customer-service taxonomy to reuse — `call_intents` is
Call iQ's *pre-dial* intent (outbound only) and `call_playbooks` is the sales
conversation ladder (First Contact, Discovery, Progress, Closing, Customer
Success). Use ResolveIQ's, below, which is what the queue already groups by and
what its AI already classifies into.

---

## The card

Shown when a call ends, to the rep who took it.

```
┌────────────────────────────────────────────┐
│  Call ended · 4m 12s · inbound             │
│                                            │
│  J&A PELLING LTD            ← when matched │
│  Owen Blake · 01227 …                      │
│  ───────────────── or ─────────────────    │
│  01227 770099               ← 75% of calls │
│  [ Search for the customer…            ]   │
│                                            │
│  What happened?                            │
│  [ pre-filled from the recap if there is   │
│    one, otherwise empty and focused     ]  │
│                                            │
│  Type  [ Billing ▾ ]   Priority [ Medium ▾]│
│                                            │
│  [ Raise a case ]              [ Dismiss ] │
└────────────────────────────────────────────┘
```

Rules:

- **Dismiss stays the default weight.** Most calls are not cases. Raising one is
  the deliberate act.
- **Type is pre-selected**, from the recap where present, else from the queue's
  keyword rules, else `Other`.
- **The note field is focused** when there is no recap, because that is the one
  thing only she can supply.
- **Company is required.** A case with no `company_id` cannot reach a customer
  record — the database refuses it. Do not allow the raise until one is picked.

### Type list

`Billing` · `Delivery` · `Returns` · `Account` · `Technical` · `Sales` · `Other`

Sent as `intent`. Anything outside the list is accepted and stored, but the
queue's "by intent" panel groups on these.

---

## The call to make

Call iQ is already authenticated against WG Main, so call the function directly
rather than going through ResolveIQ's server. Fewer moving parts, and it does
not care whether ResolveIQ is running.

```js
const { data, error } = await supabase.rpc('resolveiq_upsert_case', {
  payload: {
    case: {
      company_id: 23508,            // REQUIRED — Sage CRM company id
      person_id: 96695,             // optional
      subject: 'Damaged delivery — 4 boxes of bathmats',
      note: recapOrWhatSheTyped,
      intent: 'Delivery',
      channel: 'Voice',
      priority: 'Medium',
      status: 'new',
      source: 'calliq',             // so the case says where it came from
      source_ref: dialpadCall.id    // traces back to the call and its recording
    }
  }
})
// data.case.case_ref  →  'RQ-01042'
```

`company_id` and `subject` are the only required fields. The case reference is
issued by the database, so two advisors raising a case at the same moment cannot
collide.

A new case does **not** touch Sage CRM. That happens when it is resolved, and
ResolveIQ handles it.

### Don't raise it twice

`dialpad_calls.logged_call_id` (uuid) exists and is unused — 0 of 5,771. It is
the obvious home for the created case id:

```js
await supabase.from('dialpad_calls')
  .update({ logged_call_id: data.case.id })
  .eq('id', dialpadCall.id)
```

Then the button reads "Case RQ-01042 raised" and cannot be pressed again. It
also gives the reverse lookup: which call produced which case.

### Finding the company for the 75%

```js
const { data } = await supabase
  .from('vw_crm_company_list')
  .select('company_id, name, account_ref, primary_contact_name, city, open_cases')
  .or(`name.ilike.*${q}*,account_ref.ilike.*${q}*`)
  .limit(10)
```

Strip `( ) , . * :` from `q` first — PostgREST treats them as `or=()` syntax and
a customer called "Smith, J. & Co." would corrupt the filter rather than simply
fail to match.

`open_cases` comes free: show "2 open care issues" next to a company so she
knows before she raises a third.

Contacts for the picker:

```js
supabase.from('vw_crm_company_contacts')
  .select('person_id, full_name, job_title, is_primary')
  .eq('company_id', id).eq('is_active', true)
  .order('is_primary', { ascending: false })
```

---

## Realtime — done, with a caveat

**Realtime is now enabled on `dialpad_calls`** (publication `supabase_realtime`,
13 tables). Applied from the ResolveIQ side; the SQL is in
`db/migrations/0003_realtime_on_dialpad_calls.sql` so Call iQ can fold it in.

**The SELECT policy is now applied too** (`0004`): a signed-in rep may read
their own calls. Verified by impersonation against the live table — a rep sees
exactly their own 1,461 calls and none of the 1,317 belonging to other reps.

So the browser route works. Two things it does not cover:

**Writes.** The policy is SELECT only. Setting `dismissed_at` or
`logged_call_id` from the browser needs an UPDATE policy, which has not been
granted. Do those server-side, or ask for the policy.

**Calls with no rep.** This is the one that will bite:

| | |
|---|---|
| `rep_email` null | 3,227 of 6,005 calls (54%) |
| **Inbound calls attributed to a rep** | **30.1%** (499 of 1,658) |

Inbound is exactly the customer-service case. **Seven in ten of the calls this
feature exists for are invisible to every rep**, and the card will not appear
for them.

That is a data problem, not a policy problem — the fix is to populate
`rep_email` on inbound calls in the Dialpad sync. Widening the policy to include
unattributed rows would expose 3,227 calls, with customer phone numbers, to
every signed-in WG account, so it is not a workaround to apply quietly.

Until attribution is fixed, the server-subscribe route (service key, no policy
needed) is the only one that sees every call.

Once a policy exists, subscribe filtered to the signed-in rep so an advisor is
never shown someone else's call:

```js
supabase.channel('my-calls')
  .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'dialpad_calls',
        filter: `rep_email=eq.${me}` },
      ({ new: call }) => showCard(call))
  .subscribe()
```

That is a change to shared infrastructure, so it is left for whoever owns it
rather than done from the ResolveIQ side.

Without it, polling every 15 seconds works and is honestly fine at this volume —
but the card would appear up to 15 seconds after hang-up rather than 2.

---

## What happens next

The case lands in ResolveIQ's queue, sorted by how close it is to breaching its
SLA (High 20 min, Medium 60, Low 240 — from priority). An advisor works it,
drafts a reply, and resolves it. Resolving writes the case and queues a Sage CRM
communication, so a rep who lives in Sage still sees the care activity.

The case also appears on the customer's ClientiQ timeline immediately, as
`source = 'resolveiq'`, and counts toward `open_cases` on the company list.

---

## Summary of what the numbers demand

| Finding | What it means for the build |
|---|---|
| No row until the call ends; median 2s after | Wrap-up card, not in-call |
| 75% of calls match no account | Company search is the main path, not the fallback |
| 65 ambiguous matches | Ask, never guess |
| Recap on 16% of calls, 48% of calls over a minute | She writes the note; the recap pre-fills it when it exists |
| No transcripts stored at all | Do not design anything that depends on one |
| `call_type` used on 1.7% of calls | One tap to raise; type pre-selected, not chosen cold |
| 2,545 calls already dismissed | The habit exists in Call iQ — extend it, don't compete with it |
| Realtime not enabled on `dialpad_calls` | One line of SQL, or poll |
