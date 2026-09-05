# Demo script — Persuas (Razorpay AI Buildathon, Track 03)

Target: 3–4 minutes spoken, live on the console. Practice it once out loud before
you present — it's written to be said, not read off a slide.

---

## Opening hook (20 seconds)

> "Every recovery product in this room is going to show you a graph where a
> number goes up after their AI does something. I want to start by telling you
> that number is usually a lie — not on purpose, but because most failed
> payments recover on their own. The customer retries. The bank comes back
> online. If you don't measure against a control group, you can't tell your
> intervention from a coincidence.
>
> So before I show you what my agent does, I'm going to show you the one thing
> most of these systems can't show you: proof that it caused anything at all."

*(Open the landing page. Let the hero animation run for a few seconds before
talking over it.)*

## The proof (45 seconds)

> "This is the actual experiment the product runs, live. Two lanes of failed
> payments. Left lane, the agent acts. Right lane — the holdout — gets nothing,
> on purpose. Watch the right bar. It fills too. That's the part everyone else
> is claiming credit for.
>
> The only number that means anything is the gap between these two bars. On
> this run, that's [read the live lift %] — and it means [phantomShare, e.g.
> "67%"] of what a normal dashboard would report as 'recovered revenue' would
> have happened with zero intervention. That's not a guess. That's a
> randomized holdout, same logic as an A/B test, run automatically on every
> single cohort this thing touches."

## The decision engine (60 seconds)

*(Click through to `/batch`.)*

> "Here's the working queue. Every row is a decision the agent made on its
> own, with no human triggering it. Notice the chips — ACT, WAIT, EXPERIMENT,
> DO NOT ACT, BLOCKED. Four of five possible outcomes here are the agent
> refusing to act. That's deliberate. It only acts when the *lower bound* of
> its estimated value — not the optimistic guess — is still positive. Click
> into any DO_NOT_ACT row and it'll tell you exactly why it walked away."

*(Click into one incident on `/incidents`.)*

> "This is the evidence behind one decision. It didn't just see 'payments
> failing' — it found the cohort, matched it against a control group that
> wasn't affected, ran a difference-in-differences test, and ranked competing
> explanations. It rejected [name a rejected hypothesis] because [reason
> shown on screen]. It's not classifying a vibe. It's running a stats test on
> every cohort it evaluates, corrected for the fact that it's running hundreds
> of these tests per window so it doesn't fool itself with noise."

## The honesty (45 seconds)

*(Click to `/evaluation`.)*

> "This is the part I'm most proud of and the part most teams here won't have:
> a report card the agent didn't get to grade itself. 140 blind scenarios it's
> never seen, tested against five baseline strategies — including 'send
> everyone a discount' and 'retry everything.' Every one of those baselines
> either overclaims or loses money once you subtract the holdout. Mine nets
> [read the number] because it's the only one that knows when *not* to spend.
>
> And here's the part that took discipline to leave in: it misses 35% of real
> incidents. Here's exactly which ones, and why — it confuses retry-timing
> bursts with issuer outages, and I'll tell you why that's a genuinely hard
> problem to solve from one merchant's data alone."

## The Razorpay pitch (30 seconds)

> "That last point is actually my closing argument. Issuer-level degradation
> doesn't resolve cleanly from inside one merchant's transaction log — you
> need volume across many merchants to see it clearly. Razorpay sees every
> merchant. What I've built is a working, self-testing proof of the decision
> logic — detect, diagnose, decide, measure, comply — at merchant scale. The
> argument for why this becomes more valuable inside Razorpay than beside it
> isn't hypothetical; it's the one weakness in my own eval that a
> platform-level version of this would fix."

## Close (10 seconds)

> "Everything you just saw is engine output, not a mockup — the numbers on
> every screen come from the same evaluation run. Happy to open any decision
> on that queue and walk through exactly why it did or didn't act."

---

## If a judge pushes back

**"Isn't this just detect-and-discount with extra steps?"**
> "The detect-and-discount version is the one thing every other team here can
> build in a weekend. The holdout, the matched-control causal test, and the
> self-reported failure rate are the parts that take actual statistical
> design up front — you can't retrofit a holdout after you've already shipped
> 'act on everything.'"

**"How do I know your eval numbers aren't just favorable to your own method?"**
> "Baselines get the same detector output I do — I didn't handicap them. And
> the corpus includes 30 null windows with nothing wrong at all, specifically
> to check for false positives. Zero false positives on those, and that's a
> harder bar than it sounds because I'm running hundreds of cohort tests per
> window."

**"What's not real here?"**
> "Transaction history and incidents are simulated and labeled as such on
> every screen — a provenance badge never lets you forget which is which.
> Razorpay orders, payment links, and webhook verification are real test-mode
> API calls. The stats and decision logic run identically on both."
