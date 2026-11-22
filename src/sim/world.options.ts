import { DEFAULT_EVALUATORS } from "./evaluators.js";
import { DEFAULT_POPULATION } from "./population.js";
import type { EffectName } from "./effects.js";
import type { EvaluatorOptions } from "./evaluators.js";
import type { PipelineOptions } from "./pipeline.js";
import type { PopulationOptions } from "./population.js";
import type { RolloutPlan } from "../plan.js";
import type { WatermarkRule } from "./source.js";

/**
 * Everything that can be chosen about a simulated production, and the defaults: a busy afternoon, most
 * events a few seconds late and a few an hour late, one event in a hundred delivered twice, and a metric
 * source that says "complete up to a minute ago".
 */

interface LagOptions {
  /** The median delay between an event and the pipeline getting it, and how long its tail is, by client. */
  readonly serverMedianMs: number;
  readonly clientMedianMs: number;
  readonly sigma: number;
  /** Share of phone events sent only when the phone is back online, up to `offlineUpToMs` later. */
  readonly offlineShare: number;
  readonly offlineUpToMs: number;
}

interface WorldOptions {
  readonly seed: number;
  readonly plan: RolloutPlan;
  readonly effect: EffectName;
  /** Visits a minute at the busiest hour. */
  readonly peakPerMinute: number;
  /** Traffic at the quietest hour (four in the morning), as a share of the peak. */
  readonly nightShare: number;
  /** The hour of the day the rollout starts at. */
  readonly startHour: number;
  readonly population: PopulationOptions;
  readonly evaluators: EvaluatorOptions;
  readonly pipeline: PipelineOptions;
  readonly watermark: WatermarkRule;
  readonly lag: LagOptions;
  /** Chance an event is delivered twice. */
  readonly duplicateChance: number;
  readonly checksRevision: boolean;
  /** A request's chance of failing for a typical person on the old behaviour. */
  readonly baseErrorChance: number;
  readonly baseConversion: number;
}

const START = 1_700_000_000_000,
  HOUR = 3_600_000,
  DEFAULT_LAG: LagOptions = { clientMedianMs: 8000, offlineShare: 0.02, offlineUpToMs: 5_400_000, serverMedianMs: 2500, sigma: 1.1 },
  DEFAULT_WORLD: Omit<WorldOptions, "plan" | "seed"> = {
    baseConversion: 0.08,
    baseErrorChance: 0.004,
    checksRevision: true,
    duplicateChance: 0.01,
    effect: "healthy",
    evaluators: DEFAULT_EVALUATORS,
    lag: DEFAULT_LAG,
    nightShare: 0.08,
    peakPerMinute: 400,
    pipeline: { allowanceMs: 60_000, dedupeEveryMs: 120_000 },
    population: DEFAULT_POPULATION,
    startHour: 14,
    watermark: "lagged",
  };

/** The instant a world starts at: its start hour on the simulation's first day. */
function startOf(options: WorldOptions): number {
  return START + options.startHour * HOUR;
}

export type { LagOptions, WorldOptions };
export { DEFAULT_LAG, DEFAULT_WORLD, HOUR, START, startOf };
