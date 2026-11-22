import type { Finding, RolloutRecord } from "./record";
import { gateName, percent } from "./transitions";
import type { Inspection } from "./controller";

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

function headlineOf(record: RolloutRecord): string {
  if (record.outcome !== null) {
    return record.outcome.detail;
  }
  if (record.pause !== null) {
    return `Paused: ${record.pause.detail}`;
  }
  if (record.pendingGate !== null && record.phase === "awaiting_approval") {
    return `Waiting for approval of ${gateName(record, record.pendingGate)}.`;
  }
  return record.confirmedAt === null ? "Applying the next step to the flag." : `Watching ${percent(record.desired.treatment)} of traffic on the new behaviour.`;
}

function waitingOn(record: RolloutRecord): string | null {
  if (record.phase === "awaiting_approval" && record.pendingGate !== null) {
    return `Approval of ${gateName(record, record.pendingGate)}.`;
  }
  return record.phase === "paused" ? "A person to resume it or roll it back." : null;
}

function readingOf(finding: Finding, worse: boolean): GuardrailReading {
  return {
    conclusive: finding.conclusive,
    gapBetween: [finding.difference.lower, finding.difference.upper],
    metric: finding.metric,
    onNewBehaviour: finding.treatment,
    onOldBehaviour: finding.control,
    unitsPerArm: [finding.units.control, finding.units.treatment],
    worse,
  };
}

/** A rollout as an agent should describe it. Pure: built from one inspection. */
function summarize(inspection: Inspection): RolloutSummary {
  const { judgement, record } = inspection,
    regressed = new Set((judgement?.regressions ?? []).map((regression) => regression.finding.metric));
  return {
    flagKey: record.plan.flagKey,
    guardrails: (judgement?.findings ?? []).map((finding) => readingOf(finding, regressed.has(finding.metric))),
    headline: headlineOf(record),
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
