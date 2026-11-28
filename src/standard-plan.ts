import type { Guardrail, Limits, RolloutPlan, Step } from "./plan.js";
import { DEFAULT_LIMITS } from "./plan.js";
import { HALF_SHARE } from "./allocation.js";
import { timeForUnits } from "./traffic.js";

/** How much could go wrong; a riskier change gets smaller first steps, longer watches and a person at the end. */
type Risk = "low" | "medium" | "high";

/** Fields to change, each left out (or undefined) to keep the standard value. */
type Overrides<Shape> = { readonly [Key in keyof Shape]?: Shape[Key] | undefined };

/** What to change on a standard plan, after `sourceLagMs` has been allowed for. */
interface PlanOverrides extends Overrides<Pick<RolloutPlan, "onInsufficientData" | "onMetricsOutage" | "onSampleRatioMismatch" | "requiresApprovalToRelease">> {
  /**
   * Set on every step of the ladder, such as fewer `minFreshUnits` and longer steps for a product with few
   * accounts. A step given a `minDurationMs` and no `maxDurationMs` waits the standard multiple of it, plus the lag.
   */
  readonly everyStep?: Overrides<Omit<Step, "treatmentShare">> | undefined;
  /** Limits by name. The source's lag is `PlanRequest.sourceLagMs`, so the deadlines move with it. */
  readonly limits?: Overrides<Omit<Limits, "sourceLagMs">> | undefined;
}

interface PlanRequest {
  readonly flagKey: string;
  readonly guardrails: readonly Guardrail[];
  readonly risk: Risk;
  /**
   * How far behind the clock the metric source's data runs. The staleness limit and every step's deadline
   * move out by it, so a step still gets its whole watch, on complete data, before it gives up. Leave it out
   * for a source that is a few minutes behind at most.
   */
  readonly sourceLagMs?: number | undefined;
  /**
   * New units an hour, across the whole product, that evaluate the flag. Each step then lasts at least as
   * long as its units take to arrive on average, so a fix on a quiet path gets steps of hours or days
   * instead of minutes that pause for too little data. `forecast` says how long that comes to, and
   * `planProblems` refuses a step longer than the rollout may sit without progress.
   */
  readonly unitsPerHour?: number | undefined;
  readonly overrides?: PlanOverrides | undefined;
}

const MS_PER_MINUTE = 60_000,
  /** How much longer than its minimum a step may wait for traffic. */
  PATIENCE = 6,
  DEFAULT_FRESH_UNITS = 50,
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

/** `base` with every field `changes` sets. A field left out, or set to undefined, keeps its value. */
function overridden<Shape extends object>(base: Shape, changes: Overrides<Shape> | undefined): Shape {
  const set = Object.entries(changes ?? {}).filter(([, value]) => value !== undefined);
  return { ...base, ...Object.fromEntries(set) };
}

/** The rung's own watch, or longer when the traffic takes longer than that to bring the step its units. */
function watchFor(rung: { share: number; minutes: number }, units: number, unitsPerHour: number | undefined): number {
  const ladder = rung.minutes * MS_PER_MINUTE;
  if (unitsPerHour === undefined || !(unitsPerHour > 0) || !Number.isFinite(unitsPerHour)) {
    return ladder;
  }
  return Math.max(ladder, Math.ceil(timeForUnits(units, rung.share, unitsPerHour) / MS_PER_MINUTE) * MS_PER_MINUTE);
}

function ladderStep(rung: { share: number; minutes: number }, sizing: { lag: number; unitsPerHour: number | undefined }, every: Overrides<Omit<Step, "treatmentShare">> | undefined): Step {
  const minFreshUnits = every?.minFreshUnits ?? DEFAULT_FRESH_UNITS,
    minDurationMs = every?.minDurationMs ?? watchFor(rung, minFreshUnits, sizing.unitsPerHour);
  return {
    maxDurationMs: every?.maxDurationMs ?? minDurationMs * PATIENCE + sizing.lag,
    minDurationMs,
    minFreshUnits,
    requiresApproval: every?.requiresApproval ?? false,
    treatmentShare: rung.share,
  };
}

/**
 * A plan with the usual ladder for a change of this risk. A source that runs `sourceLagMs` behind gets that
 * much more time before its metrics are stale and before each step gives up; traffic of `unitsPerHour`
 * stretches each step to the time its units take to arrive; `overrides` change the rest.
 */
function standardPlan(request: PlanRequest): RolloutPlan {
  const lag = request.sourceLagMs ?? 0,
    { everyStep, limits, ...policies } = request.overrides ?? {},
    standard: RolloutPlan = {
      flagKey: request.flagKey,
      guardrails: request.guardrails,
      limits: overridden<Limits>({ ...DEFAULT_LIMITS, maxStalenessMs: DEFAULT_LIMITS.maxStalenessMs + lag, sourceLagMs: lag }, limits),
      // LaunchDarkly rolls back a step that never gets its sample. Here a quiet night would undo every rollout, so a person is asked instead.
      onInsufficientData: "pause",
      onMetricsOutage: "hold",
      onSampleRatioMismatch: "rollback",
      requiresApprovalToRelease: request.risk === "high",
      steps: LADDERS[request.risk].map((rung) => ladderStep(rung, { lag, unitsPerHour: request.unitsPerHour }, everyStep)),
    };
  return overridden(standard, policies);
}

export type { PlanOverrides, PlanRequest, Risk };
export { standardPlan };
