import { HALF_SHARE } from "./allocation.js";
import type { MetricKind } from "./stats.js";
import { duration } from "./traffic.js";

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
  /**
   * Makes this guardrail a goal as well: before the release, the new behaviour must be shown better than the
   * old by more than this, in the metric's own units, with the whole interval past it on the better side.
   * For a bug fix, the bug's own error, so a fix that changed nothing is not released as one that worked. 0
   * asks only that it is better. The call has its own error budget, `limits.goalAlpha`.
   */
  readonly mustImproveBy?: number;
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
  /**
   * Chance, over a whole rollout, that a change which does nothing is called better on any goal (a guardrail
   * with `mustImproveBy`). Left out, 0.05.
   */
  readonly goalAlpha?: number;
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
  /**
   * How far behind the clock the metric source's data runs, such as a warehouse loaded every hour. A step
   * can only pass once its whole watch is in that data, so `planProblems` checks that `maxStalenessMs` and
   * every step's `maxDurationMs` leave room for it; `standardPlan({ sourceLagMs })` sizes both. Left out, 0.
   */
  readonly sourceLagMs?: number;
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

const MS_PER_MINUTE = 60_000,
  KINDS: ReadonlySet<string> = new Set(["rate", "mean", "ratio"]),
  DIRECTIONS: ReadonlySet<string> = new Set(["lower_is_better", "higher_is_better"]),
  REACTIONS: ReadonlySet<string> = new Set(["rollback", "pause"]),
  OUTAGE_POLICIES: ReadonlySet<string> = new Set(["hold", "rollback"]),
  MAX_ERROR_RATE = 0.5,
  /** LaunchDarkly's release expiry. */
  EXPIRY_MS = 1_814_400_000,
  DEFAULT_GOAL_ALPHA = 0.05,
  BLIND_MS = 900_000,
  STALE_MS = 300_000,
  SETTLE_MS = 600_000,
  DEFAULT_LIMITS: Limits = {
    alpha: 0.05,
    goalAlpha: DEFAULT_GOAL_ALPHA,
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
    sourceLagMs: 0,
    tuneAtUnits: 1000,
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
  if (guardrails.some((guardrail) => guardrail.mustImproveBy !== undefined && !isAmount(guardrail.mustImproveBy))) {
    problems.push("How much a goal must improve by can't be negative or not a number.");
  }
  if (names.includes("")) {
    problems.push("A guardrail names its metric.");
  }
  if (!guardrails.every((guardrail) => isKnownGuardrail(guardrail))) {
    problems.push("A guardrail's kind is rate, mean or ratio; its direction is lower_is_better or higher_is_better; a regression rolls back or pauses.");
  }
  return new Set(names).size === names.length ? problems : [...problems, "Each metric can guard a rollout once."];
}

/**
 * A step passes once the metrics have caught up with its whole watch, which takes the source's lag longer
 * than the watch itself. Metrics older than the staleness limit are never read, and a step past its
 * deadline gives up, so both have to leave room for the lag.
 */
function lagProblems(plan: RolloutPlan): string[] {
  const lag = plan.limits.sourceLagMs ?? 0;
  if (!isAmount(lag, 1) || plan.guardrails.length === 0) {
    return [];
  }
  const stale = plan.limits.maxStalenessMs > lag ? [] : [`Metrics that run ${duration(lag)} behind are always older than maxStalenessMs, so the rollout would never read them. Make it more than the lag.`];
  return [
    ...stale,
    ...plan.steps.flatMap((step, index) =>
      step.maxDurationMs - step.minDurationMs > lag ? [] : [`Step ${index + 1} gives up before metrics that run ${duration(lag)} behind can cover its watch. Give it a maxDurationMs more than the lag past its minDurationMs.`],
    ),
  ];
}

/** The goals' error budget; a plan made before goals existed has none written down. */
function goalAlphaOf(limits: Limits): number {
  return limits.goalAlpha ?? DEFAULT_GOAL_ALPHA;
}

/** The guardrails that are also goals: the new behaviour must be shown better on them before the release. */
function goalsOf(plan: RolloutPlan): Guardrail[] {
  return plan.guardrails.filter((guardrail) => guardrail.mustImproveBy !== undefined);
}

function isErrorRate(value: number): boolean {
  return value > 0 && value < MAX_ERROR_RATE;
}

function limitProblems(limits: Limits): string[] {
  const problems: string[] = [],
    times = [limits.maxStalenessMs, limits.maxBlindMs, limits.propagationMs, limits.expireAfterIdleMs, limits.settleMs, limits.sourceLagMs ?? 0];
  if (!isErrorRate(limits.alpha) || !isErrorRate(limits.sampleRatioAlpha) || !isErrorRate(goalAlphaOf(limits))) {
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

/** A rollout that makes no progress for `expireAfterIdleMs` is undone, so a step that may wait longer than that for its units would be undone before it could give up. */
function expiryProblems(plan: RolloutPlan): string[] {
  const { expireAfterIdleMs, propagationMs } = plan.limits;
  // A limit or a deadline that isn't a time is already reported as one.
  if (!isAmount(expireAfterIdleMs, 1) || !isAmount(propagationMs)) {
    return [];
  }
  return plan.steps.flatMap((step, index) =>
    !isAmount(step.maxDurationMs) || step.maxDurationMs + propagationMs < expireAfterIdleMs ? [] : [`Step ${index + 1} may wait ${duration(step.maxDurationMs)} for its units, longer than a rollout may go without progress (expireAfterIdleMs, ${duration(expireAfterIdleMs)}). The path is too quiet for this plan: give the step fewer minFreshUnits, or ship the change without a flag.`],
  );
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

/** An object's entries as JSON keeps them: a key whose value is undefined is not written. */
function keptEntries(value: object): [string, unknown][] {
  return Object.entries(value).filter(([, entry]) => Array.isArray(value) || entry !== undefined);
}

function sameValue(left: unknown, right: unknown): boolean {
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) {
    return left === right;
  }
  const entries = keptEntries(left),
    other = new Map<string, unknown>(keptEntries(right));
  return Array.isArray(left) === Array.isArray(right) && entries.length === other.size && entries.every(([key, value]) => other.has(key) && sameValue(value, other.get(key)));
}

/**
 * True when two plans say the same thing, as JSON would keep them. A plan that has been through a JSON column
 * comes back with its keys reordered, and without any key that was set to undefined.
 */
function samePlan(left: RolloutPlan, right: RolloutPlan): boolean {
  return sameValue(left, right);
}

/** Everything wrong with a plan, in words a person can fix; empty when it can run. */
function planProblems(plan: RolloutPlan): string[] {
  const named = plan.flagKey === "" ? ["A plan names its flag."] : [];
  return [...named, ...stepsProblems(plan.steps), ...guardrailProblems(plan.guardrails), ...limitProblems(plan.limits), ...lagProblems(plan), ...expiryProblems(plan), ...policyProblems(plan)];
}

export type { Direction, Guardrail, Limits, RolloutPlan, Step };
export { DEFAULT_LIMITS, goalAlphaOf, goalsOf, isStepOf, planProblems, samePlan, stepAt };
