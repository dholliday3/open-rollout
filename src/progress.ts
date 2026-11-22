import type { Observation, Time } from "./observation.js";
import { enter, needsApproval, nextGate, pauseFor, proceedTo, rollBack } from "./transitions.js";
import { isInForce, usable } from "./observation.js";
import type { MetricSnapshot } from "./ports.js";
import type { RolloutRecord } from "./record.js";
import type { Step } from "./plan.js";
import { judge } from "./judge.js";
import { stepAt } from "./plan.js";

function giveUpIfLate(record: RolloutRecord, step: Step, now: number): RolloutRecord {
  if (now - (record.confirmedAt ?? now) <= step.maxDurationMs + record.plan.limits.propagationMs) {
    return record;
  }
  const why = { detail: "Too little traffic reached this step to judge it in the time allowed.", reason: "insufficient_data" as const };
  return record.plan.onInsufficientData === "rollback" ? rollBack(record, why, now) : pauseFor(record, why, now);
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

function watch(record: RolloutRecord, step: Step, seen: { snapshot: MetricSnapshot; now: number }): boolean {
  const base = record.freshBaseline,
    { now, snapshot } = seen;
  if (base === null || !isReadable(record, snapshot)) {
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
  const based = withBaseline(record, snapshot);
  return watch(based, step, { now: time.now, snapshot }) ? proceedTo({ ...based, unitsFloor: snapshot.exposed }, nextGate(based), time.now) : giveUpIfLate(based, step, time.now);
}

/**
 * True when it is safe to go through a gate right now. Before anyone is exposed, or with no guardrails,
 * there is nothing to read. After that the step must be in force and every guardrail readable on fresh
 * metrics: the step may have passed its watch days before the approval came.
 */
function evidenceHolds(record: RolloutRecord, observation: Observation, time: Time): boolean {
  if (record.desired.treatment === 0 || record.plan.guardrails.length === 0) {
    return true;
  }
  const snapshot = usable(record, observation.metrics, time);
  return snapshot !== null && isInForce(record, observation.flag) && isReadable(record, snapshot);
}

/** Goes through the gate a rollout is waiting at, once it has been approved and the evidence still holds. */
function throughOpenGate(record: RolloutRecord, observation: Observation, time: Time): RolloutRecord {
  const gate = record.pendingGate;
  if (record.phase !== "awaiting_approval" || gate === null || needsApproval(record, gate) || !evidenceHolds(record, observation, time)) {
    return record;
  }
  return enter(record, gate, time.now);
}

export { progress, throughOpenGate };
