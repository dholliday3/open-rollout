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
  deploy of something else) is not the rollout's fault and is not detected.
- **Identities that don't stick.** When more than `maxContaminatedShare` of units are seen on both arms,
  the rollout pauses as `contaminated` and reads nothing else: units seen on both arms are left out of
  both, so neither the guardrails nor the arms' sizes mean anything.
- **"Rolled back" means the provider serves the flag off.** `propagationMs` is how long a flag change takes
  to reach every evaluator. An app holding an older copy of the flag catches up when it next fetches it.
  In simulation, phones with a cached flag were still on the new behaviour for some minutes after a
  rollback.
- **After a rollback**, for `settleMs`, any exposure is turned off again, a person's included. Start a new
  rollout to turn the flag back on.
- **Clocks.** A worker whose clock is wrong by more than `maxStalenessMs` reads fresh metrics as stale and
  holds. Step timeouts (`maxDurationMs`), expiry and the settle window are measured on worker clocks, so a
  wrong clock moves them by its error. A step's watch runs on the metric source's clock and the workers'
  at once, so one wrong clock can make it longer and never shorter; both wrong the same way could shorten
  it. A plan with no guardrails has no metric source, so its steps are timed on worker clocks alone.
- **Quiet products.** A step needs `minFreshUnits` new units per arm within `maxDurationMs`. The standard
  medium plan needs about 85 new units a minute across the product; below that its rollouts pause for too
  little data.

## Not verified

- No real rollout has run on open-rollout. Every number in these docs is from simulation.
- No real PostHog flag has been written by `createPostHogFlags`. Its tests use a fake that enforces
  versions the way PostHog's docs describe.
- The PostHog metric queries were run read-only against a live project and parse; that is all.

## Not built

- A database-backed store. [guarantees.md](guarantees.md#a-postgres-store) has the one-table Postgres
  shape; the package ships an in-memory store.
- Flag adapters for providers other than PostHog.
- Percentile metrics (P99 latency). Use a `rate` of "slower than the budget" instead.
- A compiled build. The package exports TypeScript source; see the README's [install section](../README.md#install).
- Proposing a flag from a pull request, opening pull requests that remove finished flags, and handing a
  regression to an agent to fix. These are agent work on top of this package; `rollout_status` returns
  each guardrail's reading, which is where such an agent would start.
