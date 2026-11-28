# Known limits

Where the guarantees in [guarantees.md](guarantees.md) stop, what is not verified, and what is not built.

## By design

- **Providers that can't refuse a late write** (`refusesStaleWrites: false`). The package narrows the
  window (it reloads the record's version just before writing) and repairs it on the next tick. After a
  release on such a provider, a flag showing equal shares of one of the rollout's own steps is taken to be
  that late write and the release is written again; a person who set exactly those shares by hand within
  `settleMs` would be overridden. A worker frozen inside a write for longer than `settleMs` (10 minutes by
  default) can still leave a stale allocation: one simulated run did, with a worker stalled for 18 minutes
  ([evaluation.md](evaluation.md)). A write whose answer was lost, then a person's change, then a read that
  is behind can together hide the person's change from the retry. Keep `settleMs` above your runtime's step
  timeout, and put a timeout on the provider call. PostHog refuses stale writes, so none of this applies
  there.
- **Revisions must be ordered numbers.** A provider that can only offer a tag of the flag's content (which
  comes back when the flag is put back) can't be driven safely and has no adapter here.
- **A revision that comes down.** Deleting a flag and making it again starts its revision over, and an
  adapter with a bug can answer a write with a number that is too high. Either way every reading is then
  "behind". After five minutes of that with no reading at or above the number it knew, the rollout takes
  the flag as it reads, says so in an `external_change` event, and treats whatever the flag serves as
  someone else's change: lower pauses, higher is put back. For those five minutes it holds.
- **Two quiet edits.** Between a write that failed and its retry, one edit that leaves the shares alone is
  seen for what it is. Two such edits can't be told from the write landing and a person undoing it, so the
  rollout pauses for `external_change`. A resume carries on.
- **Small regressions pass unless you ask otherwise.** A step passes when nothing was detected. Errors 1.25
  times as common were caught in 35% of simulated rollouts. Set `mustRuleOut` on a guardrail to make a step
  wait until a regression that large is ruled out ([statistics.md](statistics.md)).
- **Ratio guardrails are slow.** An outage took a median 28 minutes and 105 people exposed on a ratio,
  against 8.6 minutes and 15 people on a rate. Guard outages with a rate too.
- **Both arms at once.** Guardrails compare arms. A failure that hits both equally (an incident, a bad
  deploy of something else) is not the rollout's fault and is not detected by them. Give the autopilot an
  `IncidentFeed` (`open-rollout/datadog` reads Datadog monitors) and every rollout holds while one is open;
  without a feed, nothing holds it. A hold doesn't stop the step's watch, so a step that was watched all
  through an incident moves on as soon as it clears, and one whose deadline passed during it can give up.
- **Identities that don't stick.** When more than `maxContaminatedShare` of units are seen on both arms,
  the rollout pauses as `contaminated` and reads nothing else: units seen on both arms are left out of
  both, so neither the guardrails nor the arms' sizes mean anything.
- **"Rolled back" means the provider serves the flag off.** `propagationMs` is how long a flag change takes
  to reach every evaluator. An app holding an older copy of the flag catches up when it next fetches it,
  and the `rolled_back` event says so. In simulation, phones with a cached flag were still on the new
  behaviour for some minutes after a rollback. For a mobile app, set `limits.propagationMs` to how long the
  app takes to pick up a change, so each step is watched from when phones have it. Crash rates per arm
  need each crash tied to the arm it ran on: crashes sent to PostHog are matched to the person's first
  exposure; crashes in Crashlytics need the variant set as a custom key, and a metric source over its
  BigQuery export, which is not built.
- **After a rollback**, for `settleMs`, any exposure is turned off again, a person's included. Start a new
  rollout to turn the flag back on.
- **Clocks.** A worker whose clock is wrong by more than `maxStalenessMs` reads fresh metrics as stale and
  holds. Step timeouts (`maxDurationMs`), expiry and the settle window are measured on worker clocks, so a
  wrong clock moves them by its error. A step's watch runs on the metric source's clock and the workers'
  at once, so one wrong clock can make it longer and never shorter; both wrong the same way could shorten
  it. A plan with no guardrails has no metric source, so its steps are timed on worker clocks alone.
- **Quiet products, and quiet paths.** A unit counts only once its request evaluates the flag, so a fix on
  a path few people reach gathers units slowly. A step needs `minFreshUnits` new units per arm within
  `maxDurationMs`. The standard medium plan needs about 85 new units a minute across the product; below
  that its rollouts pause for too little data. `standardPlan({ unitsPerHour })` stretches each step to
  the time its units take to arrive and keeps its deadline inside the rollout's expiry, `forecast` says how
  long that comes to and what can't work, `rollout_start` sizes to the traffic the metric source measures
  and refuses a flag nobody evaluates, and `planProblems` refuses a step whose watch alone outlasts the
  expiry. A path too quiet for that is one to ship without a
  flag. The traffic is a day's average: a step that falls in a quiet night takes longer.
  `standardPlan({ overrides: { everyStep: { minFreshUnits, minDurationMs } } })` asks for fewer units over
  longer steps. Counting accounts rather than people (`unit: { groupTypeIndex }` on the
  PostHog source) makes this much sharper: a B2B product may gain a few accounts a day. Give such a plan
  a `minFreshUnits` and `limits.minUnitsToJudge` it can reach and steps measured in days, and expect only
  large regressions to be caught, because tens of accounts an arm leave the interval wide.
- **Metrics that arrive late.** A step passes only once the metric source's data covers its whole watch,
  so a source an hour behind (a warehouse loaded hourly) adds an hour to every step, and a regression is
  seen an hour after it starts. `standardPlan({ sourceLagMs })` gives the staleness limit and every step's
  deadline that much more room, and `planProblems` refuses a plan whose `limits.sourceLagMs` leaves a step
  no time. A plan that doesn't know about the lag reads hour-old metrics as stale: it holds where it is and
  reports `metrics_outage`. A step counts the units it starts from only once its metrics have caught up
  with its start, so units exposed in the step before are never taken for new ones; units exposed while
  the metrics catch up are not counted as new either, so a lagging source asks each step for a little more
  traffic. What a watermark claims is taken as true: an exposure that arrives after the source said its
  data was complete still counts as new in the step that sees it. On a simulated source whose watermark
  claimed everything up to its newest event, 1 of 400 rollouts on a small product moved on from a step
  with 49 truly new people on an arm against 50 asked.

- **A goal makes the last step wait, and watching longer costs false alarms.** The last step is watched
  until every goal is shown better or its deadline passes. Healthy code on the medium plan was rolled back
  for a regression in 4.7% [2.8, 7.7] of simulated rollouts with a goal, against 3.0% [1.6, 5.6] without;
  a last step watched for two hours without a goal gave the same 4.7%. Why a longer watch costs more is
  not settled; a likely cause is that a unit's outcome keeps changing as it comes back, which the test
  assumes it doesn't. [evaluation.md](evaluation.md) has the numbers.
- **A fix for a rare bug is often left unproven.** A fix that halved an error one request in 10,000 has was
  shown to work before its deadline in 34% of simulated rollouts; the rest paused as `unproven` for a
  person to release, keep watching or roll back.

## Not verified

- No rollout with real people on it has run on open-rollout. Every number in these docs is from
  simulation.
- `createPostHogFlags` has written real flags: `pnpm live:posthog` made throwaway flags in a PostHog Cloud
  project on 2026-11-27, wrote steps, a release and a rollback, was refused a stale write, ran a whole
  low-risk rollout (guardrails read from memory), and deleted them.
- The PostHog metric and traffic queries were run read-only against a live project and parse, on a flag
  nobody evaluates; no real exposure has been counted by them.
- The Datadog incident feed has not been run against Datadog. Its tests use a fake that answers the way
  the monitors API is documented to.

## Not built

- A database-backed store. [guarantees.md](guarantees.md#a-postgres-store) has the one-table Postgres
  shape; the package ships an in-memory store.
- Flag adapters for providers other than PostHog, such as GrowthBook.
- A metric source over Crashlytics (or any warehouse table), for crash rates per arm.
- Percentile metrics (P99 latency). Use a `rate` of "slower than the budget" instead.
- Proposing a flag from a pull request, opening pull requests that remove finished flags, and handing a
  regression to an agent to fix. These are agent work on top of this package; `rollout_status` returns
  each guardrail's reading, which is where such an agent would start.
