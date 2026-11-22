import { EVERYBODY, NOBODY, measuredStep } from "./allocation";
import type { Finding, Gate, PauseReason, RollbackReason, RolloutRecord } from "./record";
import { isDone, isLive, withEvent } from "./record";
import { stepAt } from "./plan";

interface Why<Reason> {
  readonly reason: Reason;
  readonly detail: string;
  readonly finding?: Finding;
}

const PERCENT_PER_SHARE = 100;

function percent(share: number): string {
  return `${share / PERCENT_PER_SHARE}%`;
}

/** The gate after the step traffic is on: the next step, or the release once the last step has passed. */
function nextGate(record: RolloutRecord): Gate {
  return record.stepIndex + 1 < record.plan.steps.length ? record.stepIndex + 1 : "release";
}

/** Starts undoing the rollout. From here every tick sets the flag to nobody until it is seen to hold. */
function rollBack(record: RolloutRecord, why: Why<RollbackReason>, now: number): RolloutRecord {
  if (record.phase === "rolling_back" || isDone(record)) {
    return record;
  }
  const undone: RolloutRecord = {
    ...record,
    clock: now,
    confirmedAt: null,
    desired: NOBODY,
    epoch: record.epoch + 1,
    freshBaseline: null,
    outcome: { ...why, at: now },
    pause: null,
    pendingGate: null,
    phase: "rolling_back",
  };
  return withEvent(undone, { at: now, detail: why.detail, finding: why.finding, type: "rolling_back" });
}

/** A release that is stopped before it lands goes back to the step the rollout had reached. */
function backToStep(record: RolloutRecord): RolloutRecord {
  const step = stepAt(record.plan, record.stepIndex);
  return { ...record, confirmedAt: null, desired: step === undefined ? NOBODY : measuredStep(step.treatmentShare), epoch: record.epoch + 1, outcome: null };
}

/**
 * Holds the rollout where it is. A rollout already paused keeps its first reason. A release that is paused
 * goes back to its step, so a resume watches that step again before anything is released.
 */
function pauseFor(record: RolloutRecord, why: Why<PauseReason>, now: number): RolloutRecord {
  if (record.phase === "paused" || !(isLive(record) || record.phase === "releasing")) {
    return record;
  }
  // A release that was stopped and is decided again later is a new release to the people who hear about it.
  const from: RolloutRecord = record.phase === "releasing" ? { ...backToStep(record), pendingGate: record.stepIndex < 0 ? 0 : null, releaseAnnounced: false } : record,
    held: RolloutRecord = { ...from, clock: now, pause: { detail: why.detail, reason: why.reason, since: now }, phase: "paused" };
  return withEvent(held, { at: now, detail: why.detail, finding: why.finding, type: "paused" });
}

function release(record: RolloutRecord, why: Why<"completed" | "forced">, now: number): RolloutRecord {
  const releasing: RolloutRecord = {
    ...record,
    clock: now,
    confirmedAt: null,
    desired: EVERYBODY,
    epoch: record.epoch + 1,
    freshBaseline: null,
    lastProgressAt: now,
    outcome: { ...why, at: now },
    pause: null,
    pendingGate: null,
    phase: "releasing",
    releaseAnnounced: true,
  };
  // A release whose write has to be sent again is the same release: people are told once.
  return record.releaseAnnounced ? releasing : withEvent(releasing, { at: now, detail: why.detail, type: "releasing" });
}

/** Moves traffic through a gate, whoever opened it. */
function enter(record: RolloutRecord, gate: Gate, now: number): RolloutRecord {
  if (gate === "release") {
    return release(record, { detail: "Every step passed. Releasing to everybody.", reason: "completed" }, now);
  }
  const step = stepAt(record.plan, gate);
  if (step === undefined) {
    return record;
  }
  return {
    ...record,
    clock: now,
    confirmedAt: null,
    desired: measuredStep(step.treatmentShare),
    epoch: record.epoch + 1,
    freshBaseline: null,
    lastProgressAt: now,
    pause: null,
    pendingGate: null,
    phase: "ramping",
    stepIndex: gate,
  };
}

function needsApproval(record: RolloutRecord, gate: Gate): boolean {
  const asked = gate === "release" ? record.plan.requiresApprovalToRelease : (stepAt(record.plan, gate)?.requiresApproval ?? false);
  return asked && !record.approvedGates.includes(gate);
}

function gateName(record: RolloutRecord, gate: Gate): string {
  return gate === "release" ? "the release to everybody" : `the step to ${percent(stepAt(record.plan, gate)?.treatmentShare ?? 0)}`;
}

/** Goes through a gate if nobody has to approve it, and waits at it otherwise. */
function proceedTo(record: RolloutRecord, gate: Gate, now: number): RolloutRecord {
  if (!needsApproval(record, gate)) {
    return enter(record, gate, now);
  }
  if (record.phase === "awaiting_approval" && record.pendingGate === gate) {
    return record;
  }
  const waiting: RolloutRecord = { ...record, clock: now, pendingGate: gate, phase: "awaiting_approval" };
  return withEvent(waiting, { at: now, detail: `Waiting for approval of ${gateName(record, gate)}.`, type: "awaiting_approval" });
}

export type { Why };
export { backToStep, enter, gateName, needsApproval, nextGate, pauseFor, percent, proceedTo, release, rollBack };
