# Evaluation

Every number on this page is from simulation, run on the code at import. No real rollout has used
open-rollout yet, and no real PostHog flag has been written by its adapter. The simulation is in `src/sim`;
`pnpm sim` reruns it at full size (it takes a while).

Intervals in brackets are Wilson 95% intervals for the share.

## The simulated production

`src/sim/world.ts` is a stochastic production, built by a separate agent to attack the guarantees:

- People with heavy-tailed activity who come back, some on phones that keep an old copy of the flag, some
  who log in and carry a second identity.
- Traffic that follows the hour of the day, with a quiet night; 400 visits a minute at the afternoon peak
  by default.
- A PostHog-like provider with polling evaluators, stale reads and version checks (or none).
- An event pipeline with lag (2.5 s median on servers, 8 s on clients, 2% of clients offline for up to 90
  minutes), duplicates and loss.
- Workers that interleave, stall and crash at every port call, and people at the provider's console.

The oracle checks what was really served to each person, not what the record says.

## Safety under chaos

2,000 seeded runs in each of 8 configurations. Workers interleave, stall and die at every port call while
people edit the flag and send commands.

| Configuration | What the oracle checks |
|---|---|
| Provider that checks revisions | The safety promises (1 to 5) |
| Provider that does not check revisions | The safety promises |
| Workers' clocks up to two minutes apart | The safety promises |
| A person must approve every gate | The safety promises |
| Provider that checks revisions, then calm | The flag reaches the record within a few clean ticks; no event is lost |
| Provider that does not check revisions, then calm | The same |
| No people at the console; a person says yes | Every rollout ends |
| People at the console, no revision checks, clocks apart | Every rollout ends once people stop and say yes |

No safety promise broke. One run hit the known stale-write limit: on a provider that can't refuse stale
writes, a worker stalled 18 minutes inside a write landed an old step 3 seconds after its rollback settled
([limits.md](limits.md)).

## False alarms on healthy code

The new code changes nothing; any rollback or regression pause is a false alarm. The budget is
`limits.alpha` = 5% per rollout. 300 rollouts each.

| Scenario | False "regression" rate |
|---|---|
| Low-risk plan, error rate | 1.3% [0.5, 3.4] |
| Medium-risk plan, error rate | 3.0% [1.6, 5.6] |
| Five guardrails at once | 0.3% [0.1, 1.9] |
| Ratio: errors per request | 1.0% [0.3, 2.9] |
| Ratio: latency per request | 0.7% [0.2, 2.4] |
| Looking every few seconds | 1.0% [0.3, 2.9] |
| Three workers, clocks 3 minutes apart | 1.3% [0.5, 3.4] |
| An incident that hits both arms | 1.7% [0.7, 3.8] |
| Flaky provider (failed calls, lost replies, stale reads) | 1.0% [0.3, 2.9] |
| Provider down for 8 minutes at each step | 3.0% [1.6, 5.6] |

The statistics alone, outside the world, 1,000 rollouts per guardrail kind: 0.0% to 1.9% false alarms.

The sample ratio check fired on 0 of 300 healthy rollouts in every setting.

## Catching regressions

Medium-risk plan (1%, 10%, 25%, 50%), error-rate guardrail unless noted, 100 rollouts each. "People
exposed" is how many people got the new behaviour before it was turned off, median.

| Regression | Caught | Median minutes | People exposed |
|---|---|---|---|
| Outage (every request fails) | 100% | 8.6 | 15 |
| Outage, flag provider down from minute 1 to 6 | 100% | 12.5 | 15 |
| Outage, metric source down from minute 1 to 13 | 100% | 19.4 | 17 |
| Errors 2x | 100% | 48.8 | 750 |
| Conversion −40% (conversion guardrail) | 100% | 50.1 | 838 |
| Errors 4x, only once over 25% of traffic | 100% | 69.0 | 2,509 |
| 20% of the new arm never counted | 99%, as a sample ratio mismatch | 58.5 | 1,208 |
| Errors 4x, the busiest people only | 61% | 67.8 | 2,488 |
| Errors 1.25x | 35% | 67.0 | 2,235 |
| Errors 2x, at 25 visits a minute | 0% (paused for too little data) | | |

On a ratio guardrail (errors per request):

| Regression | Caught | Median minutes | People exposed |
|---|---|---|---|
| Outage | 100% | 28.0 | 105 |
| Errors 2x | 57% [47, 66] | 59.3 | 1,593 |

What to take from this: outages are caught in minutes with a handful of people exposed. Large regressions
are caught, at the cost of the time each step watches. Small ones (1.25x) mostly pass unless a guardrail
sets `mustRuleOut`. Ratio guardrails are slow, so pair them with a rate.

## Adversarial review

A separate agent, given only the README of the time and none of the implementation's reasoning, built the
simulation and wrote failing tests against its claims (now in [guarantees.md](guarantees.md)). Three
rounds:

| Round | Failing tests found |
|---|---|
| 1 | 20, then 5 more |
| 2 | 6 |
| 3 | 6 |

All of them pass now. [design.md](design.md) lists what they taught.

## Mutation testing

Stryker on `decide`, `reconcile`, `progress`, `guard` and `write`: 608 of 659 mutants killed (92%).

## Not verified

- **The PostHog flag adapter has never written a real PostHog flag.** Its tests run against a fake that
  enforces versions the way PostHog's docs describe.
- **The two HogQL queries** (the snapshot and its freshness check) were run read-only against a live
  PostHog project on 2026-11-21 and parse.
- **No real rollout has run.** Everything above is simulation.
