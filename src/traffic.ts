import { FULL_SHARE } from "./allocation.js";
import type { RolloutPlan } from "./plan.js";

/**
 * How long a plan takes on the traffic a flag really gets. A unit counts toward a step only once its request
 * evaluates the flag, so a fix on a path few people reach gathers its units slowly: at 100 units an hour, a
 * 1% step needs 25 hours to give each arm 50 new ones. This says so before the rollout starts, instead of
 * after a step has paused for too little data.
 */

/** One step at this much traffic. Times are from the moment the flag serves the step. */
interface StepForecast {
  readonly treatmentShare: number;
  /** How long each arm takes to gain the step's `minFreshUnits`, on average. */
  readonly unitsMs: number;
  /** When the step should pass: its watch and its units both in, plus propagation and the source's lag. */
  readonly expectedMs: number;
  /** When the step gives up for too little data. */
  readonly deadlineMs: number;
  /** True when the units come in, on average, before the deadline. */
  readonly finishes: boolean;
}

interface Forecast {
  /** New units an hour across the whole product, counted once each, that evaluate the flag. */
  readonly unitsPerHour: number;
  readonly steps: readonly StepForecast[];
  /** The whole rollout, step after step, when every step passes as expected. */
  readonly expectedMs: number;
  /** Why this plan won't get through on this traffic, in words a person can act on; empty when it will. */
  readonly problems: readonly string[];
}

const MS_PER_HOUR = 3_600_000,
  MS_PER_MINUTE = 60_000,
  PERCENT_PER_SHARE = 100,
  MS_PER_DAY = 86_400_000,
  /** Below this many hours a duration reads better in minutes, and below this many days in hours. */
  FEW_HOURS = 3,
  FEW_DAYS = 3;

/** A length of time in the unit a person would say it in: minutes, hours, or days. */
function duration(ms: number): string {
  if (!Number.isFinite(ms)) {
    return "forever";
  }
  if (ms < FEW_HOURS * MS_PER_HOUR) {
    return `${Math.ceil(ms / MS_PER_MINUTE)} minutes`;
  }
  return ms < FEW_DAYS * MS_PER_DAY ? `${(ms / MS_PER_HOUR).toFixed(1)} hours` : `${(ms / MS_PER_DAY).toFixed(1)} days`;
}

/** How long one arm at this share takes to gain this many new units. Forever when nobody arrives. */
function timeForUnits(units: number, share: number, unitsPerHour: number): number {
  const perHour = (unitsPerHour * share) / FULL_SHARE;
  if (units <= 0) {
    return 0;
  }
  return perHour > 0 ? (units / perHour) * MS_PER_HOUR : Number.POSITIVE_INFINITY;
}

function stepForecast(plan: RolloutPlan, index: number, unitsPerHour: number): StepForecast {
  const step = plan.steps[index],
    { propagationMs, sourceLagMs = 0 } = plan.limits,
    unitsMs = timeForUnits(step.minFreshUnits, step.treatmentShare, unitsPerHour),
    deadlineMs = step.maxDurationMs + propagationMs;
  return { deadlineMs, expectedMs: Math.max(step.minDurationMs, unitsMs) + propagationMs + sourceLagMs, finishes: unitsMs <= step.maxDurationMs, treatmentShare: step.treatmentShare, unitsMs };
}

function problemOf(plan: RolloutPlan, expected: StepForecast, index: number): string[] {
  if (expected.finishes) {
    return [];
  }
  const { minFreshUnits } = plan.steps[index];
  return [`Step ${index + 1} (${expected.treatmentShare / PERCENT_PER_SHARE}% an arm) needs about ${duration(expected.unitsMs)} to give each arm ${minFreshUnits} new units, but gives up after ${duration(expected.deadlineMs)}.`];
}

/**
 * Each step's time on this much traffic, and why the plan won't get through on it. A plan with no guardrails
 * waits out its time whatever the traffic. `unitsPerHour` is an average: a step that falls in a quiet night
 * takes longer, which each step's `maxDurationMs` is there to absorb.
 */
function forecast(plan: RolloutPlan, unitsPerHour: number): Forecast {
  const traffic = plan.guardrails.length === 0 ? Number.POSITIVE_INFINITY : Math.max(0, unitsPerHour),
    steps = plan.steps.map((_step, index) => stepForecast(plan, index, traffic)),
    nobody = Number.isFinite(unitsPerHour) && unitsPerHour > 0 ? [] : [`Nobody evaluates ${plan.flagKey}, so no step can gather units. Deploy the code that checks the flag first, or ship the change without one.`];
  return {
    expectedMs: steps.reduce((total, step) => total + step.expectedMs, 0),
    problems: plan.guardrails.length === 0 ? [] : [...nobody, ...(nobody.length > 0 ? [] : steps.flatMap((step, index) => problemOf(plan, step, index)))],
    steps,
    unitsPerHour,
  };
}

export type { Forecast, StepForecast };
export { duration, forecast, timeForUnits };
