# Runbook

How to run it, how to connect Razorpay, how to deploy, and what is not
production-ready. Written so someone who has never seen the repo can get a
working console in about five minutes.

---

## 1. Run it locally

Requires Node 20 or newer.

```bash
npm install

npm run verify   # typecheck + 23 unit tests + the boundary check
npm run eval     # 200 blind windows against 5 baselines  (~25s)
npm run seed     # engine over 24 held-out windows        (~20s)
npm run dev      # console at http://localhost:3000
```

`eval` and `seed` both need to run once before the console has anything to show.
They write to `.data/`, which is gitignored — the data is generated, never
committed.

The first `seed` also earns the prior store from a cold start and caches it to
`.data/priors.json`. Delete that file to make the engine re-learn from nothing;
it takes about fifteen seconds and is worth watching once, because the engine
genuinely begins unable to justify any action.

### What each command actually does

| Command | What it does |
|---|---|
| `npm run verify` | Typecheck, 23 unit tests, and the boundary check that proves engine code cannot import the ground-truth world model |
| `npm run eval` | Builds 200 labelled windows, warms up priors from zero, evaluates on 140 held-out windows against 5 baselines, writes `EVAL.md` and `.data/evaluation.json` |
| `npm run seed` | Runs the engine over 24 held-out windows and writes `.data/portfolio.json` — the decisions, outcomes and pooled measurements the console reads |
| `npm run batch` | Terminal walkthrough of one incident end to end. Takes a scenario: `issuer`, `regression`, `retry`, `abandonment`, `quiet` |
| `npm run dev` | The console |

### No browser? The whole story runs in a terminal

```bash
npm run batch -- issuer        # infrastructure fault
npm run batch -- regression    # checkout regression after a staged release
npm run batch -- quiet         # nothing wrong — watch it stay silent
```

---

## 2. Connect Razorpay test mode

Optional. Without keys, everything runs on the simulator and every record is
tagged `source: 'simulated'`. With keys, recovery links and webhooks are real
test-mode objects flowing through the identical contract.

**Test mode needs no KYC.** Keys are issued immediately and begin `rzp_test_`.
No real money moves.

### 2.1 Get keys

1. Create a Razorpay account.
2. Dashboard → **Account & Settings → API Keys** → **Generate Key**.
3. Download the Key ID and Key Secret. Only Owner and Admin roles can do this.

```bash
cp .env.example .env
```

Fill in `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`.

The client **refuses a live key** at startup. This system creates payment links;
it has no business spending real customers' money, and a misplaced key would be
the worst possible bug to ship.

### 2.2 Expose the webhook endpoint

Razorpay needs a public HTTPS URL. Locally, tunnel it:

```bash
npx localtunnel --port 3000
# or: cloudflared tunnel --url http://localhost:3000
# or: ngrok http 3000
```

### 2.3 Register the webhook

Dashboard → **Settings → Webhooks → Add New Webhook**.

- **URL**: `https://<your-tunnel>/api/webhooks/razorpay`
- **Secret**: any string. Put the same value in `.env` as `RAZORPAY_WEBHOOK_SECRET`.
- **Active events**: `payment.captured`, `payment.failed`, `order.paid`,
  `payment_link.paid`

### 2.4 Verify

```bash
curl http://localhost:3000/api/webhooks/razorpay
```

```json
{ "ok": true, "configured": true, "received": 0, "subscribe": [ ... ] }
```

`configured: true` means the secret is loaded. Fire a test event from the
Razorpay dashboard and `received` increments. The sidebar badge on every console
screen flips from **Simulated** to **Razorpay test mode connected**.

Signature verification is HMAC-SHA256 over the **raw request bytes** with a
constant-time comparison. If you ever see verification fail on an obviously
correct payload, something upstream is re-serialising the body — that changes key
order and whitespace and invalidates the digest.

---

## 3. Deploy

### Vercel

```bash
npm i -g vercel
vercel            # first deploy, follow the prompts
vercel --prod
```

Or push to GitHub and import the repo at vercel.com — zero configuration needed,
Next.js is detected automatically.

**Environment variables** (Project Settings → Environment Variables):

```
RAZORPAY_KEY_ID
RAZORPAY_KEY_SECRET
RAZORPAY_WEBHOOK_SECRET
```

All three are optional. Without them the deployment runs entirely on the
simulator and says so on every screen.

**The data is generated at build time.** `npm run prebuild` runs `eval` and
`seed` before every build, and `outputFileTracingIncludes` in `next.config.mjs`
ships `.data/` with the serverless functions. Without that second part the
functions would deploy without the data and every screen would render its empty
state — Next's file tracing cannot see a path that is built at runtime.

Build takes roughly 90 seconds, most of it the evaluation.

Then point the Razorpay webhook at
`https://<your-deployment>.vercel.app/api/webhooks/razorpay`.

### Anywhere else

It is a standard Next.js app:

```bash
npm run build
npm start        # serves on $PORT, default 3000
```

Docker, Railway, Render, Fly — all fine. The engine holds no connections and the
app has no runtime dependencies beyond Node.

---

## 4. What is not production-ready

Stated plainly, because a deployment that looks finished and is not is worse than
one that admits what it is.

**The ledger is JSON files.** `LedgerStore` is a four-method interface backed by
`.data/*.json`. That is honest for a local run and for a read-only demo deploy,
and it is wrong the moment two instances need to see each other's writes.
Serverless filesystems are read-only, so on Vercel the webhook endpoint verifies
and acknowledges deliveries but cannot persist them — it returns
`persisted: false` with a warning rather than pretending otherwise. **This is the
one thing that must become Postgres before any real use.** It is one file.

**The event history is synthetic.** Every figure in the console and in `EVAL.md`
comes from the engine running against a simulator. Real Razorpay test-mode events
flow through the same contract and are tagged separately, but the volume needed
for cohort statistics is generated. No claim about real-world revenue lift
follows from any of it.

**The holdout has an ethical cost.** A random 20% of affected customers receive
no recovery attempt. In production that needs a volume cap, a written
justification, and an exemption path for high-value or vulnerable accounts. It
should not ship silently.

**Detection recall is 64.5%.** The misses are systematic, not random: shallow
declines spread across large cohorts. Lowering the threshold to catch them puts
false positives back on the null windows.

**Abstention is under-demonstrated.** The engine returns insufficient evidence on
only 1 of 11 dual-cause windows. It usually isolates the larger incident and
reports it confidently, which is arguably right but is not what the corpus was
built to elicit.

**No authentication.** The console is a single-merchant view with no login. Any
multi-merchant deployment needs auth and row-level scoping before it is exposed.

---

## 5. Troubleshooting

**Every screen shows an empty state.** Run `npm run eval` then `npm run seed`.

**Fonts look wrong.** IBM Plex loads from Google Fonts at runtime. Offline, the
page falls back to a system stack and stays entirely legible.

**`npm run build` fails on a machine with no network.** It should not — fonts are
loaded by stylesheet link at runtime, not fetched at build time. If it fails,
read the error: it is something else.

**Webhook returns 401.** The signature did not verify. Check that
`RAZORPAY_WEBHOOK_SECRET` matches the secret set on the webhook in the dashboard
exactly.

**Webhook returns 503.** `RAZORPAY_WEBHOOK_SECRET` is not set in the environment.

**The engine acts on almost nothing.** Delete `.data/priors.json` and re-run
`npm run seed`. A prior store from an interrupted run can leave the policy stuck
below its sample floor.
