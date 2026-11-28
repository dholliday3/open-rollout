import type { Finding, RolloutRecord } from "./record.js";
import { gateName, nextGate, percent } from "./transitions.js";
import type { Inspection } from "./controller.js";
import type { Judgement } from "./judge.js";

/** One guardrail as a person or an agent needs to read it. */
interface GuardrailReading {
  readonly metric: string;
  readonly onOldBehaviour: number;
  readonly onNewBehaviour: number;
  /** The gap (new minus old) is somewhere in this range, with the plan's confidence. */
  readonly gapBetween: readonly [number, number];
  readonly unitsPerArm: readonly [number, number];
  readonly worse: boolean;
  /** False while the reading is still too wide to pass a step: nothing was detected, and not enough was ruled out. */
  readonly conclusive: boolean;
  /** On a goal only: true once the new behaviour is shown better by enough. The release waits for every goal. */
  readonly improved?: boolean;
}

/** A rollout in plain words and numbers: what an agent reads to answer "how is the rollout going?". */
interface RolloutSummary {
  readonly id: string;
  readonly flagKey: string;
  readonly phase: RolloutRecord["phase"];
  /** One sentence on where it is and why. */
  readonly headline: string;
  readonly step: string;
  readonly onNewBehaviour: string;
  /** What the rollout needs from a person, if anything. */
  readonly waitingOn: string | null;
  readonly guardrails: readonly GuardrailReading[];
  readonly settled: boolean;
}

function stepOf(record: RolloutRecord): string {
  return record.stepIndex < 0 ? "not started" : `${record.stepIndex + 1} of ${record.plan.steps.length}`;
}

/** Why the rollout is stopped where it is, if it is: an outcome, a pause, or an incident's hold. */
function stoppedBy(record: RolloutRecord): string | null {
  if (record.outcome !== null) {
    return record.outcome.detail;
  }
  if (record.pause !== null) {
    return `Paused: ${record.pause.detail}`;
  }
  const hold = record.hold ?? null;
  return hold === null ? null : `Held: ${hold.detail} Nothing moves forward until it clears.`;
}

function headlineOf(record: RolloutRecord, judgement: Judgement | null): string {
  const stopped = stoppedBy(record);
  if (stopped !== null) {
    return stopped;
  }
  if (record.pendingGate !== null && record.phase === "awaiting_approval") {
    return `Waiting for approval of ${gateName(record, record.pendingGate)}.`;
  }
  if (record.confirmedAt === null) {
    return "Applying the next step to the flag.";
  }
  const watching = `Watching ${percent(record.desired.treatment)} of traffic on the new behaviour.`,
    unproven = nextGate(record) === "release" ? (judgement?.unproven ?? []) : [];
  return unproven.length === 0 ? watching : `${watching} The release waits until ${unproven.map((goal) => goal.metric).join(" and ")} is shown better.`;
}

function waitingOn(record: RolloutRecord): string | null {
  if (record.phase === "awaiting_approval" && record.pendingGate !== null) {
    return `Approval of ${gateName(record, record.pendingGate)}.`;
  }
  return record.phase === "paused" ? "A person to resume it or roll it back." : null;
}

function readingOf(finding: Finding, worse: boolean): GuardrailReading {
  const reading: GuardrailReading = {
    conclusive: finding.conclusive,
    gapBetween: [finding.difference.lower, finding.difference.upper],
    metric: finding.metric,
    onNewBehaviour: finding.treatment,
    onOldBehaviour: finding.control,
    unitsPerArm: [finding.units.control, finding.units.treatment],
    worse,
  };
  return finding.improved === undefined ? reading : { ...reading, improved: finding.improved };
}

/** A rollout as an agent should describe it. Pure: built from one inspection. */
function summarize(inspection: Inspection): RolloutSummary {
  const { judgement, record } = inspection,
    regressed = new Set((judgement?.regressions ?? []).map((regression) => regression.finding.metric));
  return {
    flagKey: record.plan.flagKey,
    guardrails: (judgement?.findings ?? []).map((finding) => readingOf(finding, regressed.has(finding.metric))),
    headline: headlineOf(record, judgement),
    id: record.id,
    onNewBehaviour: percent(record.desired.treatment),
    phase: record.phase,
    settled: record.settled,
    step: stepOf(record),
    waitingOn: waitingOn(record),
  };
}

export type { GuardrailReading, RolloutSummary };
export { summarize };
