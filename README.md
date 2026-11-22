# open-rollout

[![CI](https://github.com/dholliday3/open-rollout/actions/workflows/ci.yml/badge.svg)](https://github.com/dholliday3/open-rollout/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A TypeScript library for guarded feature flag rollouts: step traffic up, watch guardrail metrics, roll back
on a regression. Works with any flag provider.

**Status:** pre-1.0 and not on npm. No real rollout has run on it yet. [Details](#status).

Most percentage rollouts are a person moving a slider and watching a dashboard. Automating that is harder
than it looks. Run a t-test every minute and healthy code gets rolled back by chance; check less often and
real regressions ship. And the automation has to stay correct when its job is retried, crashes halfway,
runs on two workers at once, or meets a person who changed the flag by hand. Commercial flag platforms sell
this as a feature of their own flags and metrics ([Compared to](#compared-to)).

open-rollout moves a flag through steps, compares the new behaviour with the old at each step using a test
that stays valid however often it looks, and undoes the rollout when the new behaviour is worse. It runs on
your flag provider, metrics and job runner, with its state in a store you own. It is for teams that have
feature flags and product analytics and want automatic rollback without changing vendors.

```ts
import {
  createAutopilot,
  createMemoryFlags,
  createMemoryNotifier,
  createMemoryStore,
  standardPlan,
} from "open-rollout";
import { simulatedTraffic } from "./simulated-traffic";

const flags = createMemoryFlags();
const notifier = createMemoryNotifier();
const traffic = simulatedTraffic({
  flags,
  flagKey: "new-checkout",
  metric: "errors",
  errorRate: { control: 0.02, treatment: 0.02 },
});
const autopilot = createAutopilot({ flags, metrics: traffic, notifier, store: createMemoryStore() });

const plan = standardPlan({
  flagKey: "new-checkout",
  risk: "low",
  guardrails: [
    { metric: "errors", kind: "rate", direction: "lower_is_better", tolerance: 0, onRegression: "rollback" },
  ],
});
await autopilot.start({ id: "checkout-1", plan, now: traffic.now() });

for (let minute = 0; minute < 60; minute += 1) {
  traffic.passMinute();
  await autopilot.tickAll(traffic.now());
}

for (const event of notifier.events) {
  console.log(`${event.type}: ${event.detail}`);
}
```

```text
started: Rollout of new-checkout started.
step_started: 10% of traffic is on the new behaviour.
step_started: 50% of traffic is on the new behaviour.
releasing: Every step passed. Releasing to everybody.
released: Released: the flag is on for everybody.
```

That is [`examples/quickstart.ts`](examples/quickstart.ts) (`pnpm quickstart`). The in-memory adapters
stand in for a flag provider, and [`simulated-traffic.ts`](examples/simulated-traffic.ts) for analytics: an
hour of traffic at 1,000 people a minute, in under a second. Give the new arm an error rate of 0.10 and
the rollout is rolled back three minutes in, at 10%. [`quickstart.test.ts`](examples/quickstart.test.ts) checks both.

## Status

> - **Built and tested:** the decision core, the controller, the statistics, the in-memory adapters, the
>   agent tools and releases across environments, with unit tests and a simulation (`src/sim`) that
>   attacks the guarantees below.
> - **Not verified against the real service:** the PostHog flag adapter has never written a real PostHog
>   flag; its tests use a fake that enforces versions the way PostHog's docs describe. Its two HogQL
>   queries were run read-only against a live project and parse.
> - **Not run for real:** no production rollout has used it yet. The numbers in this README are from
>   simulation.
> - **May change:** any API, before 1.0.
> - **Not built:** a database-backed store, adapters for providers other than PostHog, percentile metrics,
>   and a compiled build (the package ships TypeScript source).

## Install

```sh
pnpm add github:dholliday3/open-rollout
```

Requires Node 22.12 or later. The one runtime dependency is zod 4.

The package exports its TypeScript source (`src/index.ts`) and has no build step yet, so:

- Load it through something that compiles TypeScript inside `node_modules`. tsx 4.23, Bun 1.3 and an
  esbuild 0.28 bundle were checked. Plain `node` refuses: it does not strip types under `node_modules`.
- Type-check with `"moduleResolution": "bundler"`. Under `nodenext`, or with flags beyond `strict` such as
  `exactOptionalPropertyTypes`, your `tsc` reports errors inside the package's source.

## How it works

```text
tick(id, now): load record → read flag → read metrics → decide() → save (compare-and-set) → write flag → notify
                                                         pure        a lost save stops here
```

- **A rollout is a record** in a store you own. `tick` loads it, reads the flag and the metrics once, and
  calls `decide(record, observation, now)`, a pure function with no clock and no I/O that returns the next
  record and at most one flag write.
- **Save, then write.** The record is saved with compare-and-set before the flag is written, so only one
  worker acts on a decision. A tick can be late, repeated, run on two workers at once or cut off anywhere,
  and the next tick carries on from the record.
- **Equal arms.** Each step gives the new behaviour (treatment) and the old one (control, measured) equal
  shares, such as 10% and 10%, then 50% and 50%, then releases to everybody. A bad hour lands on both arms
  alike, and the arms should always be the same size, which a sample ratio check tests.
- **A test built for repeated looks.** Each guardrail compares treatment minus control with a
  normal-mixture confidence sequence, so the chance of calling healthy code worse over a whole rollout
  stays under `limits.alpha` (5% by default) however often it ticks. Details in
  [docs/statistics.md](docs/statistics.md).
- **No answer is not good news.** A failed read, stale or malformed metrics, or too few new people hold the
  rollout. They never move it forward.

Phases: `ramping` → `releasing` → `released`, with `awaiting_approval` before any gate that needs a
person, `paused` from any live phase, and `rolling_back` → `rolled_back` from anywhere before the release.
A finished rollout is watched for `settleMs` (10 minutes) and then settles.

## Usage

### Plans

`standardPlan({ flagKey, guardrails, risk })` picks a ladder by risk:

| Risk | Share on the new behaviour | Least watch per step | Approval |
|---|---|---|---|
| `low` | 10%, 50% | 10, 10 min | none |
| `medium` | 1%, 10%, 25%, 50% | 10, 15, 15, 20 min | none |
| `high` | 1%, 5%, 10%, 25%, 50% | 30, 30, 60, 120, 240 min | before the release |

Control gets the same share at each step. A step also needs 50 new people on each arm, and gives up after
six times its least watch (the standard plans pause and ask a person). A guardrail is `{ metric, kind,
direction, tolerance, onRegression, mustRuleOut? }`, where `kind` is `rate`, `mean` or `ratio`. A plan is
a plain object, so you can build your own; `planProblems(plan)` lists what is wrong with it.

### Running ticks

The store is the only durable state, so any scheduler works: cron, a BullMQ repeatable job, a durable
runtime's schedule, or a workflow that ticks one rollout and sleeps. Call this every minute or so:

```ts
async function tickRollouts(autopilot: Autopilot): Promise<void> {
  const results = await autopilot.tickAll(Date.now());
  const problems = results
    .filter((result) => result.status === "failed")
    .flatMap((result) => result.problems);
  if (problems.length > 0) {
    throw new Error(problems.join(" "));
  }
}
```

`tick` never throws. A store it can't reach comes back as `status: "failed"`, and throwing on that hands
the retry to your runtime. Two schedulers ticking the same rollout is safe: the tick that loses the save
does nothing. People and services steer a rollout with `autopilot.command(id, command, now)` (`pause`,
`resume`, `rollback`, `release`, `approve`) and read it with `autopilot.inspect(id)`.

### Agent tools

`rolloutTools(autopilot)` returns `rollout_start`, `rollout_status`, `rollout_pause`, `rollout_resume`,
`rollout_rollback`, `rollout_approve` and `rollout_release`. Each is a `description`, a zod `inputSchema`
and a `run`, so it wraps into an AI SDK tool or an MCP server in a few lines.

```ts
async function rollBackCheckout(autopilot: Autopilot): Promise<ToolAnswer> {
  const tools = rolloutTools(autopilot);
  const answer = await tools.rollout_rollback.run(
    { id: "checkout-1", note: "Support is seeing failed payments." },
    { actor: "alice", callKey: "session-42:call-7", now: Date.now() },
  );
  return answer;
}
```

`callKey` must be the same when your runtime retries the call, so the command is applied once. A rollout
that needs a yes waits in `awaiting_approval` until `rollout_approve` arrives; nothing parks a conversation.

### Releases across environments

`createReleaser({ store, autopilotFor })` takes one change through environments in order, such as staging
then production, each with its own rollout. A stage starts on `promotion` (the one before it released), a
`deploy_signal` from your pipeline, or a `manual` go. A rollback anywhere pauses the stages that haven't
started.

## Adapters

| Port | What it must do | Included |
|---|---|---|
| `FlagControl` | Read and write a flag's whole allocation, with a revision number that only goes up | `createMemoryFlags`, `createPostHogFlags` |
| `MetricSource` | Running totals per arm since a time, with `asOf` and `watermark` on its own clock | `createMemoryMetrics`, `createPostHogMetrics` |
| `RolloutStore` | Save with compare-and-set; one unsettled rollout per flag | `createMemoryStore` |
| `Notifier` | Deliver events; it may get one twice, and `event.key` tells repeats apart | `createMemoryNotifier` |

Full contracts and a one-table Postgres store: [docs/guarantees.md](docs/guarantees.md#ports).

**PostHog.** Make a multivariate flag with variants `control` and `treatment` at 50/50 and one release
condition with no filters at 0%; your code checks `flag === "treatment"`. Both adapters take a transport
(your `fetch` with an API key and a timeout); [`examples/posthog.ts`](examples/posthog.ts) wires them up.
Every flag write carries the flag's `version`, so PostHog itself refuses a stalled worker's late write
(409). Metrics come from a HogQL query that counts people from their first `$feature_flag_called`.

**Other providers** need only a `FlagControl`: flags with a revision number that goes up on every change,
and a percentage rollout with sticky bucketing. A content hash that repeats when a flag is put back is not
enough.

## Guarantees and limits

[docs/guarantees.md](docs/guarantees.md) states each of these and what it rests on:

1. Never more exposure than the record says.
2. Never forward without evidence.
3. A rollback always wins.
4. A person who lowers the flag is left alone, and only a person is blamed.
5. One flag write per won save; a command sent twice is applied once.
6. The false-alarm rate holds under repeated looks.
7. After any mix of failures, a few clean ticks bring the flag to what the record says.

In simulation ([docs/evaluation.md](docs/evaluation.md)): 2,000 seeded runs in each of 8 chaotic
configurations broke none of these. Healthy code was called worse in 0.3% to 3.0% of rollouts against a 5%
budget. A total outage was caught in all 100 rollouts, in a median 8.6 minutes, with 15 people exposed.

Known limits ([docs/limits.md](docs/limits.md)):

- On a provider that can't refuse a stale write, a worker frozen inside a write for longer than `settleMs`
  can land an old step. PostHog refuses stale writes.
- Small regressions pass unless a guardrail sets `mustRuleOut`: errors 1.25 times as common were caught in
  35% of simulated rollouts.
- Ratio guardrails are slow: an outage took a median 28 minutes on one, against 8.6 on a rate.
- "Rolled back" means the provider serves the flag off. A client holding a cached flag catches up on its
  next fetch.

## Compared to

LaunchDarkly's guarded rollouts, part of its Release Autopilot, do this inside its own platform. open-rollout
follows the rules it publishes where they are known: equal traffic on both arms, a largest measured step
of 50%, a sequential test on new minus old, and a sample ratio check. The differences:

- It is a library. The flags, metrics, store and scheduler are yours; changing flag provider means writing
  one adapter.
- On too little data, the standard plans pause and ask a person. LaunchDarkly rolls back a step that never
  reaches its minimum sample.
- It does not propose flags from pull requests, remove finished flags, or hand a regression to an agent to
  fix. `rollout_status` returns each guardrail's reading, which is where such an agent would start.

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md), and [docs/design.md](docs/design.md) for why it is built this way.
[MIT](LICENSE) licensed.
