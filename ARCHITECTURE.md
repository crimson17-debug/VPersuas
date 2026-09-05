# Architecture

Decisions, and the alternatives that were rejected. Written to be argued with.

---

## The shape of it

The engine is a set of pure functions over an array of events. It takes events
in and returns decisions out; it opens no connections and touches no database.
Three things follow from that, and they are the reason for the choice:

1. **The evaluation can run 200 windows in twenty seconds.** A database round
   trip per cohort test would put that in the minutes, and an evaluation nobody
   runs is an evaluation that rots.
2. **Every module is unit-testable without fixtures or a running service.**
3. **Determinism is achievable.** Every stochastic step draws from a seeded
   generator, so `npm run eval` produces identical numbers on any machine and the
   figures in EVAL.md can be checked rather than trusted.

Persistence sits at the edges — the earned priors serialise to JSON, and the
ledger is a table of decisions and outcomes. Neither is in the hot path.

## One engine, two runtimes

The engine imports its own modules with explicit `.js` extensions, which is what
lets `npm run eval`, `npm run batch` and the test runner execute the TypeScript
sources directly with no bundler at all. Next's webpack resolver is taught to map
those to their `.ts` sources through `extensionAlias`.

That is three lines of config buying a real property: one copy of the engine
serves both the CLI and the web app, and neither needs a build step to run. The
alternatives were dropping the extensions and breaking the CLI, or maintaining a
compile step between the engine and the app that would be one more thing to debug
under time pressure.

Persistence is a `LedgerStore` interface with four methods, backed by JSON files
under `.data/`. Swapping it for Postgres is one file, and no caller changes.
The engine itself never touches it — the store sits between the engine and the
console, which is what keeps the engine pure enough to run 200 windows in twenty
seconds.

## The interface

The console is built around one recurring device: the interval bracket. Wherever
a number is an estimate it is drawn as a range with a mark on it, positioned
against a zero tick — a full-width readout on the incrementality screen, a 92px
glyph inside a table cell. A bracket crossing the zero line is the visual shape of
"this cannot be shown to have worked", and it is legible before any label is read.

That is not decoration. The product's entire claim is that recovery figures are
reported as points when they are ranges, so the interface refuses to draw a point.

Typography does the same work in three registers, all IBM Plex: mono carries
every number, label and identifier, with tabular figures so a column of estimates
lines up; sans carries the interface; serif carries the argument, so a claim reads
as writing rather than as another figure. Plex is loaded by stylesheet link
rather than `next/font` — `next/font` fetches at **build** time, which fails on
any machine without network access to Google, and a build that only works online
is a build that fails at the worst moment.

## Language and runtime

TypeScript on Node, strict mode with `noUncheckedIndexedAccess`. One language
across engine, evaluation and integration means one type system describing the
`PaymentEvent` contract end to end, which is the contract that matters here.

**Rejected: Python.** Better statistical libraries, worse for the part of this
that is a service integrating with webhooks and a payments API. The statistics
needed here fit in 300 lines and I would rather write and defend them than import
and paraphrase them.

## No graph database

The system reasons about a temporal event graph — customer to checkout session to
order to attempt to issuer to outcome — but stores it relationally and traverses
it in TypeScript.

The traversals actually run are at most three joins deep and always bounded by an
incident window. A graph store would add an operational dependency without
changing a single query needed. If traversal depth grew unbounded — full customer
lifetime paths, multi-hop attribution — that calculus changes.

## Hand-written statistics

`src/engine/stats.ts` implements Wilson intervals, two-proportion tests,
difference-in-differences, CUSUM, Šidák correction, Brier score and calibration
binning. All of it is small enough to read in one sitting.

The reason is not invented-here. It is that every one of these carries
assumptions that the decisions downstream depend on, and I would rather be able
to explain a line than quote a docstring. Two examples where the choice mattered:

- **Wilson over the normal approximation.** Cohort slices routinely have small
  `n` and rates near 1. The naive interval produces bounds above 1 and claims
  certainty from thirty observations.
- **CUSUM referenced to the head of the series, not the whole of it.** The first
  implementation computed its baseline from the entire series — including the
  change it was looking for. A clean 30-point drop halfway through reads as a ±1
  sigma wobble around a midpoint nothing ever sat at, and never fires. A unit
  test caught it. The slack parameter `k` matters just as much: set too low,
  ordinary hourly noise keeps the accumulator off zero indefinitely and the
  reported onset drifts hours earlier than the real one.

## The sealed boundary

`src/engine/simulator/world.ts` holds the ground truth: true natural recovery
rates and true uplift per (cause, intervention). Nothing under `detector/`,
`diagnosis/`, `policy/` or `runner/` may import it. `npm run check:boundaries`
enforces this and fails the build.

This is the difference between "the engine cannot see the answers" being a claim
and being a fact. Without it, an accidental import would make the evaluation
measure a lookup.

The runner reaches the world only through an injected `Environment` interface
with a single method: *did this payment recover?* Swapping that implementation
for one backed by real Razorpay webhooks is the entire production path.

## Where the LLM is allowed to touch

Three jobs, none of them numeric:

1. **Hypothesis generation from unstructured signals** — release notes, config
   diffs, gateway status text. Reading "v42: moved 3DS challenge before method
   selection" into a candidate hypothesis is work a regex cannot do.
2. **Evidence-query planning** — choosing which cohort slice to interrogate next,
   bounded to a whitelist of query types with a hard step limit.
3. **Narration** — turning a settled decision into merchant-readable text, after
   the numbers are final.

Confidence, expected value, lift, cost and the decision itself are computed
deterministically and passed *to* the LLM, never produced by it. Delete the LLM
and the arithmetic is untouched, because it never touched the arithmetic; what is
lost is the unstructured-input path and the adaptive investigation.

## The decision rule requires a positive lower bound

The policy acts only when the **lower** bound of estimated net value is positive,
not the point estimate. Acting on a point estimate means acting half the time on
noise, and the cost of that shows up as real money spent on nudges that did
nothing.

This is why the engine touches roughly a twentieth of the items that
nudge-everything touches and still beats it on net value.

## Learning, and two bugs worth recording

The prior store accumulates observed outcomes per (cause, intervention), with the
natural rate pooled per cause from the holdout arm. Cold start is therefore
correct rather than lucky: with no history every interval spans zero, nothing can
justify acting, and the policy returns `EXPERIMENT`. Nothing about that is
scripted.

Getting from there to a policy that acts took two fixes that are worth writing
down because both were invisible until the evaluation was pointed at them.

**Exploitation lock-in.** The first intervention to clear the sample floor became
the only one ever used. `checkout_rollback` recovers 34 points on a regression and
the engine had never once tried it. The fix is a permanently reserved learning
slice on every acting decision, spent on the least-observed option that could
still be worth something — coverage first, optimism second. Ranking exploration
purely by optimistic value degenerates immediately: with no observations every
option has the same wide upper bound, so the ranking collapses to "whichever is
cheapest" and the budget pours into one cheap option forever.

**Starvation on refusal.** Deciding not to act is not the same as deciding not to
learn, but the first version stopped learning on `DO_NOT_ACT` — so the first
refusal for a cause was permanent. Nothing cleared the sample floor, so nothing
was tried, so nothing cleared the sample floor. The learning slice now runs even
when the decision is to do nothing.

## Costs are the engine's, effects are not

The engine knows its own price list — an SMS costs what an SMS costs, a discount
is whatever rate the merchant set. It does not know whether any of it works.

One-off costs are modelled separately from per-item costs, and that separation
turned out to matter: `checkout_rollback` at zero cost became a free lottery
ticket the policy played on every cause, because an option that costs nothing
only has to get lucky once on noise to clear a net-value test. Priced at ₹25,000
of engineering time and deploy risk per decision, it is chosen only when the
affected cohort is large enough to pay for it — which is the actual decision a
merchant faces.

## Measurement is pooled, not summed

Incremental value is computed once over the pooled arms of an entire run, not
summed from per-window estimates. A single window holds out twenty or thirty
items, so the lift measured inside one window is mostly noise; adding up 140 noisy
estimates gives a total whose standard error runs to lakhs. The first version did
exactly that and produced a baseline comparison dominated by sampling error.

## What breaks at 100× volume

- **The cohort scan is combinatorial and runs in-process.** At scale it becomes a
  scheduled job over pre-aggregated rollups, and the enumeration moves to
  candidate cohorts surfaced by the rollup rather than a full sweep.
- **Holdout assignment needs to move to a shared experiment service**, or two
  engines will assign the same customer to conflicting arms.
- **The prior store needs to become hierarchical.** Thirty-six (cause,
  intervention) cells is already sparse; adding merchant as a dimension makes it
  much worse. The right answer is partial pooling — an unobserved cell shrinks
  toward the marginal effect of that intervention across merchants and tightens
  toward its own estimate as evidence accumulates. It is not implemented here,
  and the honest reason is that the shortcut — falling back to a pooled estimate
  with pooled sample size — would let the policy act confidently on a number that
  is wrong for the specific case.

## Open weaknesses

- Ambiguous windows contain two simultaneous causes and the correct output is
  `INSUFFICIENT_EVIDENCE`. The engine abstains on only 1 in 11 of them; usually it
  isolates the larger incident and reports it confidently. Arguably defensible,
  but it is not what the corpus was built to elicit and the abstention path is
  under-demonstrated as a result.
- Detection recall is 64.5%. The misses are systematic, not random: shallow
  declines across large cohorts.
- The evaluation measures the engine against a simulator whose uplift and cost
  structures are assumptions. They are plausible and they are stated in the open
  in `world.ts` and `costs.ts`, but no claim about real-world lift follows from
  any of it.

---

## The federated layer

### Why it exists

Everything else in this system is a better answer to a question one merchant
can already ask. This is the only part that answers a question a merchant
**cannot** ask at all.

Consider two worlds. In the first, HDFC's UPI rail is degraded and every
merchant carrying it is losing payments. In the second, one merchant's retry
schedule is firing into a window where it cannot succeed, on the same rail,
over the same hours, at the same severity, surfacing the same
`issuer_unavailable` failure reason.

Inside that merchant, the two worlds are byte-for-byte the same story. There
is no feature to engineer, no model to upgrade, no prompt to improve. The
information that separates them does not exist in the merchant's data. It
exists in the correlation between merchants, and the only party standing where
that correlation is visible is the processor.

`src/eval/federated.ts` measures exactly this, and the result is blunt: alone,
the engine gets 100% of the fleet-wide cases right and **0%** of the
merchant-only cases, because it has no way to know which world it is in. It
resolves to a coin flip overall. With fleet signals it reaches 83.3%.

### What actually crosses the boundary

`src/engine/network/contribute.ts` is deliberately short enough to audit in a
sitting. Per merchant, per rail (payment method × issuer bucket), per window:
a z-statistic, the change in success rate, the post-window sample size, and an
onset hour. That is the entire payload.

There is no merchant identifier. The `contributorId` is a rotating per-window
pseudonym whose only job is to count distinct parties for the quorum gate and
reject a party submitting twice; it means nothing across windows and maps to
nothing.

Rails are method × issuer and nothing else. Device, geography, value band and
customer type were all deliberately excluded: those are *merchant-shaped*
dimensions, and publishing them would start to describe the contributor's
business rather than the shared infrastructure. Method and issuer are the only
dimensions that mean the same thing to every participant.

What is shared, in short, is the **result of a test** rather than the data the
test ran on — enough to combine tests, not enough to reconstruct traffic.

### Why Stouffer, and why not a pooled average

Combining N independent tests of the same hypothesis is a solved problem, so
the code uses the standard tool rather than inventing one. Stouffer's weighted
Z preserves direction and magnitude, weights by √n so a merchant with four
times the volume carries twice the influence, and cancels opposing evidence
instead of accumulating it.

But the combined Z is **not** what decides the verdict, and this is the single
most important design decision in the module. A pooled statistic can be dragged
anywhere by one large contributor. Picture one merchant with twenty thousand
payments and a genuinely broken checkout, alongside eleven healthy merchants:
the pool looks significant, and a mean-based implementation confidently
announces an issuer outage. It would then broadcast one merchant's bug to every
other merchant on that rail as established fact — a failure strictly worse than
not federating at all, because it manufactures false confidence at scale.

So the gate is a **count of independent parties**: how many contributors
individually cleared a degradation threshold. That statistic cannot be moved by
volume. `network.test.ts` encodes the adversarial case directly, and asserts
both that the pooled statistic looks significant *and* that the verdict is
`merchant_specific` anyway.

### The third verdict

`merchant_specific` — the fleet carries this rail and is not moving — is
positive evidence, not a shrug. It is the only mechanism by which a merchant is
ever told the fault is theirs, and it is what converts "we don't know" into
"look at your own release."

### Two mistakes worth recording

**Heterogeneity as a veto.** The first implementation gated `issuer_confirmed`
on Cochran's I² and on onset synchrony. It called *every* genuine outage
`merchant_specific`. Real issuer degradation hits merchants with different
traffic mixes at genuinely different severities, so high I² is expected, and
letting an expected property veto the finding inverted the whole test.
Heterogeneity is now computed, displayed, and folded into confidence — but it
holds no veto over near-unanimous agreement.

**Range instead of IQR.** Onset spread was max minus min across contributors.
Onset comes from a change point over hourly buckets on per-merchant volumes
that are often small, so a handful of estimates are always badly wrong — and
max-minus-min is decided entirely by those two worst estimates. It got *wider*
as more merchants joined, which is precisely backwards for a statistic meant to
express agreement. It is now the interquartile range. Thirty-seven of
thirty-nine merchants down at Z = −49.7 had been reported as "no signal".

Both bugs share a root: a secondary, poorly-measured signal was allowed to
overrule a primary, well-measured one.

### What this is not

k-anonymity is a structural guarantee about what gets published. It is not
differential privacy, and the code does not claim to be. There is no noise
added and no privacy budget tracked, so repeated queries across many windows
still leak information slowly. A production version needs calibrated noise and
a budget, and `EVAL_FEDERATED.md` says so rather than leaving it implied.

The fleet is also synthetic, and its merchants are independent draws. Real
merchants share seasonality, campaigns and customers, and that correlation
weakens the independence assumption Stouffer's method rests on. Every
contributor here additionally runs an identical detector; a real network would
have version skew, with older builds contributing subtly different statistics.
