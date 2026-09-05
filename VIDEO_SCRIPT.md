# Demo video script — Persuas

For a screen-recorded submission video, target 2:30–3:00 total. Each block
shows [ON SCREEN: what to click/show] and the line to say over it. Record
your screen first (OBS, Loom, or Windows' built-in Xbox Game Bar — Win+G),
narrate live while clicking, and do one full dry run before the real take so
your timing on the numbers is smooth.

Live URL to use throughout: **https://persuasnav.vercel.app**

---

### 0:00–0:15 — Cold open, no screen yet or landing page loading

[ON SCREEN: landing page, let it load, don't talk over the load]

> "Every payment recovery product you're about to see in this buildathon is
> going to show you a number that went up. I'm going to show you why that
> number is usually wrong, and how mine proves it isn't."

### 0:15–0:45 — The hero / the holdout

[ON SCREEN: hero animation running on the landing page — let it play a few
seconds before talking]

> "This is the actual experiment my agent runs, live, right now. Two lanes of
> failed payments. Left lane — my agent acts on it. Right lane — the holdout —
> gets nothing, on purpose. Watch the right bar. It fills too. That's the part
> every other recovery product quietly takes credit for.
>
> The gap between these two bars is the only number on this entire page that's
> a measurement instead of a guess — a real randomized holdout, the same logic
> as an A/B test, run automatically on every cohort this system touches."

[ON SCREEN: point cursor at the "Lift" readout under the animation]

> "On this run, that's a [read live lift]% lift — meaning most of what a
> normal dashboard calls 'recovered revenue' would have happened anyway."

### 0:45–1:15 — The decision engine

[ON SCREEN: click "Open the console" → Batch run screen]

> "Here's the working queue — every decision the agent made on its own, no
> human in the loop. Look at these chips: ACT, WAIT, EXPERIMENT, DO NOT ACT,
> BLOCKED. Four of five outcomes here are the agent refusing to act."

[ON SCREEN: filter the table to DO_NOT_ACT, click into one row]

> "It only acts when the *lower bound* of its estimated value is still
> positive — not the optimistic case, the worst-case-and-it-still-wins case.
> This one walked away, and it'll tell you exactly why."

### 1:15–1:45 — The evidence

[ON SCREEN: click into Incidents → open one incident detail]

> "Behind every decision is a real statistical process. It found this
> cohort, matched it against a control group that wasn't affected, ran a
> difference-in-differences test, and ranked competing explanations. It's not
> pattern-matching a vibe — it's a stats test on every cohort, corrected for
> running hundreds of them per window so it doesn't fool itself with noise."

### 1:45–2:15 — The honesty

[ON SCREEN: click into Evaluation screen]

> "This is the part most teams here won't show you: a report card the agent
> didn't get to grade itself. 140 blind scenarios it's never seen, tested
> against five baseline strategies — including 'discount everyone' and 'retry
> everything.' Every baseline either overclaims or loses money once you
> subtract the holdout."

[ON SCREEN: scroll to the recall / confusion matrix section]

> "And here's the part that took discipline to leave in: it misses about a
> third of real incidents, and this shows exactly which ones, and why."

### 2:15–2:40 — Real Razorpay, not a mockup

[ON SCREEN: switch tab to Razorpay dashboard, show the connected/paid payment
link, or the provenance badge on the console]

> "This isn't a static demo. It's deployed live, connected to a real Razorpay
> test-mode account — this badge confirms it — and I ran an actual payment
> through it end to end: a real payment link, a real test payment, a
> signature-verified webhook hitting my deployed endpoint."

### 2:40–3:00 — Close, the Razorpay argument

[ON SCREEN: back to landing page or a static final frame]

> "The one honest gap in my own evaluation — issuer-level failures being hard
> to see from one merchant's data — is exactly the argument for why this
> belongs inside Razorpay rather than beside it. Razorpay sees every merchant.
> What I've built is a working, self-testing proof of that decision logic at
> merchant scale. Thanks for watching."

---

## Recording tips

- Do a silent click-through once first so you're not hunting for buttons on
  camera — dead air while you find a link kills the pacing.
- Read the live numbers off the actual screen in the moment rather than
  memorizing today's exact figures — they're deterministic per `npm run eval`
  run but you don't want to sound rehearsed-and-wrong if anything changed.
- Keep your cursor movements slow and deliberate; fast erratic clicking is
  the single biggest thing that makes screen-recorded demos hard to follow.
- If your video platform has a hard time limit (many buildathons cap at 2 or
  3 minutes), cut the 1:45–2:15 "honesty" section first — it's the strongest
  differentiator but the least essential to a passing watch, and the 0:15–0:45
  holdout section is the one to protect at all costs.
- Trim silence at the very start and end in your editor before exporting —
  judges watching dozens of these penalize dead air more than you'd expect.
