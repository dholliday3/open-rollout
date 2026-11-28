import type { Guardrail, Step } from "./plan.js";
import type { Observation, Time } from "./observation.js";
import { enter, needsApproval, nextGate, pauseFor, proceedTo, rollBack } from "./transitions.js";
import { isInForce, usable } from "./observation.js";
import type { MetricSnapshot } from "./ports.js";
import type { RolloutRecord } from "./record.js";
import type { Why } from "./transitions.js";
import { judge } from "./judge.js";
import { stepAt } from "./plan.js";

const TOO_LITTLE = { detail: "Too little traffic reached this step to judge it in the time allowed.", reason: "insufficient_data" } as const;

function giveUpIfLate(record: RolloutRecord, step: Step, seen: { now: number; why: Why<"insufficient_data" | "unproven"> }): RolloutRecord {
  const { now, why } = seen;
  if (now - (record.confirmedAt ?? now) <= step.maxDurationMs + record.plan.limits.propagationMs) {
    return record;
  }
  return record.plan.onInsufficientData === "rollback" ? rollBack(record, why, now) : pauseFor(record, why, now);
}

/** Goals that keep the release waiting: only the step before the release asks, and a goal with no reading is not shown better. */
function unprovenGoals(record: RolloutRecord, snapshot: MetricSnapshot): Guardrail[] {
  return nextGate(record) === "release" ? [...judge(record.plan, snapshot).unproven] : [];
}

function unprovenWhy(record: RolloutRecord, snapshot: MetricSnapshot, goals: readonly Guardrail[]): Why<"unproven"> {
  const { findings } = judge(record.plan, snapshot),
    readings = goals.map((goal) => {
      const finding = findings.find((found) => found.metric === goal.metric);
      return finding === undefined ? `${goal.metric} has too little data to read` : `${goal.metric} is ${finding.treatment} on the new behaviour against ${finding.control} on the old`;
    });
  return { detail: `The change was not shown to make things better in the time allowed: ${readings.join("; ")}.`, reason: "unproven" };
}

/**
 * Notes where the step's watch begins: the units each arm has, and the source's own time, in the first
 * snapshot taken once the step has been seen in force. A tick reads the flag before it reads the metrics,
 * so that snapshot was taken after the flag served the step, whatever any worker's clock says, however
 * long a tick stalled, and however far behind the metrics were running.
 *
 * A source that shows fewer units than the last step ended with has lost some, and is no place to start
 * counting from.
 */
function withBaseline(record: RolloutRecord, snapshot: MetricSnapshot): RolloutRecord {
  const { asOf, exposed } = snapshot,
    floor = record.unitsFloor;
  if (record.freshBaseline !== null || exposed.control < floor.control || exposed.treatment < floor.treatment) {
    return record;
  }
  return { ...record, freshBaseline: { ...exposed, asOf } };
}

/** True when every guardrail has a reading sharp enough to pass on: a metric too thin to read, or to rule out what it must, has not passed. */
function isReadable(record: RolloutRecord, snapshot: MetricSnapshot): boolean {
  const { findings } = judge(record.plan, snapshot);
  return findings.length === record.plan.guardrails.length && findings.every((finding) => finding.conclusive);
}

/** True when the step has had its watch and its new units, whatever the guardrails read. */
function watchedLongEnough(record: RolloutRecord, step: Step, seen: { snapshot: MetricSnapshot; now: number }): boolean {
  const base = record.freshBaseline,
    { now, snapshot } = seen;
  if (base === null) {
    return false;
  }
  const fresh = Math.min(snapshot.exposed.control - base.control, snapshot.exposed.treatment - base.treatment),
    // Both ends on the metric source's own clock: the data must be complete up to this long after the watch began.
    onSource = snapshot.watermark - base.asOf,
    // Both ends on the workers' clock: a source whose clock is put right during the step can't cut the watch short.
    onWorkers = now - (record.confirmedAt ?? now),
    watched = Math.min(onSource, onWorkers) - record.plan.limits.propagationMs;
  return watched >= step.minDurationMs && fresh >= step.minFreshUnits;
}

function watch(record: RolloutRecord, step: Step, seen: { snapshot: MetricSnapshot; now: number }): boolean {
  return isReadable(record, seen.snapshot) && watchedLongEnough(record, step, seen);
}

/**
 * Why a step that ran out of time gives up. Before the release, a step that had its watch and its units but
 * not every goal shown better (a goal too thin to read included) is `unproven`; anything else is too little data.
 */
function whyLate(record: RolloutRecord, step: Step, seen: { snapshot: MetricSnapshot; now: number }): Why<"insufficient_data" | "unproven"> {
  const unproven = unprovenGoals(record, seen.snapshot);
  return unproven.length > 0 && watchedLongEnough(record, step, seen) ? unprovenWhy(record, seen.snapshot, unproven) : TOO_LITTLE;
}

/** A step whose watch is over goes on to the next gate, unless a goal not yet shown better keeps the release waiting. */
function passOrWait(record: RolloutRecord, step: Step, seen: { snapshot: MetricSnapshot; now: number }): RolloutRecord {
  const { now, snapshot } = seen,
    unproven = unprovenGoals(record, snapshot);
  if (unproven.length > 0) {
    return giveUpIfLate(record, step, { now, why: unprovenWhy(record, snapshot, unproven) });
  }
  return proceedTo({ ...record, unitsFloor: snapshot.exposed }, nextGate(record), now);
}

/** With no guardrails a rollout is a timed ramp: each step just waits out its time. */
function progressUnwatched(record: RolloutRecord, step: Step, now: number): RolloutRecord {
  const waited = now - (record.confirmedAt ?? now) - record.plan.limits.propagationMs;
  return waited >= step.minDurationMs ? proceedTo(record, nextGate(record), now) : record;
}

/** Moves on when the step in force has been watched long enough, on enough new units, with fresh metrics. */
function progress(record: RolloutRecord, observation: Observation, time: Time): RolloutRecord {
  const step = stepAt(record.plan, record.stepIndex);
  if (record.phase !== "ramping" || step === undefined || record.confirmedEpoch !== record.epoch || !isInForce(record, observation.flag)) {
    return record;
  }
  if (record.plan.guardrails.length === 0) {
    return progressUnwatched(record, step, time.now);
  }
  const snapshot = usable(record, observation.metrics, time);
  if (snapshot === null) {
    return record;
  }
  const based = withBaseline(record, snapshot),
    seen = { now: time.now, snapshot };
  return watch(based, step, seen) ? passOrWait(based, step, seen) : giveUpIfLate(based, step, { now: time.now, why: whyLate(based, step, seen) });
}

/**
 * While an incident holds the rollout nothing moves on, but the step in force is still watched: its watch
 * starts as it would, so the time held counts once the incident clears.
 */
function keepWatching(record: RolloutRecord, observation: Observation, time: Time): RolloutRecord {
  const snapshot = usable(record, observation.metrics, time);
  if (record.phase !== "ramping" || snapshot === null || record.confirmedEpoch !== record.epoch || !isInForce(record, observation.flag)) {
    return record;
  }
  return withBaseline(record, snapshot);
}

/**
 * True when it is safe to go through a gate right now. Before anyone is exposed, or with no guardrails,
 * there is nothing to read. After that the step must be in force and every guardrail readable on fresh
 * metrics, and before the release every goal still shown better: the step may have passed its watch days
 * before the approval came.
 */
function evidenceHolds(record: RolloutRecord, observation: Observation, time: Time): boolean {
  if (record.desired.treatment === 0 || record.plan.guardrails.length === 0) {
    return true;
  }
  const snapshot = usable(record, observation.metrics, time);
  return snapshot !== null && isInForce(record, observation.flag) && isReadable(record, snapshot) && unprovenGoals(record, snapshot).length === 0;
}

/** Goes through the gate a rollout is waiting at, once it has been approved and the evidence still holds. */
function throughOpenGate(record: RolloutRecord, observation: Observation, time: Time): RolloutRecord {
  const gate = record.pendingGate;
  if (record.phase !== "awaiting_approval" || gate === null || needsApproval(record, gate) || !evidenceHolds(record, observation, time)) {
    return record;
  }
  return enter(record, gate, time.now);
}

export { keepWatching, progress, throughOpenGate };
