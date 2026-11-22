# Guarantees and failure semantics

What open-rollout promises, what each promise rests on, and what a runtime sees when something fails. The
simulation in `src/sim` attacks these claims; [evaluation.md](evaluation.md) has what it found, and
[limits.md](limits.md) has where they stop.

## Traffic model

An `Allocation` is two shares in basis points (1% = 100): `treatment` (new behaviour) and `control` (old
behaviour, measured). Whatever is left gets the old behaviour, unmeasured. A step always holds equal
treatment and control shares (10% each, then 50% each), so every hour of the day counts the same on both
arms and the arms should always be the same size. A traffic spike or a bad hour that hits everyone then
does not look like a regression. The release is `{ treatment: 10000, control: 0 }`; a rollback is
`{ treatment: 0, control: 0 }`.

With an off-the-shelf provider this is a multivariate flag with `control` and `treatment` variants split
50/50, and a rollout percentage of twice the step. Bucketing must be sticky, and the variant hash must not
depend on the rollout percentage.

## Lifecycle

`awaiting_approval → ramping (step 0..n) → releasing → released`, with `paused` reachable from any phase
before `released`, and `rolling_back → rolled_back` reachable from anywhere before `released`. A finished
rollout is watched for `settleMs` and then `settled`, after which ticks stop.

A step moves on only when all of these hold:

1. The flag has been seen serving the step.
2. The step has been watched for `propagationMs + minDurationMs`, on two clocks. On the metric source's
   clock: from `asOf` of the first snapshot taken after the flag was seen serving the step, until the
   `watermark` has passed that by the whole time. On the workers' clock: that long since the flag was seen
   serving the step. No stalled tick, ingestion lag, or one clock being wrong or put right can shorten it.
   It starts again if someone else changes the flag and the rollout has to put it back.
3. Each arm gained `minFreshUnits` new units during the step, counted from no lower than where the last
   step ended.
4. The metrics are fresh (`maxStalenessMs`), make sense (no missing metric, negative count, NaN, sum of
   squares that can't go with its total, or watermark after the snapshot was taken), give every guardrail
   a reading, and no guardrail has regressed.
5. Every guardrail with a `mustRuleOut` has a reading sharp enough to rule out a regression that large.
6. The next gate is approved, if the plan asks for approval.

An approval is permission, not evidence. It opens the gate on the next tick, and only if conditions 1 and
4 still hold then: the step may have passed its watch days before the yes arrived.

Guardrails are read on every tick from the moment the new behaviour is first sent to anyone, landed or
not, through every pause and every wait for approval, until the rollout is undone or its release is sent.
A release whose write never goes through goes back to its gate after `propagationMs`, so the step is
watched again.

## The seven promises

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

## What a runtime sees

- **`tick(id, now)` never throws.** It returns a `TickResult` whose `status` is one of:
  - `ticked`: it looked, decided, and wrote the flag if the decision called for it (`wrote`).
  - `lost_race`: another worker saved first. Its decision stands and this tick did nothing.
  - `settled` or `not_found`: there is nothing left to do for this id.
  - `failed`: the store couldn't be reached. Nothing was decided and the next tick starts over. A runtime
    that retries a step only when it throws should throw on `failed` itself.

  Reads, writes and notices that failed are listed in `problems` for logs. None of them stops the next
  tick trying again.
- **`tickAll(now)`** ticks every unsettled rollout. One rollout's failure is reported as `failed` and never
  hides another's tick. It does throw if the store can't list rollouts at all.
- **`command(id, command, now)`** answers `applied`, `duplicate` (already applied under this command id),
  `refused` (with `refusal`), `not_found`, or `busy` (it lost the save 20 times in a row). An applied
  command is followed by a tick, so a rollback doesn't wait for the scheduler.
- **Events** are saved to the record's outbox before they are sent, so a crash in between sends an event
  again with the same `key`. None is lost; the notifier drops repeats by key.
- **A forced release** (`release`) skips the checks that are left, the metric checks included.
- **A pause on the wire.** A step change whose flag write is already on the wire when a pause arrives still
  lands. One that was only decided waits for the resume.

## Ports

| Port | Calls | Contract |
|---|---|---|
| `FlagControl` | `read(flagKey)`, `write(flagKey, allocation, expectedRevision?)`, `refusesStaleWrites` | Whole-state reads and writes, never increments. `revision` is a whole number that goes up on every saved change to the flag, whatever was changed, and doesn't come down; `write` returns the revision it left the flag at. `refusesStaleWrites` says whether a write with a stale `expectedRevision` is refused. |
| `MetricSource` | `snapshot({ flagKey, since, guardrails })` | Running totals per arm since `since`, units counted by first exposure, plus two times on the source's own clock: `asOf`, when the snapshot was taken, and `watermark`, up to when the data is complete. |
| `RolloutStore` | `create`, `load`, `save(record, expectedVersion)`, `listUnsettled` | `save` is compare-and-set. `create` refuses a second unsettled rollout on one flag. |
| `Notifier` | `notify(event)` | May be called twice for one event; `event.key` is stable so the receiver can drop repeats. |

Everything the rollout knows about who changed the flag comes from revisions: a reading below one already
seen is a read that is behind and is ignored; a flag still at the revision it had when a write was sent
has not taken the write; a flag that has moved on and doesn't serve the step was changed by someone else.

### A Postgres store

The package ships an in-memory store only. In Postgres a store is one table:

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

`listUnsettled` is `SELECT id FROM rollouts WHERE NOT settled`. A plan that has been through a `jsonb`
column comes back with its keys reordered and without any key that was set to `undefined`; `start`
compares plans as JSON keeps them, so a retried start still finds its own rollout.
