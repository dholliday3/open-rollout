import { backToStep, pauseFor, percent } from "./transitions.js";
import { exposesMore, sameAllocation } from "./allocation.js";
import { isDone, withEvent } from "./record.js";
import type { Allocation } from "./allocation.js";
import type { FlagReading } from "./ports.js";
import type { RolloutRecord } from "./record.js";
import { isStepOf } from "./plan.js";

/** What a rollback has done once the provider serves the flag off: an app holding an older copy, such as a phone, still runs the new behaviour until it next fetches the flag. */
const ROLLED_BACK = "Rolled back: the flag provider serves the flag off for everybody. An app holding an older copy of the flag, such as a phone, switches when it next fetches it.";

function finish(record: RolloutRecord, now: number): RolloutRecord {
  const undone = record.phase === "rolling_back",
    done: RolloutRecord = { ...record, clock: now, confirmedAt: now, confirmedEpoch: record.epoch, correctingDrift: false, phase: undone ? "rolled_back" : "released" };
  return withEvent(done, { at: now, detail: undone ? ROLLED_BACK : "Released: the flag is on for everybody.", type: undone ? "rolled_back" : "released" });
}

function afterRollback(record: RolloutRecord, actual: Allocation, now: number): RolloutRecord {
  if (actual.treatment === 0) {
    return record;
  }
  const again: RolloutRecord = { ...record, clock: now, confirmedAt: null, phase: "rolling_back" };
  return withEvent(again, { at: now, detail: "The flag was turned back on after the rollback. Turning it off again.", type: "drift_corrected" });
}

/**
 * True when a flag that should serve everybody shows a stalled worker's late write: equal shares of one of
 * this rollout's own steps, on a provider that can't refuse a stale write. On a provider that can, a late
 * write never lands, so the same shares are a person's doing.
 */
function isLateWrite(record: RolloutRecord, observation: { flag: FlagReading | null; staleWritesRefused: boolean }): boolean {
  return !observation.staleWritesRefused && observation.flag !== null && isStepOf(record.plan, observation.flag.allocation);
}

/**
 * A released flag that no longer serves everybody. A stalled worker's late write is written over again.
 * Anything else is a person, and a person who lowers a flag is left alone. Either way it is reported once.
 */
function afterRelease(record: RolloutRecord, seen: { flag: FlagReading; staleWritesRefused: boolean }, now: number): RolloutRecord {
  const actual = seen.flag.allocation;
  if (sameAllocation(actual, record.desired)) {
    // Put right: watch it for the settle time again, from here.
    return record.correctingDrift ? { ...record, clock: now, confirmedAt: now, correctingDrift: false } : record;
  }
  if (record.correctingDrift) {
    return record;
  }
  const noted: RolloutRecord = { ...record, clock: now, correctingDrift: true };
  if (isLateWrite(record, seen)) {
    return withEvent(noted, { at: now, detail: "An earlier step was written back over the release. Releasing again.", type: "drift_corrected" });
  }
  return withEvent(noted, { at: now, detail: "Someone changed the flag after the release. Leaving it as they set it.", type: "external_change" });
}

/** A finished rollout is watched until its settle time, so a write that arrives late from a stalled worker is undone. */
function settle(record: RolloutRecord, observation: { flag: FlagReading; staleWritesRefused: boolean }, now: number): RolloutRecord {
  const seen = record.phase === "rolled_back" ? afterRollback(record, observation.flag.allocation, now) : afterRelease(record, observation, now);
  if (isDone(seen) && now >= (seen.confirmedAt ?? now) + seen.plan.limits.settleMs) {
    return { ...seen, clock: now, settled: true };
  }
  return seen;
}

/** The flag serves what the record wants: the first time that is seen for an epoch, the step's watch starts. */
function confirm(record: RolloutRecord, now: number): RolloutRecord {
  if (record.confirmedEpoch === record.epoch) {
    // Back in force after someone else's change: the step wasn't being served in between, so its watch starts again.
    return record.correctingDrift ? { ...record, clock: now, confirmedAt: now, correctingDrift: false, freshBaseline: null } : record;
  }
  const confirmed: RolloutRecord = {
    ...record,
    clock: now,
    confirmedAt: now,
    confirmedEpoch: record.epoch,
    correctingDrift: false,
    exposedSince: record.exposedSince ?? (record.desired.treatment > 0 ? now : null),
    freshBaseline: null,
    lastProgressAt: now,
  };
  return record.phase === "ramping" ? withEvent(confirmed, { at: now, detail: `${percent(record.desired.treatment)} of traffic is on the new behaviour.`, type: "step_started" }) : confirmed;
}

/**
 * True when the mismatch is someone else's doing and not just a write of ours that has yet to land.
 * - The record's wish had already been seen in force: someone changed it since.
 * - The flag is still at the revision it had when the write was sent: the write hasn't landed. Not foreign.
 * - The flag is one revision on and serves what it did when the write was sent: one edit that left the
 *   shares alone (a description, a tag). The write is still owed. Not foreign.
 * - Anything else: someone changed the flag after we looked. Two revisions on with the old shares may be
 *   our write landing and a person undoing it, so that is theirs too.
 */
function isForeign(record: RolloutRecord, flag: FlagReading): boolean {
  const { attempt } = record;
  if (record.confirmedEpoch === record.epoch) {
    return true;
  }
  if (attempt === null || attempt.epoch !== record.epoch || attempt.base === null || flag.revision <= attempt.base) {
    return false;
  }
  return !(flag.revision === attempt.base + 1 && attempt.over !== null && sameAllocation(flag.allocation, attempt.over));
}

/**
 * Someone else changed the flag. Less exposure is a person pulling back, so the rollout pauses and leaves
 * it. More exposure is never left standing: the next write brings it back.
 */
function drifted(record: RolloutRecord, actual: Allocation, now: number): RolloutRecord {
  if (!exposesMore(actual, record.desired) && actual.treatment !== record.desired.treatment) {
    return pauseFor(record, { detail: "Someone lowered the flag by hand, so the rollout is holding.", reason: "external_change" }, now);
  }
  if (record.correctingDrift) {
    return record;
  }
  return withEvent({ ...record, clock: now, correctingDrift: true }, { at: now, detail: "The flag was changed outside the rollout. Setting it back.", type: "drift_corrected" });
}

/**
 * A release whose write was sent a while ago and never went through (the flag is as it was) goes back to
 * its gate. The guardrails watch the step again and the release is decided afresh, so a provider that
 * refuses writes for an hour can't deliver a release nobody has checked since. A release a person forced
 * just keeps trying.
 */
function retreat(record: RolloutRecord, flag: FlagReading | null, now: number): RolloutRecord {
  const { attempt } = record;
  if (record.phase !== "releasing" || record.outcome?.reason === "forced" || flag === null || attempt === null) {
    return record;
  }
  const waited = attempt.epoch === record.epoch && attempt.base === flag.revision && now - attempt.at >= record.plan.limits.propagationMs,
    back = backToStep(record);
  if (!waited || !sameAllocation(flag.allocation, back.desired)) {
    return record;
  }
  return { ...back, clock: now, confirmedAt: now, confirmedEpoch: back.epoch, pendingGate: "release", phase: "awaiting_approval" };
}

/** A rollout still under way against a flag that was read: finish, confirm, or notice someone else's change. */
function square(record: RolloutRecord, flag: FlagReading, now: number): RolloutRecord {
  const inForce = sameAllocation(flag.allocation, record.desired);
  if (record.phase === "rolling_back") {
    return inForce ? finish(record, now) : record;
  }
  if (inForce) {
    return record.phase === "releasing" ? finish(record, now) : confirm(record, now);
  }
  return isForeign(record, flag) ? drifted(record, flag.allocation, now) : record;
}

/** Squares the record with what the flag really serves: confirms a step, finishes a rollback or a release, or notices someone else's change. */
function reconcile(record: RolloutRecord, observation: { flag: FlagReading | null; staleWritesRefused: boolean }, now: number): RolloutRecord {
  const { flag, staleWritesRefused } = observation;
  if (flag === null) {
    return record;
  }
  return isDone(record) ? settle(record, { flag, staleWritesRefused }, now) : square(record, flag, now);
}

export { isLateWrite, reconcile, retreat };
