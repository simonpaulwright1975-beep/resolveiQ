# ResolveIQ

A customer care console for a support team: one screen showing what's waiting,
what's about to breach SLA, and what the AI layer suggests doing about it.

Built as a static page — no framework, no build step, no server. Open
`index.html` in a browser and it runs.

## What's on the screen

- **KPI row** — open tickets, resolved today, auto-resolved share, average
  handling time, CSAT. Each with movement against the previous period.
- **Open tickets by intent** — where the volume actually is (Billing, Delivery,
  Returns, Account, Technical…), sorted by size.
- **SLA compliance gauge** — share of open tickets still inside their window,
  against the team target.
- **Live queue** — sorted most urgent first: breaching tickets, then at-risk,
  then longest waiting. Filter by status, search by customer, subject or ticket ID.
- **Ticket drawer** — click any row for the conversation, the customer's previous
  contact history, and a suggested resolution with a confidence score. From there
  you can claim the ticket, move it to pending, or send the reply and resolve it.

Sentiment shows as a coloured dot next to the intent tag: green positive, grey
neutral, amber frustrated, red angry.

## Running it

```
open index.html
```

That's it. No install, no dependencies.

To produce a single self-contained file (everything inlined) for sharing or
hosting:

```
node scripts/build-artifact.mjs   # writes dist/artifact.html
```

## Wiring it to real data

Everything the UI draws comes from `assets/data.js`, which sets
`window.RESOLVEIQ_DATA`. Replace that file with a `fetch()` against your
helpdesk API and the rest of the app is unchanged — nothing else reads the
source data directly.

Each ticket looks like this:

```js
{
  id: 'RQ-4821',
  customer: 'Hannah Booth',
  account: 'Retail · Order #88213',
  channel: 'Chat',                  // Chat | Email | Voice
  subject: 'Parcel marked delivered but nothing arrived',
  intent: 'Delivery',               // free text — drives the intent bars
  sentiment: 'frustrated',          // positive | neutral | frustrated | angry
  status: 'new',                    // new | open | pending | resolved
  waitMins: 4,                      // minutes since the customer last had a reply
  slaMins: 15,                      // minutes allowed before breach
  assignee: null,                   // null renders as "Unassigned"
  aiConfidence: 0.93,               // 0–1, shown as a percentage
  aiSuggestion: 'Courier GPS shows…',
  value: 68.40,                     // order value in GBP, 0 to hide
  messages: [{ who, at, text, agent }],   // agent: true tints the bubble
  history:  [{ at, text }]                // previous contact
}
```

The `metrics` block at the top of the same file feeds the KPI row.

SLA state is derived, not stored: a ticket is *breached* once `waitMins`
reaches `slaMins`, and *at risk* from 70% of the window onwards.

## Notes

- Actions taken in the console (claim, pending, resolve) are kept in
  `localStorage` so a refresh doesn't lose them. **Reset demo** clears them.
  Storage access is wrapped in try/catch, so the page still works in private
  windows or with site data blocked.
- Light and dark themes both ship; the page follows the viewer's system setting.
- Nothing leaves the page — there are no network calls anywhere in the app.
