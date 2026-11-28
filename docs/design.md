# Design

Why open-rollout is shaped the way it is, and what attacking it taught. The [README](../README.md) has the overview and examples, [guarantees.md](guarantees.md) the contract, [statistics.md](statistics.md) the test, and [evaluation.md](evaluation.md) the numbers.

Nothing in production uses it yet. Its PostHog adapter has written real flags, on throwaway flags in a
real project ([evaluation.md](evaluation.md#against-a-real-posthog-project)).

## The decisions

- **A rollout is a record in a store, not a workflow run.** A tick loads the record, looks at the flag and the metrics once, runs a pure function (`decide`), saves with compare-and-set, and only then writes the flag.
  - Why not one long workflow with `sleep` between steps: a rollout lasts hours, and on a self-hosted durable runtime an upgrade can strand open runs. A durable runtime also gives at-least-once steps, never exactly-once, so a flag write can always happen twice or late.
  - So every write sets the flag's whole state (never an increment), only the worker whose save won may write, and the next tick repairs whatever is wrong. A tick can be late, repeated, run twice at once or cut off anywhere.
  - The same record can be driven by a runtime's schedule, a workflow loop, BullMQ or cron, or by two of them at once.
- **Equal treatment and control shares at every step** (10% each, then 50% each, then everybody). This is LaunchDarkly's rule, and the reason is time: with 1% against 99% early and 50% against 50% later, a bad hour that hits everyone lands unevenly on the two arms and reads as a regression. Equal shares also mean the arms should always be the same size, which is what the sample ratio check tests. It costs a multivariate flag and caps a measured step at half.
- **A confidence sequence, not a fixed-sample test.** A rollout looks at its metrics every tick. A t-test asked a thousand times cries wolf; a normal-mixture confidence sequence (Howard et al. 2021, Waudby-Smith et al. 2024) holds its error rate over every look at once. LaunchDarkly moved guarded rollouts from a Bayesian model to this family in January 2026 for the same reason. Each guardrail gets an equal part of the plan's error rate.
- **People are the unit, not rows.** Errors per request, split by person, is a `ratio` metric with a delta-method variance. Counting each request as a unit overstates the evidence, because one person's requests fail together; `src/stats.test.ts` shows that version crying wolf on the same data.
- **Evidence is counted on the metric source's clock, and the workers' clock has to agree.** A step moves on when the metrics' watermark covers the step's watch, the step has been in force that long by the workers' clock too, and each arm has gained new units during it. Wall-clock time alone would walk a rollout to 100% overnight with nobody on the site. Either clock alone can be wrong or be put right in the middle of a step.
- **No answer is never good news.** A failed read, stale metrics, a missing metric, a NaN or a guardrail too thin to read all hold the rollout. The first version let a garbage snapshot through as healthy.
- **More exposure than the record says is never left standing; less is a person's call.** Someone lowering the flag by hand pauses the rollout and is left alone. Anything raising it (a stalled worker's late write, a person) is brought back down, including for `settleMs` after a rollback.
- **A fix is shown to work before it is released, by the same test pointed the other way.** Guardrails only
  look for harm, so a change that fixed nothing passed as one that did. A guardrail with `mustImproveBy` is
  also a goal: the release waits until its interval is wholly on the better side. Making it a guardrail
  rather than a separate list means the source already fetches it and a fix that makes the bug worse rolls
  back; the improvement call gets its own error budget, because calling a non-fix a fix is a different
  mistake from calling healthy code worse. Only the release waits for it, since a 1% step can't show an
  improvement and the evidence carries across steps anyway.
- **A step is sized to the traffic that reaches the flag, not the product's.** A unit counts only once its
  request evaluates the flag, so a fix on a quiet path stalls in steps timed in minutes. The metric source
  can count the units that evaluated the flag over a day (before anyone is on it, since an off flag is still
  evaluated), each step is stretched to the time its units take, and a plan whose steps would outlast the
  rollout's expiry is refused up front: that path is one to ship without a flag.
- **An incident holds, from a feed the tick reads, not a command someone sends.** An incident hits both
  arms, so no guardrail sees it. A tick reads an optional incident feed after the metrics, and while one is
  open (or the feed can't be read) nothing moves forward. Pulled on every tick, the hold needs no state of
  its own to get stuck in and lifts when the monitor recovers; a pushed "hold everything" command would need
  someone to send the matching "carry on". The watch keeps running and the guardrails keep acting, so a hold
  only ever stops exposure going up.
- **An approval is a command on the record, not a parked turn.** A rollout that needs a yes sits in `awaiting_approval` while the conversation carries on. An agent's draft never holds the conversation, and neither does a rollout.

## What attacking it found

A separate agent, given none of the implementation's reasoning, built a simulated production in `src/sim` and attacked the claims now in [guarantees.md](guarantees.md) over three rounds: people with heavy-tailed activity who come back, a PostHog-like provider with polling evaluators and stale reads, an event pipeline with lag and loss, workers that interleave, stall and crash at every port call, and people at the provider's console. Its oracle checks what was really served, not the record. The first version failed 20 of its tests. What that taught, for whoever builds the next thing like this:

- **An approval is permission, not evidence.** The first version released the moment a yes arrived, with the metrics down or already failing. A gate now opens on the next tick, and only if the evidence still holds.
- **"My write hasn't landed" and "a person changed it back" look the same on the next read.** They need opposite answers: send it again, or leave it alone. The first fix was a pile of bookkeeping (a revision history, an acknowledged flag, two timers). The second round's criticism was to delete it: make the flag's revision an ordered number and have a write return the revision it left. Then a flag still at the revision it had when the write was sent hasn't taken the write, and a flag that has moved on and doesn't serve the step was changed by someone else.
- **One read is not the truth.** A read answered from a replica that is behind paused rollouts and blamed a person. With ordered revisions, a reading below one already seen is simply ignored.
- **Whose clock is it?** A step's watch was measured from a worker's clock to the metrics' watermark, so a stalled tick, a slow clock or shrinking lag shortened it. A snapshot now carries the source's own time, the watch runs between two times on that one clock, and a tick reads the flag before the metrics. Round three then put the source's clock right in the middle of a step, which shortened the watch again. The watch now has to be complete on both clocks, each measured against itself.
- **A rule with no way back is a trap.** "A reading below a revision already seen is behind, so ignore it" froze a rollout for good the first time the number came down: a flag deleted and made again, or one write answered with a number too high. Nothing was reported. A flag that reads behind for five minutes is now taken as it reads, with an event. Any rule that says "ignore this" needs a limit on how long.
- **One edit is not two.** A write that failed, then someone editing the flag's description, read as a person lowering the flag. The opposite fix (send again whenever the shares are unchanged) wrote over a kill switch: the write had landed, its answer was lost, and a person had turned the flag off. The rule that survives both: send again only when the flag is exactly one revision on with the shares it had. One edit can't be both our write and a person undoing it.
- **The textbook ratio variance is wrong on real people.** Taken around each arm's own ratio, it called healthy code worse 10.6% of the time against a 5% budget, once a few returning people made most of the requests. Taken around the ratio both arms share, it is about 1%. My own test passed the broken version because its heavy users were a fixed tenth, not a few who dominate. The fix costs power: an outage takes about three times as long to catch on a ratio as on a rate, so guard an outage with a rate too.
- **Garbage is not good news, and neither is silence.** A metric with a missing field, a NaN, or a sum of squares too small for its total used to read as healthy or as a regression. It now reads as nothing. A misspelt event name still gave zeros on both arms, which read as healthy; the PostHog source now refuses an event the project has not seen in a month.
- **"Passed" was "not yet detectable".** A 25% worse error rate was released two times in three. `mustRuleOut` on a guardrail makes a step wait until a regression that large is ruled out.
- **A count is only as complete as its watermark.** A step counted the units it started from in the first snapshot after it was in force, which was complete only up to a minute or more before; exposures from the step before arrived later and were counted as new. Found after the attack rounds, by a small product whose sized steps asked for exactly the traffic they got. A step now takes that count from the first snapshot whose watermark has reached its start.
- **A person who lowers a flag is always right; a person who raises one never is.** Every round found another moment (before the first confirmation, 45 seconds after a write, during a release, after one) where a kill switch was overwritten.

The third round's 2,000 chaotic runs found one failure the package doesn't fix: on a provider that can't refuse a stale write, a worker stalled for 18 minutes inside a write landed an old step 3 seconds after its rollback settled. [limits.md](limits.md) lists it. PostHog refuses the write.

`pnpm sim` reruns the simulation at full size for its numbers. Still open: the first real rollout, and ratio guardrails are slow ([statistics.md](statistics.md#the-ratios-spread)).

## PostHog

PostHog is the first provider with an adapter. It needs a multivariate flag with `control` and `treatment` at 50/50 and one release condition with no filters.

- A step is `set_release_condition_rollout` to twice the step's share. A rollback sets every condition to 0. A release is `roll_out_to_everyone` with `variant_key: "treatment"`, which adds a condition at 100% above the old one and rewrites the split to 0/100, so a released flag needs one condition and 50/50 put back before it can be rolled out again; `start` asks the adapter (`setupProblem`) and refuses until it is.
- Both calls take the flag's `version` and answer 409 when the flag changed after it. So PostHog itself refuses a stalled worker's late write. The plain `PATCH` with `filters` checks the version only on flags whose `filters.version` is 2, and replaces the whole `filters` object, so the adapter never uses it.
- `version` goes up by one on every saved edit. That is the ordered revision the package's whole notion of "who changed the flag" rests on.
- PostHog hashes "is this person in" and "which variant" separately, so raising the percentage keeps everyone who was in and never moves anyone between variants.
- Server SDKs poll flag definitions every 30 seconds by default. `limits.propagationMs` (60 seconds) is that, doubled.
- Exposure is the `$feature_flag_called` event (`$feature_flag`, `$feature_flag_response`). The metric source is one HogQL query; it and its freshness query were run against a live PostHog project on 2026-11-21 and parse.
- The unit is a person (`person_id`), or with `unit: { groupTypeIndex }` a group such as a B2B account: the events' `$group_0` to `$group_4`, leaving out events sent without that group. The group form of the query was run against a live project on 2026-11-22 and parses.
- These facts come from the descriptions of PostHog's own MCP server tools, read on 2026-11-21, and were checked against PostHog Cloud on 2026-11-27 by `pnpm live:posthog`: the step, the stale-write 409, the no-op write that keeps the version, the release, the rollback, and a whole rollout.

## What LaunchDarkly publishes, and what it doesn't

Read from its docs on 2026-11-21, for the next person who compares:

- Regressions are checked about every 10 seconds on the absolute difference, new minus old. A regression is a confidence interval entirely on the worse side. At least 10 contexts per variation.
- The largest step is 50%, with equal traffic on both variations.
- A sample ratio mismatch rolls back whether or not auto-rollback is on. So does a step that never reaches the minimum sample.
- A release that makes no progress for 21 days expires.
- An environment's release starts on a flag evaluation, a deploy signal, a person, or the previous environment finishing.
- Not published: step sizes and durations, the significance level, the exact bound, the sample ratio test.

## Not built

See [limits.md](limits.md#not-built).
