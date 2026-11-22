import type { ArmPair, MetricSnapshot } from "./ports.js";
import type { ArmSample, Interval } from "./stats.js";
import type { Guardrail, RolloutPlan } from "./plan.js";
import { differenceInterval, estimateArms, isSampleRatioMismatch, sampleProblem } from "./stats.js";
import type { Finding } from "./record.js";

/** A guardrail that the new behaviour has made worse, with the reading that says so. */
interface Regression {
  readonly guardrail: Guardrail;
  readonly finding: Finding;
}

/** What the metrics say about a rollout at one look. */
interface Judgement {
  /** The arms' sizes can't have come from an even split, so nothing else here can be trusted. */
  readonly mismatched: boolean;
  /** Too many units were seen on both arms. */
  readonly contaminated: boolean;
  readonly regressions: readonly Regression[];
  /** Ratio guardrails whose events the new arm has, with nothing under the line to divide them by. */
  readonly broken: readonly Guardrail[];
  /** Every guardrail's reading, regressed or not, for people and agents to look at. */
  readonly findings: readonly Finding[];
}

function isWorse(guardrail: Guardrail, difference: Interval): boolean {
  return guardrail.direction === "lower_is_better" ? difference.lower > guardrail.tolerance : difference.upper < -guardrail.tolerance;
}

/** True when the reading is sharp enough to pass a step: any regression as large as the guardrail must rule out is outside it. */
function isConclusive(guardrail: Guardrail, difference: Interval): boolean {
  const { mustRuleOut } = guardrail;
  if (mustRuleOut === undefined) {
    return true;
  }
  return guardrail.direction === "lower_is_better" ? difference.upper < mustRuleOut : difference.lower > -mustRuleOut;
}

/** One guardrail's reading, or null while either arm has too little to say anything. */
function read(guardrail: Guardrail, arms: ArmPair<ArmSample> | undefined, plan: RolloutPlan): Finding | null {
  const estimates = arms === undefined ? null : estimateArms(guardrail.kind, arms);
  if (estimates === null || Math.min(estimates.control.units, estimates.treatment.units) < plan.limits.minUnitsToJudge) {
    return null;
  }
  const { control, treatment } = estimates,
    // Each guardrail gets an equal part of the plan's error rate, so more guardrails don't mean more false alarms.
    alpha = plan.limits.alpha / plan.guardrails.length,
    difference = differenceInterval(control, treatment, { alpha, tuneAtUnits: plan.limits.tuneAtUnits });
  return { conclusive: isConclusive(guardrail, difference), control: control.value, difference, metric: guardrail.metric, treatment: treatment.value, units: { control: control.units, treatment: treatment.units } };
}

/**
 * True when the new arm has a ratio's events and nothing to divide them by, while the old arm has both:
 * the new behaviour fails before what is under the line is ever counted. There is no ratio to read, and it
 * is the worst reading a ratio can have, so it is not waited out as too little traffic.
 */
function isBroken(guardrail: Guardrail, arms: ArmPair<ArmSample> | undefined, plan: RolloutPlan): boolean {
  if (guardrail.kind !== "ratio" || arms === undefined) {
    return false;
  }
  return arms.treatment.sum >= plan.limits.minUnitsToJudge && (arms.treatment.denominator?.sum ?? 0) === 0 && (arms.control.denominator?.sum ?? 0) > 0;
}

function isMismatched(snapshot: MetricSnapshot, plan: RolloutPlan): boolean {
  // No floor on units: the bound is already too wide to fire on a handful.
  return isSampleRatioMismatch(snapshot.exposed, { alpha: plan.limits.sampleRatioAlpha, tuneAtUnits: plan.limits.tuneAtUnits });
}

function isContaminated(snapshot: MetricSnapshot, plan: RolloutPlan): boolean {
  const seen = snapshot.exposed.control + snapshot.exposed.treatment + snapshot.contaminated;
  // A handful of merged identities among the first hundred people is noise, not a broken comparison.
  return snapshot.contaminated >= plan.limits.minUnitsToJudge && snapshot.contaminated / seen > plan.limits.maxContaminatedShare;
}

function isCount(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function metricProblem(guardrail: Guardrail, arms: ArmPair<ArmSample> | undefined): string | null {
  if (arms === undefined) {
    return `The metrics say nothing about ${guardrail.metric}.`;
  }
  const problem = sampleProblem(guardrail.kind, arms.control) ?? sampleProblem(guardrail.kind, arms.treatment);
  return problem === null ? null : `The numbers for ${guardrail.metric} can't be right: ${problem}.`;
}

/**
 * Why a snapshot can't be used, or null when it can. A source that answers with a missing metric, a
 * negative count or a NaN has not said the rollout is healthy; it has said nothing.
 */
function snapshotProblem(plan: RolloutPlan, snapshot: MetricSnapshot): string | null {
  const { asOf, contaminated, exposed, watermark } = snapshot;
  // A watermark after the snapshot was taken claims data that can't have arrived yet.
  if (!Number.isFinite(asOf) || !(watermark <= asOf) || !isCount(exposed.control) || !isCount(exposed.treatment) || !isCount(contaminated)) {
    return "The metrics' counts or watermark can't be right.";
  }
  return plan.guardrails.map((guardrail) => metricProblem(guardrail, snapshot.metrics[guardrail.metric])).find((problem) => problem !== null) ?? null;
}

/** Reads every guardrail off one snapshot. Pure: the same snapshot always gives the same judgement. */
function judge(plan: RolloutPlan, snapshot: MetricSnapshot): Judgement {
  const readings = plan.guardrails.map((guardrail) => ({ finding: read(guardrail, snapshot.metrics[guardrail.metric], plan), guardrail })),
    regressions: Regression[] = [],
    findings: Finding[] = [];
  for (const { finding, guardrail } of readings) {
    if (finding !== null) {
      findings.push(finding);
      if (isWorse(guardrail, finding.difference)) {
        regressions.push({ finding, guardrail });
      }
    }
  }
  const broken = plan.guardrails.filter((guardrail) => isBroken(guardrail, snapshot.metrics[guardrail.metric], plan));
  return { broken, contaminated: isContaminated(snapshot, plan), findings, mismatched: isMismatched(snapshot, plan), regressions };
}

export type { Judgement, Regression };
export { judge, snapshotProblem };
