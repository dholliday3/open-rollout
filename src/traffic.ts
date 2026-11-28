import { FULL_SHARE } from "./allocation.js";
import type { RolloutPlan } from "./plan.js";
import { duration } from "./duration.js";
import { planProblems } from "./plan.js";

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
  PERCENT_PER_SHARE = 100;


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
  const expectedMs = Math.max(step.minDurationMs, unitsMs) + propagationMs + sourceLagMs;
  // The units are counted only once the metrics have caught up with them, so the source's lag comes before the deadline too.
  return { deadlineMs, expectedMs, finishes: expectedMs <= deadlineMs, treatmentShare: step.treatmentShare, unitsMs };
}

function problemOf(plan: RolloutPlan, expected: StepForecast, index: number): string[] {
  if (expected.finishes) {
    return [];
  }
  const counted = (plan.limits.sourceLagMs ?? 0) > 0 ? " and see them in the metrics" : "";
  return [`Step ${index + 1} (${expected.treatmentShare / PERCENT_PER_SHARE}% an arm) needs about ${duration(expected.expectedMs)} to give each arm ${plan.steps[index].minFreshUnits} new units${counted}, but gives up after ${duration(expected.deadlineMs)}.`];
}

/** Why no step can gather units on this traffic, or nothing. */
function nobodyProblems(plan: RolloutPlan, unitsPerHour: number): string[] {
  if (plan.guardrails.length === 0 || (Number.isFinite(unitsPerHour) && unitsPerHour > 0)) {
    return [];
  }
  return [`Nobody evaluates ${plan.flagKey}, so no step can gather units. Deploy the code that checks the flag first, or ship the change without one.`];
}

/**
 * Each step's time on this much traffic, and why the plan won't get through on it: what `planProblems`
 * refuses, then each step that can't gather its units before it gives up. A plan with no guardrails waits
 * out its time whatever the traffic. `unitsPerHour` is an average: a step that falls in a quiet night takes
 * longer, which each step's `maxDurationMs` is there to absorb.
 */
function forecast(plan: RolloutPlan, unitsPerHour: number): Forecast {
  const traffic = plan.guardrails.length === 0 ? Number.POSITIVE_INFINITY : Math.max(0, unitsPerHour),
    steps = plan.steps.map((_step, index) => stepForecast(plan, index, traffic)),
    nobody = nobodyProblems(plan, unitsPerHour),
    late = plan.guardrails.length === 0 || nobody.length > 0 ? [] : steps.flatMap((step, index) => problemOf(plan, step, index));
  return { expectedMs: steps.reduce((total, step) => total + step.expectedMs, 0), problems: [...planProblems(plan), ...nobody, ...late], steps, unitsPerHour };
}

export type { Forecast, StepForecast };
export { forecast, timeForUnits };
