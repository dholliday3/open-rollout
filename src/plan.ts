import { HALF_SHARE } from "./allocation";
import type { MetricKind } from "./stats";

/** Which way a metric gets worse. */
type Direction = "lower_is_better" | "higher_is_better";

/** One metric the rollout must not make worse. */
interface Guardrail {
  /** The name the metric source knows it by. */
  readonly metric: string;
  readonly kind: MetricKind;
  readonly direction: Direction;
  /** How much worse, in the metric's own units, is still fine. */
  readonly tolerance: number;
  /** A regression either undoes the rollout or stops it where it is for a person to decide. */
  readonly onRegression: "rollback" | "pause";
  /**
   * How large a regression must be ruled out before a step may pass, in the metric's own units. Without it
   * a step passes when nothing was detected, which on thin traffic is not the same as nothing being wrong.
   */
  readonly mustRuleOut?: number;
}

/** One stage of exposure, watched before the next. */
interface Step {
  /** Share on the new behaviour, in basis points. The same share again is held as its control. */
  readonly treatmentShare: number;
  /** The least time the step is watched, counted on the metric source's clock, not the wall's. */
  readonly minDurationMs: number;
  /** A step still short of units by this time ends as `onInsufficientData` says. */
  readonly maxDurationMs: number;
  /** New units each arm must gain during the step: time passing overnight is not evidence. */
  readonly minFreshUnits: number;
  /** A person must say yes before traffic moves to this step. */
  readonly requiresApproval: boolean;
}

interface Limits {
  /** Chance, over a whole rollout, that healthy code is called worse on any guardrail. */
  readonly alpha: number;
  /** Units per arm at which the guardrails should be sharpest. */
  readonly tuneAtUnits: number;
  /** Chance, over a whole rollout, that an even split is called uneven. */
  readonly sampleRatioAlpha: number;
  /** Units each arm needs before any guardrail is read. */
  readonly minUnitsToJudge: number;
  /** Metrics older than this are no evidence about now. */
  readonly maxStalenessMs: number;
  /** How long a rollout may hold with no usable metrics before `onMetricsOutage` applies. */
  readonly maxBlindMs: number;
  /** How long a flag change takes to reach every evaluator; a step's watch starts after it. */
  readonly propagationMs: number;
  /** A rollout that makes no progress for this long is undone. */
  readonly expireAfterIdleMs: number;
  /** How long a finished rollout is still watched, so a late write from a stalled worker gets put right. */
  readonly settleMs: number;
  /** Share of units seen on both arms above which the comparison is void. */
  readonly maxContaminatedShare: number;
}

interface RolloutPlan {
  readonly flagKey: string;
  readonly steps: readonly Step[];
  readonly guardrails: readonly Guardrail[];
  readonly requiresApprovalToRelease: boolean;
  readonly onInsufficientData: "rollback" | "pause";
  readonly onMetricsOutage: "hold" | "rollback";
  readonly onSampleRatioMismatch: "rollback" | "pause";
  readonly limits: Limits;
}

/** How much could go wrong; a riskier change gets smaller first steps, longer watches and a person at the end. */
type Risk = "low" | "medium" | "high";

interface PlanRequest {
  readonly flagKey: string;
  readonly guardrails: readonly Guardrail[];
  readonly risk: Risk;
}

const MS_PER_MINUTE = 60_000,
  /** How much longer than its minimum a step may wait for traffic. */
  PATIENCE = 6,
  DEFAULT_FRESH_UNITS = 50,
  KINDS: ReadonlySet<string> = new Set(["rate", "mean", "ratio"]),
  DIRECTIONS: ReadonlySet<string> = new Set(["lower_is_better", "higher_is_better"]),
  REACTIONS: ReadonlySet<string> = new Set(["rollback", "pause"]),
  OUTAGE_POLICIES: ReadonlySet<string> = new Set(["hold", "rollback"]),
  MAX_ERROR_RATE = 0.5,
  /** LaunchDarkly's release expiry. */
  EXPIRY_MS = 1_814_400_000,
  BLIND_MS = 900_000,
  STALE_MS = 300_000,
  SETTLE_MS = 600_000,
  DEFAULT_LIMITS: Limits = {
    alpha: 0.05,
    expireAfterIdleMs: EXPIRY_MS,
    maxBlindMs: BLIND_MS,
    maxContaminatedShare: 0.01,
    maxStalenessMs: STALE_MS,
    // LaunchDarkly's floor.
    minUnitsToJudge: 10,
    // Twice a server SDK's default 30-second poll.
    propagationMs: MS_PER_MINUTE,
    sampleRatioAlpha: 0.001,
    settleMs: SETTLE_MS,
    tuneAtUnits: 1000,
  },
  /** Shares in basis points and minutes watched, by risk. */
  LADDERS: Record<Risk, readonly { share: number; minutes: number }[]> = {
    high: [
      { minutes: 30, share: 100 },
      { minutes: 30, share: 500 },
      { minutes: 60, share: 1000 },
      { minutes: 120, share: 2500 },
      { minutes: 240, share: HALF_SHARE },
    ],
    low: [
      { minutes: 10, share: 1000 },
      { minutes: 10, share: HALF_SHARE },
    ],
    medium: [
      { minutes: 10, share: 100 },
      { minutes: 15, share: 1000 },
      { minutes: 15, share: 2500 },
      { minutes: 20, share: HALF_SHARE },
    ],
  };

/** True for a real number at or above `least`. NaN and Infinity are never amounts. */
function isAmount(value: number, least = 0): boolean {
  return Number.isFinite(value) && value >= least;
}

function stepProblems(step: Step, previousShare: number): string[] {
  const problems: string[] = [];
  if (!Number.isInteger(step.treatmentShare) || step.treatmentShare <= previousShare || step.treatmentShare > HALF_SHARE) {
    problems.push(`A step's share must be a whole number of basis points, above the step before it and at most ${HALF_SHARE} (half, so its control is the other half); got ${step.treatmentShare}.`);
  }
  if (!isAmount(step.minDurationMs, 1) || !isAmount(step.maxDurationMs, step.minDurationMs)) {
    problems.push("A step is watched for some time, and may not give up before that time.");
  }
  if (!isAmount(step.minFreshUnits)) {
    problems.push("A step can't ask for fewer than zero new units.");
  }
  return problems;
}

function stepsProblems(steps: readonly Step[]): string[] {
  if (steps.length === 0) {
    return ["A plan needs at least one step."];
  }
  return steps.flatMap((step, index) => stepProblems(step, steps[index - 1]?.treatmentShare ?? 0));
}

/** True when a guardrail is one of the kinds, directions and reactions the package knows. A plan can come from JSON. */
function isKnownGuardrail(guardrail: Guardrail): boolean {
  return KINDS.has(guardrail.kind) && DIRECTIONS.has(guardrail.direction) && REACTIONS.has(guardrail.onRegression);
}

function guardrailProblems(guardrails: readonly Guardrail[]): string[] {
  const names = guardrails.map((guardrail) => guardrail.metric),
    problems = guardrails.filter((guardrail) => !isAmount(guardrail.tolerance)).map((guardrail) => `The tolerance for ${guardrail.metric} can't be negative.`);
  if (guardrails.some((guardrail) => guardrail.mustRuleOut !== undefined && !(guardrail.mustRuleOut > guardrail.tolerance))) {
    problems.push("What a guardrail must rule out has to be more than what it tolerates.");
  }
  if (names.includes("")) {
    problems.push("A guardrail names its metric.");
  }
  if (!guardrails.every((guardrail) => isKnownGuardrail(guardrail))) {
    problems.push("A guardrail's kind is rate, mean or ratio; its direction is lower_is_better or higher_is_better; a regression rolls back or pauses.");
  }
  return new Set(names).size === names.length ? problems : [...problems, "Each metric can guard a rollout once."];
}

function isErrorRate(value: number): boolean {
  return value > 0 && value < MAX_ERROR_RATE;
}

function limitProblems(limits: Limits): string[] {
  const problems: string[] = [],
    times = [limits.maxStalenessMs, limits.maxBlindMs, limits.propagationMs, limits.expireAfterIdleMs, limits.settleMs];
  if (!isErrorRate(limits.alpha) || !isErrorRate(limits.sampleRatioAlpha)) {
    problems.push("An error rate must be above 0 and below 0.5.");
  }
  if (!isAmount(limits.tuneAtUnits, 1) || !isAmount(limits.minUnitsToJudge, 2)) {
    problems.push("Guardrails need a tuning point above zero and at least two units an arm.");
  }
  if (!times.every((time) => isAmount(time)) || !isAmount(limits.maxContaminatedShare) || limits.maxContaminatedShare > 1) {
    problems.push("A limit can't be negative or not a number, and a share can't be above 1.");
  }
  if (!isAmount(limits.expireAfterIdleMs, 1) || !isAmount(limits.maxStalenessMs, 1)) {
    problems.push("A rollout needs some time before it expires, and metrics some time before they are stale.");
  }
  return problems;
}

function policyProblems(plan: RolloutPlan): string[] {
  const known = REACTIONS.has(plan.onInsufficientData) && REACTIONS.has(plan.onSampleRatioMismatch) && OUTAGE_POLICIES.has(plan.onMetricsOutage);
  return known ? [] : ["A plan rolls back or pauses on too little data and on uneven arms, and holds or rolls back when the metrics are down."];
}

/** The step at an index, or undefined when there is none there (before the first step, or past the last). */
function stepAt(plan: RolloutPlan, index: number): Step | undefined {
  return index < 0 ? undefined : plan.steps.at(index);
}

/** True when an allocation is equal shares of one of the plan's own steps: the mark of a write this rollout once made. */
function isStepOf(plan: RolloutPlan, allocation: { control: number; treatment: number }): boolean {
  return allocation.control === allocation.treatment && plan.steps.some((step) => step.treatmentShare === allocation.treatment);
}

function sameValue(left: unknown, right: unknown): boolean {
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) {
    return left === right;
  }
  const entries = Object.entries(left),
    other = new Map<string, unknown>(Object.entries(right));
  return Array.isArray(left) === Array.isArray(right) && entries.length === other.size && entries.every(([key, value]) => other.has(key) && sameValue(value, other.get(key)));
}

/** True when two plans say the same thing, whatever order their keys are in. A plan that has been through a JSON column comes back reordered. */
function samePlan(left: RolloutPlan, right: RolloutPlan): boolean {
  return sameValue(left, right);
}

/** Everything wrong with a plan, in words a person can fix; empty when it can run. */
function planProblems(plan: RolloutPlan): string[] {
  const named = plan.flagKey === "" ? ["A plan names its flag."] : [];
  return [...named, ...stepsProblems(plan.steps), ...guardrailProblems(plan.guardrails), ...limitProblems(plan.limits), ...policyProblems(plan)];
}

/** A plan with the usual ladder for a change of this risk. */
function standardPlan(request: PlanRequest): RolloutPlan {
  return {
    flagKey: request.flagKey,
    guardrails: request.guardrails,
    limits: DEFAULT_LIMITS,
    // LaunchDarkly rolls back a step that never gets its sample. Here a quiet night would undo every rollout, so a person is asked instead.
    onInsufficientData: "pause",
    onMetricsOutage: "hold",
    onSampleRatioMismatch: "rollback",
    requiresApprovalToRelease: request.risk === "high",
    steps: LADDERS[request.risk].map((rung) => ({
      maxDurationMs: rung.minutes * MS_PER_MINUTE * PATIENCE,
      minDurationMs: rung.minutes * MS_PER_MINUTE,
      minFreshUnits: DEFAULT_FRESH_UNITS,
      requiresApproval: false,
      treatmentShare: rung.share,
    })),
  };
}

export type { Direction, Guardrail, Limits, PlanRequest, Risk, RolloutPlan, Step };
export { DEFAULT_LIMITS, isStepOf, planProblems, samePlan, standardPlan, stepAt };
