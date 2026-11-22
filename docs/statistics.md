# Statistics

How a guardrail decides that the new behaviour is worse, and why the answer stays honest when a rollout
asks every few seconds. The code is in `src/stats.ts` and `src/judge.ts`.

## The problem with looking often

A rollout looks at its metrics on every tick. A fixed-sample test such as a t-test controls its error rate
for one look. Asked a thousand times over a rollout, it will sooner or later call healthy code worse by
chance and roll it back. Asked rarely, it lets real regressions through for longer.

## The test

Each guardrail compares the new arm with the old one: the difference treatment minus control. Its bounds
come from a normal-mixture confidence sequence (Howard et al. 2021; Waudby-Smith et al. 2024), which holds
its error rate over every look at once instead of over one.

- A guardrail calls a regression when the whole interval is on the worse side of its `tolerance`. The call
  is one-sided at `limits.alpha / guardrails.length`, so adding guardrails does not add false alarms.
  `limits.alpha` defaults to 0.05 over a whole rollout.
- `limits.tuneAtUnits` (default 1,000) is the number of units per arm at which the bound is tightest. It is
  wide early, when a few units could say anything.
- No guardrail is read until each arm has `limits.minUnitsToJudge` units (default 10).

## Metric kinds

| Kind | What it measures | What the source must send per arm |
|---|---|---|
| `rate` | Share of units that had the event (errors, conversion) | `units`, `sum` (units with the event) |
| `mean` | Average per unit (errors per person) | `units`, `sum`, `sumSquares` |
| `ratio` | One total over another when the rows are not the unit (errors per request, latency per request, split by person) | `units`, `sum`, `sumSquares`, and `denominator: { sum, sumSquares, crossSum }` |

The unit is a person (or account), not a row. Counting each request as a unit overstates the evidence,
because one person's requests fail together; `src/stats.test.ts` shows that version crying wolf on the
same data.

A `mean` of something that scales with activity, such as latency summed over a person's requests, is
dominated by the busiest people and detects almost nothing. Use a `ratio` for a per-request quantity.

### The ratio's spread

A ratio's variance comes from the delta method, taken around the ratio both arms share rather than each
arm's own. Taken around each arm's own ratio, an arm where one or two people make most of the requests fits
its ratio to them and reports almost no spread. In simulation that version called healthy code worse 10.6%
of the time against a 5% budget. Around the shared ratio it is about 1%.

That fix costs power, because the spread it uses grows with the gap between the arms. In simulation a
total outage was caught on a ratio in a median 28 minutes with 105 people exposed, against 8.6 minutes and
15 people on a rate, and a doubled error rate was caught 57% of the time ([evaluation.md](evaluation.md)).
So guard an outage with a `rate` (people with an error) as well as any `ratio`, and where one unit can hold
most of what is under the line, cap each unit's contribution in the metric source.

To compare two arms outside a rollout, `estimateArms(kind, { control, treatment })` gives both estimates for
`differenceInterval`, a ratio's spreads taken around the shared ratio as the guardrails take them.
`estimateArm` takes a rate or a mean only: one arm alone has no shared ratio to take a ratio's spread from.

A ratio whose events show up on the new arm with nothing under the line at all (the new code fails before
a request is counted) is acted on as a regression, not waited out as too little traffic.

## "Passed" means "nothing detected" unless you say otherwise

By default a step passes when its time and its new units are in and no guardrail has regressed. On thin
traffic that lets through a regression too small to see yet: in simulation, errors 1.25 times as common
were caught in only 35% of rollouts. Give a guardrail a `mustRuleOut` and a step passes only once a
regression that large is outside the interval. A step that can't get there within its `maxDurationMs` ends
as `onInsufficientData` says.

## Sample ratio check

Both arms get equal shares, so their sizes should match. When units go missing unevenly (the new arm
crashes before it logs an exposure, or assignment is broken), the comparison can't be trusted. A sequential
test on the share of units on the new arm checks this on every look, with its own budget,
`limits.sampleRatioAlpha` (default 0.001). A mismatch does what `onSampleRatioMismatch` says; the standard
plans roll back. In simulation it fired on none of 300 healthy rollouts in any setting, and caught a new
arm that lost 20% of its units in 99 of 100 rollouts.

## Data that can't be right

A snapshot with a missing metric, a negative count, a NaN, a sum of squares too small for its total, or a
watermark later than the snapshot itself is read as nothing: never as healthy and never as worse. The
rollout holds, and after `maxBlindMs` without usable metrics it does what `onMetricsOutage` says.

Units seen on both arms (identities that merged at login) are left out of both. When more than
`maxContaminatedShare` (default 1%) of units are, the rollout pauses as `contaminated`.

## How much traffic a plan needs

Each step needs `minFreshUnits` new units on each arm within its `maxDurationMs`. The standard medium plan
starts at 1% a side and asks for 50 new units a side within an hour, which is about 85 new units a minute
across the whole product. Below that, lower `minFreshUnits`, lengthen the steps (`standardPlan`'s
`overrides.everyStep` does both), start at a larger share, or pick a busier unit. In simulation, on a
product with 25 visits a minute, a doubled error rate was caught in none of 100 rollouts: they paused for
too little data, which is what the standard plans do instead of rolling back.
