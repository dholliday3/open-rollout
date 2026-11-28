import { NOBODY, sameAllocation } from "./allocation.js";
import type { Observation, Time } from "./observation.js";
import { expire, guard } from "./guard.js";
import { holdOf, noteHold } from "./hold.js";
import { isDone, withEvent } from "./record.js";
import { isLateWrite, reconcile, retreat } from "./reconcile.js";
import { keepWatching, progress, throughOpenGate } from "./progress.js";
import type { Allocation } from "./allocation.js";
import type { FlagReading } from "./ports.js";
import type { RolloutRecord } from "./record.js";
import { usable } from "./observation.js";

interface FlagWrite {
  readonly allocation: Allocation;
  readonly expectedRevision: number | undefined;
  /** What the flag served when the write was decided; null when it couldn't be read. */
  readonly over: Allocation | null;
}

/** What to save, and the one flag write to make once it is saved. */
interface Decision {
  readonly record: RolloutRecord;
  readonly write: FlagWrite | null;
}

/** A write that raises exposure and didn't go through is not tried again for this long, so workers ticking together send it once. */
const WRITE_RETRY_MS = 30_000,
  /** No replica is this far behind. A flag that reads below what was seen for this long is the flag as it now is. */
  BEHIND_TOO_LONG_MS = 300_000;

/**
 * The flag's revision came down and stayed down: the flag was deleted and made again, or a write was once
 * answered with a revision that was too high. Either way the old numbers mean nothing now, so the flag is
 * taken as it reads, and whatever it serves that the record doesn't want is someone else's doing.
 */
function startedOver(record: RolloutRecord, flag: FlagReading, now: number): RolloutRecord {
  const { attempt } = record,
    again: RolloutRecord = { ...record, attempt: attempt === null ? null : { ...attempt, base: flag.revision - 1, over: null }, behindSince: null, clock: now, seenRevision: flag.revision };
  return withEvent(again, { at: now, detail: `The flag's revision went back to ${flag.revision} and stayed there: the flag was made again, or a write was answered with the wrong revision. Taking the flag as it reads now.`, type: "external_change" });
}

/**
 * What this tick really knows about the flag. Revisions only go up, so a reading below one already seen
 * is a read that is behind (a replica, a cache): it is treated as no reading, and nothing is confirmed,
 * blamed on a person or written over because of it. A flag that stays below for longer than any replica
 * could be behind has started over.
 */
function sift(record: RolloutRecord, flag: FlagReading | null, now: number): { record: RolloutRecord; flag: FlagReading | null } {
  const seen = record.seenRevision;
  if (flag === null) {
    return { flag, record };
  }
  if (seen === null || flag.revision >= seen) {
    return { flag, record: seen === flag.revision && record.behindSince === null ? record : { ...record, behindSince: null, seenRevision: flag.revision } };
  }
  if (record.behindSince === null) {
    return { flag: null, record: { ...record, behindSince: now } };
  }
  return now - record.behindSince > BEHIND_TOO_LONG_MS ? { flag, record: startedOver(record, flag, now) } : { flag: null, record };
}

/**
 * A write, and the record that says it was sent. The record always changes with a write, so a write is
 * never made without first winning a save: two workers can't both send one decision.
 */
function attempted(record: RolloutRecord, flag: FlagReading | null, target: { allocation: Allocation; now: number }): Decision {
  const sent: RolloutRecord = {
    ...record,
    attempt: { at: target.now, base: flag?.revision ?? null, epoch: record.epoch, over: flag?.allocation ?? null },
    clock: target.now,
    // From here someone may be on the new behaviour, whether or not the write is ever seen to land.
    exposedSince: record.exposedSince ?? (target.allocation.treatment > 0 ? target.now : null),
  };
  return { record: sent, write: { allocation: target.allocation, expectedRevision: flag?.revision, over: flag?.allocation ?? null } };
}

/** True while a write for the current wish was sent too recently to send again. */
function isWaiting(record: RolloutRecord, now: number): boolean {
  const { attempt } = record;
  return attempt !== null && attempt.epoch === record.epoch && now - attempt.at < WRITE_RETRY_MS;
}

/** True when the metrics can't be read right now. A release a person forced is theirs to make blind. */
function isBlind(record: RolloutRecord, observation: Observation, time: Time): boolean {
  return record.plan.guardrails.length > 0 && record.outcome?.reason !== "forced" && usable(record, observation.metrics, time) === null;
}

/**
 * True when a write that would raise exposure must wait: a paused rollout never raises it, nothing raises
 * it while the metrics can't be read, and a write just sent is given time to land.
 */
function mustWait(record: RolloutRecord, flag: FlagReading, seen: { observation: Observation; time: Time }): boolean {
  if (record.desired.treatment <= flag.allocation.treatment) {
    return false;
  }
  return record.phase === "paused" || isBlind(record, seen.observation, seen.time) || isWaiting(record, seen.time.now) || holdOf(record, seen.observation) !== null;
}

/**
 * The one write this tick owes the flag, if any. It only ever sets the flag to what the record wants.
 * A rollback is written every tick until it holds, read or no read: turning a flag off blind is always safe.
 */
function owe(record: RolloutRecord, observation: Observation, time: Time): Decision {
  const { flag } = observation,
    nothing = { record, write: null };
  if (record.phase === "released" && !record.settled && isLateWrite(record, observation)) {
    // A stalled worker's old step, written back over the release.
    return attempted(record, flag, { allocation: record.desired, now: time.now });
  }
  if (record.settled || isDone(record)) {
    return nothing;
  }
  if (record.phase === "rolling_back") {
    return flag !== null && sameAllocation(flag.allocation, NOBODY) ? nothing : attempted(record, flag, { allocation: NOBODY, now: time.now });
  }
  if (flag === null || sameAllocation(flag.allocation, record.desired) || mustWait(record, flag, { observation, time })) {
    return nothing;
  }
  return attempted(record, flag, { allocation: record.desired, now: time.now });
}

/**
 * What to do next, from the record and one look at the world. Pure: no clock, no randomness, no I/O, so a
 * runtime can replay it, two workers reach the same answer, and every case can be tested without a world.
 */
function decide(record: RolloutRecord, observed: Observation, wallNow: number): Decision {
  if (record.settled) {
    return { record, write: null };
  }
  const time: Time = { now: Math.max(wallNow, record.clock), wall: wallNow },
    sifted = sift(record, observed.flag, time.now),
    observation: Observation = { ...observed, flag: sifted.flag },
    current = expire(retreat(sifted.record, observation.flag, time.now), time.now),
    // The flag first, so a step is seen in force before its guardrails are read; then the guardrails, so nothing moves on over a regression.
    guarded = guard(reconcile(current, observation, time.now), observation.metrics, time),
    hold = holdOf(guarded, observation),
    noted = noteHold(guarded, hold, time.now),
    // An incident that hits both arms stops everything moving forward; the guardrails above still act.
    progressed = hold === null ? progress(throughOpenGate(noted, observation, time), observation, time) : keepWatching(noted, observation, time);
  return owe(progressed, observation, time);
}

export type { Decision, FlagWrite };
export type { Observation } from "./observation.js";
export { decide };
