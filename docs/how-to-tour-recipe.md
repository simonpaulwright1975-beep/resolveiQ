# How to create a "How-to Tour" — reusable brief (any app)

A repeatable recipe for adding an in-app how-to tour + team walkthrough to any
WG app. Fill in the blanks for your app and you have a finished tour brief.
The worked examples are Call iQ's `how-to-tour-brief.md` and, in this repo,
`how-to-tour-brief.md` for ResolveIQ.

## 1. What a how-to tour is (and its one job)

A short, in-app walkthrough that teaches a new user the app's core journey —
what to do, in order, and why each step matters. Its job is **behaviour change,
not feature coverage**. A good tour makes someone do the thing the app needs
them to do; it is not a manual of every button.

**Success test:** after the tour, a brand-new user can complete the main journey
once, unaided, and knows where their results show up.

## 2. The method — how to build one for a new app

Do these five things, in order, before you write a word of tour copy.

1. **Map the real journey.** Sit with the app (or the person who built it) and
   list, in order, every step a user takes from opening it to seeing a result.
   Ignore admin/edge features — just the main path.
2. **Find the keystone action.** Identify the one step that makes everything
   else work — the habit the whole app depends on. (Call iQ: tick your reason
   before you dial.) If users skip it, the app underdelivers. This becomes the
   hero of the tour and gets repeated.
3. **Cut to 6–10 steps.** Merge or drop anything that isn't on the main path. A
   tour longer than ~10 cards doesn't get finished.
4. **Separate the roles.** Anything only a manager/admin does comes out of the
   main tour into its own (often PIN-gated) section at the end.
5. **Draft, then trim.** Write the full "source" detail first (the brief), then
   trim each step to what fits on one card. Keep the source as the training doc.

## 3. The standard structure (every tour has these parts)

1. **Hero principle** — one line naming the keystone action and why it matters.
   It opens the tour and is echoed in the relevant step.
2. **The journey** — 6–10 numbered cards, in the order the user actually works.
3. **Quick answers** — a short FAQ of the real questions users ask ("where's my
   X?", "do I have to fill in Y?", "does anything send on its own?").
4. **Role-gated section** — manager/admin steps, surfaced separately (behind a
   PIN if the app uses one), never mixed into the rep tour.
5. **Build notes** — for whoever wires it up (triggering rules, where it lives,
   what to align with).

## 4. The card template (copy per step)

```
N. [Short action title]
   Do:  [the single action, in the user's words]
   Why: [why it matters / what it unlocks — one line]
```

Rules for cards:

- One heading + one "Do" + one "Why". If a step needs three "Do" lines, it's
  really three steps (or it's too detailed for a card — push detail to the
  source brief).
- Second person, plain verbs. "Tick your reason", "Open the draft", not "The
  reason selector allows the user to…".
- **Name where results appear.** Every action that produces something later must
  say where the user will find it.
- **Say what's automatic.** Where the app does work for the user (AI, sync),
  give it a "this part is automatic" card so they don't wait or worry.

## 5. The fill-in brief skeleton (start here for a new app)

```markdown
# [App name] — "How to use the app" Tour Brief

Purpose: script for the in-app tour + team walkthrough.
Audience: [who]. Manager steps called out separately.

## The one thing that makes it all work
> [keystone action] — [one line why].

## The tour — step by step
1. [Sign in / pick context]        Do: …   Why: …
2. [KEYSTONE action]               Do: …   Why: …   ← echo the hero here
3. [core action]                   Do: …   Why: …
…                                  (6–10 total)
N. [where results / coaching show] Do: …   Why: …

## Quick answers
- [real question]? [plain answer]
- … (5–8)

## Manager steps (PIN [nnnn], separate)
- [admin capability] …

## Notes for building the tour
- Don't auto-launch on every login; one click away via "How it works".
- One-time nudge for brand-new users only.
- Lead with the keystone step — it's the behaviour the rollout depends on.
- Align with any existing in-app guide; keep cards trimmed, brief is the source.
```

## 6. UX & technical rules (apply to every app)

- **Don't auto-launch on every login.** It annoys returning users. Put it one
  click away under a persistent "How it works" entry, and optionally show a
  one-time nudge to first-time users only.
- **Progress + skip.** Show "step N of M", let people skip and reopen anytime.
- **Point at real UI.** Where possible, anchor a card to the actual element it
  describes (highlight/scroll to it) rather than describing it in the abstract.
- **Trimmed on-card, full in the brief.** The on-screen card is the short
  version; the brief/source is the training material and the single source of
  truth.
- **Match the app's look.** Same fonts, palette, light/dark behaviour as the
  host app — the tour shouldn't look bolted on.
- **Keep it current.** When the journey changes, update the brief first, then
  the cards. Treat the brief as owned content, not throwaway.

## 7. Worked example

Call iQ's `how-to-tour-brief.md` is this template filled in — keystone action
("tick your reason before you dial"), a 10-step journey, quick answers, and a
PIN-gated manager section. Use it as the reference when writing the next app's
tour.

## To reuse on another app

Copy this file into that app's repo, then work through §2 (the method) with the
app in front of you and fill in the §5 skeleton.
