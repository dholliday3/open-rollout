import type { Finding, RolloutRecord } from "./record.js";
import { isLive, withEvent } from "./record.js";
import { pauseFor, rollBack } from "./transitions.js";
import type { Judgement } from "./judge.js";
import type { MetricSnapshot } from "./ports.js";
import type { Time } from "./observation.js";
import { judge } from "./judge.js";
import { usable } from "./observation.js";

function describeFinding(finding: Finding): string {
  return `${finding.metric} is ${finding.treatment} on the new behaviour against ${finding.control} on the old; the gap is at least ${Math.min(Math.abs(finding.difference.lower), Math.abs(finding.difference.upper))}.`;
}

/** A rollout that makes no progress for too long is undone: nobody is watching it any more. */
function expire(record: RolloutRecord, now: number): RolloutRecord {
  if (!isLive(record) || now - record.lastProgressAt <= record.plan.limits.expireAfterIdleMs) {
    return record;
  }
  return rollBack(record, { detail: "The rollout made no progress for too long, so it was undone.", reason: "expired" }, now);
}

/** No usable metrics this tick: hold, and after long enough do what the plan says about flying blind. */
function blind(record: RolloutRecord, now: number): RolloutRecord {
  if (record.blindSince === null) {
    return { ...record, blindSince: now, clock: now };
  }
  if (now - record.blindSince <= record.plan.limits.maxBlindMs || record.outageReported) {
    return record;
  }
  const detail = "The metrics have been missing or stale for too long to watch this rollout.";
  if (record.plan.onMetricsOutage === "rollback") {
    return rollBack(record, { detail, reason: "metrics_outage" }, now);
  }
  return withEvent({ ...record, clock: now, outageReported: true }, { at: now, detail: `${detail} Holding where it is.`, type: "metrics_outage" });
}

function sighted(record: RolloutRecord, now: number): RolloutRecord {
  if (record.blindSince === null) {
    return record;
  }
  const cleared: RolloutRecord = { ...record, blindSince: null, clock: now, outageReported: false };
  return record.outageReported ? withEvent(cleared, { at: now, detail: "The metrics are back.", type: "metrics_restored" }) : cleared;
}

function actOnMismatch(record: RolloutRecord, now: number): RolloutRecord {
  const why = { detail: "The two arms are not the same size, so they can't be compared. One arm is losing units before they are counted.", reason: "sample_ratio_mismatch" as const };
  return record.plan.onSampleRatioMismatch === "rollback" ? rollBack(record, why, now) : pauseFor(record, why, now);
}

function actOnRegression(record: RolloutRecord, judgement: Judgement, now: number): RolloutRecord {
  const undo = judgement.regressions.find((regression) => regression.guardrail.onRegression === "rollback"),
    first = judgement.regressions.at(0);
  if (undo !== undefined) {
    return rollBack(record, { detail: describeFinding(undo.finding), finding: undo.finding, reason: "regression" }, now);
  }
  return first === undefined ? record : pauseFor(record, { detail: describeFinding(first.finding), finding: first.finding, reason: "regression" }, now);
}

/** A ratio the new arm has broken is a regression with no number to show for it. */
function actOnBroken(record: RolloutRecord, judgement: Judgement, now: number): RolloutRecord {
  const lost = judgement.broken.find((guardrail) => guardrail.onRegression === "rollback") ?? judgement.broken.at(0);
  if (lost === undefined) {
    return actOnRegression(record, judgement, now);
  }
  const why = { detail: `${lost.metric} has events on the new behaviour and nothing to divide them by: the new behaviour fails before it is counted.`, reason: "regression" as const };
  return lost.onRegression === "rollback" ? rollBack(record, why, now) : pauseFor(record, why, now);
}

function act(record: RolloutRecord, judgement: Judgement, now: number): RolloutRecord {
  // First: units seen on both arms are left out of both, so the arms' sizes mean nothing either.
  if (judgement.contaminated) {
    return pauseFor(record, { detail: "Too many units saw both behaviours for the comparison to mean anything.", reason: "contaminated" }, now);
  }
  if (judgement.mismatched) {
    return actOnMismatch(record, now);
  }
  return actOnBroken(record, judgement, now);
}

/**
 * Reads the guardrails from the moment the new behaviour is first sent to anyone, through every pause and
 * every wait for approval, until the rollout is undone or its release is sent. Once a release is on its way
 * the arms stop being the same size, so there is nothing left to compare.
 *
 * Whether the metrics can be read at all is tracked from the start: a rollout that can't begin because its
 * metric source is down says so, as one that goes blind half way does.
 */
function guard(record: RolloutRecord, metrics: MetricSnapshot | null, time: Time): RolloutRecord {
  if (!isLive(record) || record.plan.guardrails.length === 0) {
    return record;
  }
  const snapshot = usable(record, metrics, time);
  if (snapshot === null) {
    return blind(record, time.now);
  }
  const seeing = sighted(record, time.now);
  return record.exposedSince === null ? seeing : act(seeing, judge(record.plan, snapshot), time.now);
}

export { expire, guard };
