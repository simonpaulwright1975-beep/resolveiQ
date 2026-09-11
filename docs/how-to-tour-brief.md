# ResolveIQ — "How to use the app" Tour Brief

Purpose: script for the in-app tour + team walkthrough.
Audience: customer service advisors (Tier 1). Manager steps called out separately.
Method: `how-to-tour-recipe.md` in this folder.

> **Build status.** The tour is built (`assets/tour.js`) and the keystone step
> is real: resolving writes the case to the central customer record, and
> refuses to mark it done if that write fails.
>
> **One card in this brief is deliberately NOT in the shipped tour:** "Read
> their history before you reply". `history` is hardcoded to `[]`, so Previous
> contact always reads "first time this customer has contacted us" — false for
> any customer with a record. Pointing advisors at it would teach them to trust
> a panel that lies. The card returns when the panel is populated; the shipped
> tour is 10 cards (a hero plus nine steps) rather than eleven.

---

## The one thing that makes it all work

> **Finish the case in ResolveIQ — every case, every time.**
> It is the only thing that puts the customer's story on their record. Reply
> from your inbox and, as far as the business is concerned, the conversation
> never happened.

Why this is the keystone rather than anything else:

An advisor who cherry-picks the easy cases hurts the SLA figures, and that is
recoverable — the work still gets recorded. An advisor who deals with the
customer but never closes the case here leaves no case, no timeline entry, no
resolution, no satisfaction score, and a queue that says the customer is still
waiting. Every downstream thing — the customer card, the 360° timeline,
reporting, and eventually replacing Sage — is built on cases being finished in
the app. It is also the easiest step in the world to skip, because the customer
has already been helped.

---

## The tour — step by step

**1. Check you're looking at live work**

- **Do:** Look at the badge at the top right. It should say `SAGE CRM · LIVE`.
- **Why:** `SAMPLE DATA` means you're in the demo queue and nothing you do is
  real. Tell whoever set the app up.

**2. Take the case at the top — don't pick**

- **Do:** Start with the first row in the Live queue and work down.
- **Why:** The list is already sorted by what matters: breached first, then
  about to breach, then longest waiting. Picking the easy ones is how the ones
  that were nearly late become late.

**3. Open the case**

- **Do:** Click anywhere on the row. The case opens in a panel on the right.
  Escape closes it.
- **Why:** Everything about that customer is in one place — you shouldn't need
  another system to answer them.

**4. Read their history before you reply** **[not wired — omitted from the tour]**

- **Do:** Scroll to **Previous contact** in the panel.
- **Why:** If they've called about this before, saying so changes the whole
  conversation. Customers should never have to repeat themselves.
- **Why it isn't in the tour:** `mapCase` sets `history: []` and nothing
  populates it, so the panel always claims this is the customer's first
  contact. The data exists — `core.customer_timeline` holds 27,824 events
  across 1,693 accounts — it just isn't read back yet.

**5. Ask for a draft**

- **Do:** Click **Draft a reply**. It takes a few seconds.
- **Why:** It reads the case and the history and writes a reply you can send,
  plus what to do in the CRM, so you start from something rather than a blank box.

**6. Check the draft before you use it — it is a draft**

- **Do:** Read the confidence percentage and look for an **Escalate** flag.
  Change anything that isn't right.
- **Why:** It can be wrong, and it is instructed never to invent an order
  number, a refund amount or a policy. You are accountable for what goes out,
  not the app. A low confidence score is it telling you it isn't sure.

**7. Escalate when it says to** **[no destination yet]**

- **Do:** If the draft is flagged **Escalate**, pass it to a manager rather than
  answering it yourself.
- **Why:** It flags things needing authority you may not have — refunds beyond
  routine goodwill, anything legal or data-protection, anything about safety.

**8. ★ Finish the case here**

- **Do:** Send your reply with **Send reply & resolve**, or **Move to pending**
  if you're waiting on the customer. Never just close the tab.
- **Why:** ★ **This is the step the whole app depends on.** It writes the case
  to the customer's record, where the next person to speak to them will see it.
  Skip it and the customer's story is lost and the queue still shows them
  waiting.

**9. Where your work shows up** **[partly wired — figures are per-browser]**

- **Do:** Watch the tiles along the top and the SLA dial after you resolve
  something.
- **Why:** Open cases, resolved today and the SLA dial move as the team works.
  The dial is the number the department is judged on: the share of open cases
  still inside their time window.

**10. What happens by itself**

- **Do:** Nothing — this is the automatic part.
- **Why:** The queue pulls cases from Sage CRM on its own, sorts them by
  urgency, and tags each one with a likely reason and the customer's mood.
  **Nothing is ever sent to a customer automatically.** Drafts are only written
  when you ask, and only go out when you send them.

---

## Quick answers

- **Does anything send to the customer on its own?** No. Nothing leaves the app
  unless you press send. Drafts are only written when you click **Draft a reply**.
- **Do I have to use the AI draft?** No. Write your own whenever you prefer.
  The draft is a starting point, not an instruction.
- **The draft is wrong — is that a bug?** Not necessarily. Check the confidence
  score; a low one means it wasn't sure. Correct it and carry on, and tell your
  manager if a particular kind of case is consistently wrong.
- **Where does my resolved case go?** Onto that customer's record, so the next
  person who speaks to them sees what happened. If it can't be saved you are
  told, and the case stays open.
- **Why is a case marked "breached"?** The customer has been waiting longer than
  the time allowed for that priority. High priority allows 20 minutes, Medium
  60, Low 240. It is not a criticism of you — it's a flag that it needs doing now.
- **Where does "Previous contact" come from?** The customer's history in the
  CRM. If it says "first time this customer has contacted us", that's what the
  record shows.
- **Why can't I create a new case?** You can't yet — cases come in from Sage.
  If a customer contacts you another way, raise it in Sage as you do now.
- **It says SAMPLE DATA — what do I do?** You're on the demo queue, not real
  cases. Don't work from it; tell whoever set up the app.

---

## Manager steps (PIN-gated, separate from the advisor tour)

- **SLA policy.** The time allowed per priority is configuration, not code.
  Changing it changes what the dial and the "breached" labels mean, for everyone.
- **Reassigning work.** Moving a case between advisors. **[not wired]**
- **Escalations.** Where flagged cases land and who picks them up. **[not wired]**
- **Satisfaction and reporting.** Where CSAT is captured and what the tiles are
  drawn from. Note that average handling time, CSAT and automation rate
  currently show "—" because Sage CRM does not hold them — they need a source
  before they mean anything.
- **Connection health.** `npm run check-sage` on the server reports whether the
  CRM is answering and whether the field mapping is resolving.

---

## Notes for building the tour

- **Don't auto-launch on every login.** One click away behind a persistent
  "How it works" entry in the masthead, next to the source badge.
- **One-time nudge for brand-new users only**, stored per browser.
- **Lead with step 8 (the keystone) in the nudge copy** — "finish the case here"
  is the behaviour the rollout depends on, so it should be the first thing a new
  advisor reads, not the eighth.
- **Anchor cards to real elements:** step 1 → the source badge; 2 → the first
  queue row; 3 → the drawer; 4 → the Previous contact section; 5/6 → the
  Suggested resolution block; 8 → the action buttons; 9 → the KPI row and dial.
- **Match the console's look** — same warm palette, same card radius, and it
  must follow the light/dark setting like the rest of the page.
- **Progress and skip:** "step N of 10", skip always available, reopenable.
- **Keep this brief as the source.** Trim the cards from it; when the journey
  changes, change this file first.

### Still to build

| Step | Needs |
|---|---|
| 4 | Previous contact read back from `core.customer_timeline` — then the card returns to the tour |
| 7 | Somewhere for escalations to go, and someone to own them |
| 9 | Resolved-today and SLA figures drawn from stored cases, not browser state |
| — | Confirm which Sage CRM field holds the Sage 200 account reference, or cases save unlinked and never reach the timeline |

### How the shipped tour behaves

- Ten cards: a hero naming the keystone, then nine steps.
- Never auto-launches. It sits behind **How it works** in the masthead.
- A first-time visitor gets one dismissible nudge, which leads with the
  keystone rather than with "take a tour".
- "Step N of 10", dots, Back/Next, Skip; Escape and arrow keys work.
- Each card highlights the real element and opens the case panel when a step
  needs it. The card is placed so it never covers what it is pointing at.
- Uses the console's own tokens, so it follows light/dark like the rest.
