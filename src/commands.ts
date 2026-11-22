import type { Gate, RolloutRecord } from "./record.js";
import { gateName, pauseFor, release, rollBack } from "./transitions.js";
import { isDone, isLive, withCommand, withEvent } from "./record.js";

/**
 * What a person, or an agent acting for one, can tell a rollout to do. `id` names the command, so sending
 * it twice does it once. `by` is whoever asked, for the record.
 */
type Command =
  | { readonly id: string; readonly by: string; readonly type: "pause"; readonly note?: string | undefined }
  | { readonly id: string; readonly by: string; readonly type: "resume" }
  | { readonly id: string; readonly by: string; readonly type: "rollback"; readonly note?: string | undefined }
  | { readonly id: string; readonly by: string; readonly type: "release" }
  | { readonly id: string; readonly by: string; readonly type: "approve"; readonly gate: Gate };

interface CommandResult {
  /** The record to save. It changes even on a first refusal, which is remembered. */
  readonly record: RolloutRecord;
  /**
   * `duplicate` is a command this rollout already applied; `refused` is one that made no sense when it first
   * arrived. A command sent again gets the answer it got the first time, whatever has happened since.
   */
  readonly status: "applied" | "duplicate" | "refused";
  /** Why it was refused, in a sentence. */
  readonly refusal: string | null;
}

/** Pauses that say the evidence itself is in doubt; resuming past one starts the evidence again. */
const EVIDENCE_PAUSES = new Set(["regression", "sample_ratio_mismatch", "contaminated"]),
  NO_UNITS = { control: 0, treatment: 0 };

function pause(record: RolloutRecord, command: Command & { type: "pause" }, now: number): RolloutRecord | string {
  if (!isLive(record) || record.phase === "paused") {
    return "Only a rollout that is moving can be paused.";
  }
  return pauseFor(record, { detail: `Paused by ${command.by}${command.note === undefined ? "" : `: ${command.note}`}.`, reason: "manual" }, now);
}

/**
 * Carries on from a pause. The step is applied and watched again from scratch, and after a pause for a
 * regression the evidence starts again too: the person resuming has said the old reading is acceptable.
 */
function resume(record: RolloutRecord, command: Command, now: number): RolloutRecord | string {
  if (record.pause === null) {
    return "Only a paused rollout can be resumed.";
  }
  const restart = EVIDENCE_PAUSES.has(record.pause.reason),
    resumed: RolloutRecord = {
    ...record,
    clock: now,
    confirmedAt: null,
    epoch: record.epoch + 1,
    freshBaseline: null,
    lastProgressAt: now,
    monitoringSince: restart ? now : record.monitoringSince,
    pause: null,
    phase: record.pendingGate === null ? "ramping" : "awaiting_approval",
    unitsFloor: restart ? NO_UNITS : record.unitsFloor,
  };
  return withEvent(resumed, { at: now, detail: `Resumed by ${command.by}.`, type: "resumed" });
}

function undo(record: RolloutRecord, command: Command & { type: "rollback" }, now: number): RolloutRecord | string {
  if (isDone(record) || record.phase === "rolling_back") {
    return "This rollout is already finished or being rolled back.";
  }
  return rollBack(record, { detail: `Rolled back by ${command.by}${command.note === undefined ? "" : `: ${command.note}`}.`, reason: "manual" }, now);
}

function force(record: RolloutRecord, command: Command, now: number): RolloutRecord | string {
  if (!isLive(record)) {
    return "Only a rollout that is still in progress can be released.";
  }
  return release(record, { detail: `Released to everybody by ${command.by}, skipping the remaining steps.`, reason: "forced" }, now);
}

function isAhead(record: RolloutRecord, gate: Gate): boolean {
  return gate === "release" || (Number.isInteger(gate) && gate > record.stepIndex && gate < record.plan.steps.length);
}

/**
 * Records a yes. It moves nothing by itself: the next tick opens the gate, and only if the metrics still
 * say it is safe to. An approval is permission, not evidence.
 */
function approve(record: RolloutRecord, command: Command & { type: "approve" }, now: number): RolloutRecord | string {
  const { gate } = command;
  if (!isLive(record) || !isAhead(record, gate)) {
    return "There is nothing ahead of this rollout by that name to approve.";
  }
  if (record.approvedGates.includes(gate)) {
    return record;
  }
  return withEvent({ ...record, approvedGates: [...record.approvedGates, gate], clock: now, lastProgressAt: now }, { at: now, detail: `${command.by} approved ${gateName(record, gate)}.`, type: "approved" });
}

function run(record: RolloutRecord, command: Command, now: number): RolloutRecord | string {
  switch (command.type) {
    case "pause": {
      return pause(record, command, now);
    }
    case "resume": {
      return resume(record, command, now);
    }
    case "rollback": {
      return undo(record, command, now);
    }
    case "release": {
      return force(record, command, now);
    }
    default: {
      return approve(record, command, now);
    }
  }
}

/** What a command asks for, in a word: its type, and for an approval its gate. */
function askOf(command: Command): string {
  return command.type === "approve" ? `approve:${command.gate}` : command.type;
}

/** Applies one command to a record. Pure, like `decide`: the caller saves the result and the next tick acts on it. */
function applyCommand(record: RolloutRecord, command: Command, wallNow: number): CommandResult {
  // A retried call has the same id and asks the same thing. An id reused for a different ask must not swallow it: it might be a rollback.
  const ask = askOf(command),
    before = record.commands.find((entry) => entry.id === command.id && entry.ask === ask);
  if (before !== undefined) {
    return { record, refusal: before.refusal, status: before.refusal === null ? "duplicate" : "refused" };
  }
  const outcome = run(record, command, Math.max(wallNow, record.clock));
  if (typeof outcome === "string") {
    return { record: withCommand(record, { ask, id: command.id, refusal: outcome }), refusal: outcome, status: "refused" };
  }
  return { record: withCommand(outcome, { ask, id: command.id, refusal: null }), refusal: null, status: "applied" };
}

export type { Command, CommandResult };
export { applyCommand };
