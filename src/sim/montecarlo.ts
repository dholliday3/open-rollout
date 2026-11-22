import { DEFAULT_RUNTIME, runRollout } from "./driver.js";
import type { Guardrail, RolloutPlan } from "../plan.js";
import type { Outcome, Runtime } from "./driver.js";
import { DEFAULT_WORLD } from "./world.options.js";
import type { World } from "./world.js";
import type { WorldOptions } from "./world.options.js";
import { createWorld } from "./world.js";

/**
 * Many seeded rollouts of one scenario, and what share of them ended which way. A scenario is a world, a
 * plan and a runtime; run number `n` always uses seed `n`, so any single run can be replayed.
 */

interface Scenario {
  readonly name: string;
  readonly plan: RolloutPlan;
  readonly world: Partial<Omit<WorldOptions, "plan" | "seed">>;
  readonly runtime: Partial<Runtime>;
  /** Something to set up in the world before the rollout starts: a fault, a setting of the source. */
  readonly prepare?: (world: World) => void;
  /** Looks at the world once its rollout is over, before it is thrown away. */
  readonly inspect?: (world: World, seed: number) => void;
}

interface Share {
  readonly count: number;
  readonly of: number;
  readonly share: number;
  /** Wilson's 95% interval. */
  readonly low: number;
  readonly high: number;
}

interface Summary {
  readonly name: string;
  readonly runs: number;
  /** How many runs ended each way. */
  readonly endings: Readonly<Record<string, number>>;
  readonly outcomes: readonly Outcome[];
}

const Z95 = 1.96,
  HALF = 0.5,
  ERRORS: Guardrail = { direction: "lower_is_better", kind: "rate", metric: "errors", onRegression: "rollback", tolerance: 0 },
  ERROR_RATIO: Guardrail = { direction: "lower_is_better", kind: "ratio", metric: "error_ratio", onRegression: "rollback", tolerance: 0 },
  ERRORS_PER_UNIT: Guardrail = { direction: "lower_is_better", kind: "mean", metric: "errors_per_unit", onRegression: "rollback", tolerance: 0 },
  LATENCY: Guardrail = { direction: "lower_is_better", kind: "mean", metric: "latency", onRegression: "rollback", tolerance: 0 },
  LATENCY_PER_REQUEST: Guardrail = { direction: "lower_is_better", kind: "ratio", metric: "latency_per_request", onRegression: "rollback", tolerance: 0 },
  CONVERSION: Guardrail = { direction: "higher_is_better", kind: "rate", metric: "conversion", onRegression: "rollback", tolerance: 0 };

/** Wilson's interval for a share: honest near zero, where the plain one collapses. */
function shareOf(count: number, of: number): Share {
  const share = of === 0 ? 0 : count / of,
    spread = (Z95 * Z95) / Math.max(1, of),
    centre = (share + spread * HALF) / (1 + spread),
    radius = (Z95 * Math.sqrt((share * (1 - share)) / Math.max(1, of) + spread / (2 * 2 * Math.max(1, of)))) / (1 + spread);
  return { count, high: Math.min(1, centre + radius), low: Math.max(0, centre - radius), of, share };
}

async function runOne(scenario: Scenario, seed: number): Promise<Outcome> {
  const world = createWorld({ ...DEFAULT_WORLD, ...scenario.world, plan: scenario.plan, seed });
  scenario.prepare?.(world);
  const outcome = await runRollout(world, { ...DEFAULT_RUNTIME, ...scenario.runtime });
  scenario.inspect?.(world, seed);
  return outcome;
}

/** Runs seeds `from` to `from + runs - 1`, one after another. */
async function runMany(scenario: Scenario, runs: number, from = 1): Promise<Summary> {
  const outcomes: Outcome[] = [],
    endings: Record<string, number> = {};
  for (let seed = from; seed < from + runs; seed += 1) {
    // eslint-disable-next-line no-await-in-loop -- one world at a time keeps memory flat
    const outcome = await runOne(scenario, seed);
    outcomes.push(outcome);
    endings[outcome.ending] = (endings[outcome.ending] ?? 0) + 1;
  }
  return { endings, name: scenario.name, outcomes, runs };
}

function median(values: readonly number[]): number | null {
  const sorted = [...values];
  sorted.sort((left, right) => left - right);
  return sorted.length === 0 ? null : sorted[Math.floor(sorted.length / 2)];
}

export type { Scenario, Share, Summary };
export { CONVERSION, ERRORS, ERRORS_PER_UNIT, ERROR_RATIO, LATENCY, LATENCY_PER_REQUEST, median, runMany, runOne, shareOf };
