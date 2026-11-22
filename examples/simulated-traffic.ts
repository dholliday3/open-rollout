import type { ArmPair, MemoryFlags, MetricSnapshot, MetricSource } from "open-rollout";
import { FULL_SHARE } from "open-rollout";

/**
 * Stand-in traffic for the quickstart: a steady stream of people, split by whatever the flag serves, each
 * arm failing at its own error rate. It owns the clock so a rollout of an hour runs in well under a second.
 * In an app, the metric source reads these totals from analytics instead (see `createPostHogMetrics`).
 */
interface SimulatedTraffic extends MetricSource {
  /** The simulated clock, in milliseconds. */
  now: () => number;
  /** Lets one minute of people through whatever the flag serves right now. */
  passMinute: () => void;
}

interface TrafficOptions {
  readonly flags: MemoryFlags;
  readonly flagKey: string;
  readonly metric: string;
  /** Each arm's chance that a person hits an error. */
  readonly errorRate: ArmPair<number>;
  readonly peoplePerMinute?: number;
}

const MINUTE = 60_000,
  DEFAULT_PEOPLE_PER_MINUTE = 1000,
  START = Date.UTC(2026, 0, 1);

function simulatedTraffic(options: TrafficOptions): SimulatedTraffic {
  const peoplePerMinute = options.peoplePerMinute ?? DEFAULT_PEOPLE_PER_MINUTE,
    seen = { control: { errors: 0, people: 0 }, treatment: { errors: 0, people: 0 } };
  let now = START;
  const snapshot = (): MetricSnapshot => ({
    asOf: now,
    contaminated: 0,
    exposed: { control: seen.control.people, treatment: seen.treatment.people },
    metrics: {
      [options.metric]: {
        control: { sum: seen.control.errors, units: seen.control.people },
        treatment: { sum: seen.treatment.errors, units: seen.treatment.people },
      },
    },
    watermark: now,
  });
  return {
    now: () => now,
    passMinute: () => {
      const { allocation } = options.flags.peek(options.flagKey);
      for (const arm of ["control", "treatment"] as const) {
        const people = Math.round((peoplePerMinute * allocation[arm]) / FULL_SHARE);
        seen[arm].people += people;
        seen[arm].errors += Math.round(people * options.errorRate[arm]);
      }
      now += MINUTE;
    },
    snapshot: async () => {
      await Promise.resolve();
      return snapshot();
    },
  };
}

export type { SimulatedTraffic, TrafficOptions };
export { simulatedTraffic };
