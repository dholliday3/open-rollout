# open-rollout

Rolls a feature flag out in steps, watches guardrail metrics while it does, and undoes the rollout when
the new behaviour is worse. It is an open take on LaunchDarkly's Release Autopilot (guarded rollouts,
auto-rollback, approvals) that runs on any feature flag provider and inside any durable runtime.

The package has no I/O of its own. You give it four ports and call `tick`.

## The idea in one paragraph

A rollout is a **record** in a store you own. A **tick** loads the record, looks at the flag and the
metrics once, runs a pure function (`decide`) to get the next record and at most one flag write, saves
the record with compare-and-set, and only then writes the flag. Nothing lives in the runtime: a tick can
be late, repeated, run by two workers at once, or cut off at any line, and the next tick carries on from
the record. That is what lets it sit inside a durable agent runtime, the Workflow SDK, BullMQ, cron or
anything else.

## Traffic model

An `Allocation` is two shares in basis points: `treatment` (new behaviour) and `control` (old behaviour,
measured). Whatever is left gets the old behaviour unmeasured. A step always holds **equal** treatment and
control shares (10% each, then 50% each), so every hour of the day counts the same on both arms and the
arms should always be the same size. That is LaunchDarkly's rule, and it is why a traffic spike or a bad
hour that hits everyone does not look like a regression. The release is `{ treatment: 10000, control: 0 }`;
a rollback is `{ treatment: 0, control: 0 }`.

With an off-the-shelf provider this is a multivariate flag with `control` and `treatment` variants split
50/50, and a rollout percentage of twice the step. Bucketing must be sticky and the variant hash must not
depend on the rollout percentage (PostHog, LaunchDarkly, GrowthBook, Unleash and Flagsmith all do this).

## Ports

| Port | Calls | Contract |
|---|---|---|
| `FlagControl` | `read(flagKey)`, `write(flagKey, allocation, expectedRevision?)`, `refusesStaleWrites` | Whole-state reads and writes, never increments. `revision` is a whole number that goes up on every saved change to the flag, whatever was changed, and doesn't come down; `write` returns the revision it left the flag at. `refusesStaleWrites` says whether a write with a stale `expectedRevision` is refused. |
| `MetricSource` | `snapshot({ flagKey, since, guardrails })` | Running totals per arm since `since`, units counted by first exposure, plus two times on the source's own clock: `asOf`, when the snapshot was taken, and `watermark`, up to when the data is complete. |
| `RolloutStore` | `create`, `load`, `save(record, expectedVersion)`, `listUnsettled` | `save` is compare-and-set. `create` refuses a second unsettled rollout on one flag. |
| `Notifier` | `notify(event)` | May be called twice for one event; `event.key` is stable so the receiver can drop repeats. |

`createMemoryStore`, `createMemoryFlags`, `createMemoryMetrics` and `createMemoryNotifier` are reference
implementations for tests.

## Lifecycle

`awaiting_approval → ramping (step 0..n) → releasing → released`, with `paused` reachable from any phase
before `released`, and `rolling_back → rolled_back` reachable from anywhere before `released`. A finished
rollout is watched for `settleMs` and then `settled`, after which ticks stop.

A step moves on only when all of these hold:

1. the flag has been seen serving the step;
2. the step has been watched for `propagationMs + minDurationMs`, on two clocks. On the metric source's
   clock: from `asOf` of the first snapshot taken after the flag was seen serving the step, until the
   `watermark` has passed that by the whole time. And on the workers' clock: that long since the flag was
   seen serving the step. No stalled tick, no ingestion lag and no one clock being wrong or put right can
   shorten it. It starts again if someone else changes the flag and the rollout has to put it back;
3. each arm gained `minFreshUnits` new units during the step, counted from no lower than where the last
   step ended;
4. the metrics are fresh (`maxStalenessMs`), make sense (no missing metric, negative count, NaN, sum of
   squares that can't go with its total, or watermark after the snapshot was taken), give every guardrail
   a reading, and no guardrail has regressed;
5. every guardrail with a `mustRuleOut` has a reading sharp enough to rule out a regression that large;
6. the next gate is approved, if the plan asks for approval.

An approval is permission, not evidence. It opens the gate on the next tick, and only if conditions 1 and
4 still hold then: the step may have passed its watch days before the yes arrived.

Guardrails are read on every tick from the moment the new behaviour is first sent to anyone, landed or
not, through every pause and every wait for approval, until the rollout is undone or its release is sent.
A release whose write never goes through goes back to its gate after `propagationMs`, so the step is
watched again.

**"Passed" means "nothing detected" unless you say otherwise.** By default a step passes when its time and
its new units are in and no guardrail has regressed, as in LaunchDarkly. On thin traffic that lets through
a regression too small to see yet: in the simulation a 25% worse error rate was released two times in
three. Give a guardrail a `mustRuleOut` and a step passes only once a regression that large is outside the
reading; a step that can't get there in its `maxDurationMs` ends as `onInsufficientData` says.

## What it promises

These are the claims the simulation in `src/sim` attacks.

1. **Never more exposure than the record says.** The flag is only ever written to `record.desired`.
   Exposure above it (a stalled worker's late write, a person raising the flag by hand) is brought back
   down on the next tick, including for `settleMs` after a rollback.
2. **Never forward without evidence.** No step-up and no release happens on missing, stale, malformed or
   failing metrics, on a failed flag read, on an approval alone, or on time passing with no new units.
   Exposure is never raised while the metrics can't be read, the first step included.
3. **A rollback always wins.** Once a rollback is saved, every tick sets the flag to nobody until it is
   seen to hold, even when the flag can't be read. Nothing moves a rolled-back rollout forward.
4. **A person who lowers the flag is left alone, and only a person is blamed.** That holds whether the
   rollout had seen its step in force yet or not, however soon after a write, during a release, and after
   one. The rollout pauses, and only an explicit resume puts the step back. A paused rollout never raises
   exposure. A read that is behind (a replica, a cache) and an edit to something other than the flag's
   shares are neither of them a person lowering the flag. A write that failed is sent again only over a
   flag that is at most one such edit on from when the write was decided.
5. **One write per won save.** Every flag write follows a save that only one worker can win, so two
   workers ticking at once send one write. A command is answered the way it was the first time, however
   often and however much later it is sent again: applied once, or refused again. Each event has one key.
6. **Honest statistics under repeated looks.** Over a whole rollout of healthy code, the chance that any
   guardrail calls it worse is at most `limits.alpha`, however often the ticks look, for all three metric
   kinds, on people as unequal as real ones. The sample ratio check has its own budget,
   `limits.sampleRatioAlpha`. Totals that can't be a measurement are read as nothing: never as healthy,
   never as worse.
7. **Everything converges.** After any mix of failed reads, failed writes, crashes and lost races, a few
   clean ticks bring the flag to `record.desired`, unless a person lowered it, which is reported and left.

Known limits, by design:

- **Providers that can't refuse a late write** (`refusesStaleWrites: false`). The package narrows the
  window (it reloads the record's version just before writing) and repairs it on the next tick. After a
  release on such a provider, a flag showing equal shares of one of the rollout's own steps is taken to be
  that late write and the release is written again; a person who set exactly those shares by hand within
  `settleMs` would be overridden. A worker frozen mid-write for longer than `settleMs` could still leave a
  stale allocation: in the simulation one chaotic run in 2,000 did, with a worker stalled for 18 minutes.
  A write whose answer was lost, then a person's change, then a read that is behind can together hide the
  person's change from the retry. Keep `settleMs` above your runtime's step timeout, and put a timeout on
  the provider call. PostHog refuses stale writes, so none of this applies there.
- **Revisions must be ordered numbers.** Everything the rollout knows about who changed the flag comes
  from them: a reading below one already seen is a read that is behind and is ignored; a flag still at the
  revision it had when a write was sent has not taken the write; a flag that has moved on and doesn't
  serve the step was changed by someone else. A provider that can only offer a tag of the flag's content
  (which comes back when the flag is put back) can't be driven safely and has no adapter here.
- **A revision that comes down.** Deleting a flag and making it again starts its revision over, and an
  adapter with a bug can answer a write with a number that is too high. Either way every reading is then
  "behind". After five minutes of that with no reading at or above the number it knew, the rollout takes
  the flag as it reads, says so in an `external_change` event, and treats whatever the flag serves as
  someone else's change: lower pauses, higher is put back. For those five minutes it holds.
- **Two quiet edits.** Between a write that failed and its retry, one edit that leaves the shares alone is
  seen for what it is. Two such edits can't be told from the write landing and a person undoing it, so the
  rollout pauses for `external_change`. A resume carries on.
- **Identities that don't stick.** When more than `maxContaminatedShare` of units are seen on both arms,
  the rollout pauses as `contaminated` and reads nothing else: units seen on both arms are left out of
  both, so neither the guardrails nor the arms' sizes mean anything.
- **Flag propagation.** `propagationMs` is how long a flag change takes to reach every evaluator. An event
  that says the flag is off means the provider serves it off; an app holding an older copy of the flag
  catches up when it next fetches it. In the simulation, phones with a cached flag were still on the new
  behaviour for some minutes after a rollback.
- **A pause on the wire.** A step change whose flag write is already on the wire when a pause arrives
  still lands. One that was only decided waits for the resume.
- **A forced release** (`release`) skips the checks that are left, the metric checks included.
- **After a rollback**, for `settleMs`, any exposure is turned off again, a person's included. Start a new
  rollout to turn the flag back on.
- **Both arms at once.** Guardrails compare arms; a failure that hits both equally is not the rollout's
  fault and is not detected.
- **Clocks.** A worker whose clock is wrong by more than `maxStalenessMs` reads fresh metrics as stale and
  holds. Step timeouts (`maxDurationMs`), expiry and the settle window are measured on worker clocks, so a
  wrong clock moves them by its error. A step's watch runs on the metric source's clock and the workers'
  at once, so one wrong clock can make it longer and never shorter; both wrong the same way could shorten
  it. A plan with no guardrails has no metric source, so its steps are timed on worker clocks alone.
- **`tick` never throws.** A store that can't be reached comes back as `status: "failed"`. A runtime that
  retries a step only when it throws should throw on `failed` itself; the workflow example below does.

## Metric kinds

- `rate`: share of units that had the event (error, conversion). Needs `units` and `sum`.
- `mean`: average per unit (errors per person). Needs `sumSquares` too. A per-person total of something
  that scales with activity (latency summed over a person's requests) is dominated by the busiest people
  and detects almost nothing; use a `ratio` for a per-request quantity.
- `ratio`: one total over another when the rows are not the unit (errors per request, latency per
  request, split by person). Needs the denominator's sums. Counting requests as units instead overstates
  the evidence; `src/stats.test.ts` shows it crying wolf.

The test is a normal-mixture confidence sequence on the difference (treatment minus control), one-sided
at `alpha / guardrails.length` each. `tuneAtUnits` is the sample size per arm where it is sharpest. A
ratio's spread is taken around the ratio both arms share, not around each arm's own: an arm where one or
two people make most of the requests fits its own ratio to them and reports almost no spread, which
called healthy code worse 10.6% of the time against a 5% budget until the simulation caught it.

That fix costs a ratio some power, because the spread it uses grows with the gap between the arms. In the
simulation a total outage was caught on a ratio in a median 27 minutes with 59 people exposed, against 9
minutes and 15 people on a rate; a doubled error rate was caught about half the time. So guard an outage
with a `rate` (people with an error) as well as any `ratio`, and where one unit can hold most of what is
under the line, cap each unit's contribution in the metric source. A ratio whose events show up on the new
arm with nothing under the line at all (the new code fails before a request is counted) is acted on as a
regression, not waited out.

**How much traffic a plan needs.** Each step needs `minFreshUnits` new units on each arm within its
`maxDurationMs`. The standard medium plan starts at 1% a side and asks for 50 new units a side within an
hour, which is about 85 new units a minute across the whole product. Below that, lower `minFreshUnits`,
lengthen the steps, start at a larger share, or pick a busier unit. The standard plans pause on too little
data and ask a person; LaunchDarkly rolls back, which on a quiet night would undo every rollout.

## PostHog

`createPostHogFlags` and `createPostHogMetrics` are the first real adapters. Both take a `transport`
(your `fetch` with a personal API key and a timeout), so the package has no HTTP client of its own.

Set the flag up once: a multivariate flag with variants `control` and `treatment` at 50/50, one release
condition with no filters at 0%. Your code checks `flag === "treatment"`.

| Allocation | What the adapter does |
|---|---|
| A step (10% treatment, 10% control) | `set_release_condition_rollout` to 20% |
| Nobody (rollback) | `set_release_condition_rollout` to 0% on every condition |
| Everybody (release) | `roll_out_to_everyone` with `variant_key: "treatment"` |

Both calls carry the flag's `version` and PostHog answers 409 when the flag changed since that version.
So a late write from a stalled worker is refused by PostHog itself, which closes the first "known limit"
above for this provider.

Metrics come from one HogQL query: people first exposed by `$feature_flag_called`, then what each of them
did afterwards, totalled per arm. A person is the unit. The watermark is `ingestionLagMs` behind the
caller's clock or PostHog's own, whichever is earlier, or the newest event of any kind when nothing has
arrived that recently, so a quiet night or a stuck pipeline reads as stale and the rollout holds. `asOf`
is PostHog's own clock. An event the project has not seen in
a month is taken for a misspelt one and the snapshot is refused, because its zeros on both arms would read
as a healthy metric; mark a metric `mayBeUnseen` when its event really can go a month without happening.
The adapter refuses a flag whose release conditions carry filters or a variant override. The query and
the freshness query were both run against a live PostHog project (2026-11-21) and parse. No flag in
PostHog has been written by this adapter yet: its tests run against a fake that enforces versions the way
the PostHog docs describe.

Other providers need only a `FlagControl`. LaunchDarkly, GrowthBook, Unleash and Flagsmith all have a
percentage rollout with sticky hashing and a management API; the mapping is the same three rows.

## Plugging into a runtime

The store is the only durable thing. Pick whichever driver your runtime makes cheap.

**A schedule** (a durable runtime's schedules, BullMQ, cron). Prefer it on a self-hosted runtime whose
upgrades strand parked workflow runs: a rollout lasts hours.

```ts
// schedules/rollouts.ts, in a runtime that runs a schedule's `run` on a cron
import { defineSchedule } from "your-runtime/schedules";
import { autopilot } from "../lib/autopilot";

export default defineSchedule({
  cron: "* * * * *",
  async run() {
    await autopilot.tickAll(Date.now());
  },
});
```

**A workflow loop** (Vercel Workflow, Temporal, Inngest), where a run survives deploys. The body stays
deterministic because the clock is read inside the step.

```ts
import { sleep } from "workflow";

export async function driveRollout(id: string) {
  "use workflow";
  while (!(await tickOnce(id))) {
    await sleep("30s");
  }
}

async function tickOnce(id: string) {
  "use step";
  const result = await autopilot.tick(id, Date.now());
  if (result.status === "failed") {
    // The store couldn't be reached. Throwing hands the retry to the runtime.
    throw new Error(result.problems.join(" "));
  }
  return result.status === "settled" || result.status === "not_found";
}
```

Both can run at once without harm: a tick that loses the save does nothing.

**Tools for the agent.** `rolloutTools(autopilot)` returns `rollout_start`, `rollout_status`,
`rollout_pause`, `rollout_resume`, `rollout_rollback`, `rollout_approve` and `rollout_release`, each a
description, a zod schema and a `run`. In a runtime that loads one file per tool:

```ts
// tools/rollout_rollback.ts
import { defineTool } from "your-runtime/tools";
import { rolloutTools } from "open-rollout";
import { autopilot } from "../lib/autopilot";

const tool = rolloutTools(autopilot).rollout_rollback;

export default defineTool({
  description: tool.description,
  inputSchema: tool.inputSchema,
  execute: (input, ctx) =>
    tool.run(input, {
      actor: ctx.userId ?? "agent",
      // The same on a retried step, so the command is applied once.
      callKey: `${ctx.sessionId}:${ctx.callId}`,
      now: Date.now(),
    }),
});
```

An approval is a command on the record, not a parked turn: a rollout that needs a yes sits in
`awaiting_approval`, the conversation carries on, and the yes arrives whenever it arrives as
`rollout_approve`. If your runtime can ask a person to confirm a tool call, put that on
`rollout_approve` and `rollout_release`.

**A store.** In Postgres it is one table:

```sql
CREATE TABLE rollouts (
  id text PRIMARY KEY,
  flag_key text NOT NULL,
  settled boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1,
  record jsonb NOT NULL
);
-- One unsettled rollout a flag: `create` is an insert that this index can refuse.
CREATE UNIQUE INDEX rollouts_one_unsettled_per_flag ON rollouts (flag_key) WHERE NOT settled;
-- `save` is: UPDATE rollouts SET record = $1, settled = $2, version = version + 1
--            WHERE id = $3 AND version = $4   -- and it won when one row changed.
```

## Releases across environments

`createReleaser` takes one change through environments in order, each with its own rollout and its own
trigger: `promotion` (starts when the one before releases), `deploy_signal` (your pipeline calls
`signal(id, environment)` when the deploy lands) or `manual`. A rollback in any environment pauses
everything that hasn't started; `resume` gives that environment a new rollout and waits for its signal
again. `start` refuses a release with a plan that can't run or an environment named twice. A stage whose
rollout can't start (its flag is already on, its last rollout hasn't settled) pauses the release and says
why in `pausedBecause`.

## What is not here

LaunchDarkly's Release Autopilot also reads a pull request to propose a flag (auto-flagging), opens
pull requests that remove finished flags (auto-cleanup), and hands a regression to an agent to fix.
Those are agent work on top of this package, not part of it. `rollout_status` returns each guardrail's
reading, which is the context a fixing agent starts from.
