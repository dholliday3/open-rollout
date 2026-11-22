import type { ArmPair, MetricSnapshot, MetricSource } from "../ports";
import type { ArmTotals, Totals } from "./units";
import type { ArmSample } from "../stats";
import type { Guardrail } from "../plan";
import type { Pipeline } from "./pipeline";

/**
 * The metric source the library reads: the pipeline's counts and a watermark. How the watermark is worked
 * out is the interesting part, because a real source never knows what is still on its way.
 * - `complete`: the truth. Nothing older than it is still in flight. One phone offline for an hour holds it back an hour.
 * - `lagged`: "everything up to a minute ago has arrived", as the PostHog adapter says. Wrong for the tail.
 * - `newest`: the newest event counted. Wrong whenever anything arrives out of order.
 */

type WatermarkRule = "complete" | "lagged" | "newest";

interface SourceFaults {
  /** Queries fail. */
  down: boolean;
  /** The watermark is reported this far ahead of what the rule says (the source's clock is fast, or it is in the wrong unit). */
  aheadMs: number;
  /** The watermark stays at this instant while counts go on. Null lets it move. */
  stuckAt: number | null;
}

interface SourceOptions {
  readonly pipeline: Pipeline;
  readonly now: () => number;
  readonly rule: WatermarkRule;
}

interface SimSource extends MetricSource {
  readonly faults: SourceFaults;
  readonly counts: { queries: number };
}

function rateOf(arm: ArmTotals, hits: number): ArmSample {
  return { sum: hits, units: arm.units };
}

/** One arm's totals for a metric. A name may carry a `#suffix`, so one metric can stand behind several guardrails. */
function sampleFor(metric: string, arm: ArmTotals): ArmSample | null {
  const [name] = metric.split("#");
  switch (name) {
    case "errors": {
      return rateOf(arm, arm.hadError);
    }
    case "conversion": {
      return rateOf(arm, arm.converted);
    }
    case "latency": {
      return { sum: arm.latency, sumSquares: arm.latencySquared, units: arm.units };
    }
    case "errors_per_unit": {
      return { sum: arm.errors, sumSquares: arm.errorsSquared, units: arm.units };
    }
    case "latency_per_request": {
      return { denominator: { crossSum: arm.latencyTimesRequests, sum: arm.requests, sumSquares: arm.requestsSquared }, sum: arm.latency, sumSquares: arm.latencySquared, units: arm.units };
    }
    case "error_ratio": {
      return { denominator: { crossSum: arm.errorsTimesRequests, sum: arm.requests, sumSquares: arm.requestsSquared }, sum: arm.errors, sumSquares: arm.errorsSquared, units: arm.units };
    }
    default: {
      return null;
    }
  }
}

function watermarkOf(options: SourceOptions): number {
  const { pipeline, rule } = options;
  if (rule === "complete") {
    return Math.min(pipeline.visibleUpTo(), pipeline.oldestInFlight());
  }
  return rule === "newest" ? pipeline.newestCounted() : Math.min(pipeline.visibleUpTo(), pipeline.newestCounted());
}

/** Each guardrail's totals by its metric's name; a metric the source doesn't know is left out. */
function metricsFor(guardrails: readonly Guardrail[], totals: Totals): Record<string, ArmPair<ArmSample>> {
  const metrics: Record<string, ArmPair<ArmSample>> = {};
  for (const guardrail of guardrails) {
    const control = sampleFor(guardrail.metric, totals.control),
      treatment = sampleFor(guardrail.metric, totals.treatment);
    if (control !== null && treatment !== null) {
      metrics[guardrail.metric] = { control, treatment };
    }
  }
  return metrics;
}

function createSimSource(options: SourceOptions): SimSource {
  const faults: SourceFaults = { aheadMs: 0, down: false, stuckAt: null },
    counts = { queries: 0 };
  return {
    counts,
    faults,
    snapshot: async (query) => {
      await Promise.resolve();
      counts.queries += 1;
      if (faults.down) {
        throw new Error("The metric source is down.");
      }
      options.pipeline.countFrom(query.since);
      const totals = options.pipeline.totals(),
        snapshot: MetricSnapshot = {
          // The source's own clock: the true time, plus however far its clock is ahead.
          asOf: options.now() + faults.aheadMs,
          contaminated: totals.both,
          exposed: { control: totals.control.units, treatment: totals.treatment.units },
          metrics: metricsFor(query.guardrails, totals),
          watermark: faults.stuckAt ?? watermarkOf(options) + faults.aheadMs,
        };
      return snapshot;
    },
  };
}

export type { SimSource, SourceFaults, SourceOptions, WatermarkRule };
export { createSimSource };
