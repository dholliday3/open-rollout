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
  /** More metrics counted the same way, such as conversion: each arm's chance that a person has the event. */
  readonly rates?: Readonly<Record<string, ArmPair<number>>>;
  readonly peoplePerMinute?: number;
  /** How far behind the clock the metrics run, as a warehouse loaded every hour does. */
  readonly lagMs?: number;
}

/** Running totals for one arm: people, and how many of them had each metric's event. */
interface ArmTotals {
  readonly people: number;
  readonly events: Readonly<Record<string, number>>;
}

interface Minute {
  readonly at: number;
  readonly totals: ArmPair<ArmTotals>;
}

const MINUTE = 60_000,
  DEFAULT_PEOPLE_PER_MINUTE = 1000,
  START = Date.UTC(2026, 0, 1),
  NOBODY_YET: ArmPair<ArmTotals> = { control: { events: {}, people: 0 }, treatment: { events: {}, people: 0 } };

/** The totals the metrics have caught up with: the last minute at or before the watermark. */
function knownBy(minutes: readonly Minute[], watermark: number): ArmPair<ArmTotals> {
  let known = NOBODY_YET;
  for (const minute of minutes) {
    if (minute.at <= watermark) {
      known = minute.totals;
    }
  }
  return known;
}

/** What the metrics say at `now`: each metric's totals as far as the data has caught up. */
function snapshotOf(minutes: readonly Minute[], names: readonly string[], at: { now: number; lagMs: number }): MetricSnapshot {
  const watermark = at.now - at.lagMs,
    known = knownBy(minutes, watermark);
  return {
    asOf: at.now,
    contaminated: 0,
    exposed: { control: known.control.people, treatment: known.treatment.people },
    metrics: Object.fromEntries(
      names.map((name) => [
        name,
        {
          control: { sum: known.control.events[name] ?? 0, units: known.control.people },
          treatment: { sum: known.treatment.events[name] ?? 0, units: known.treatment.people },
        },
      ]),
    ),
    watermark,
  };
}

function simulatedTraffic(options: TrafficOptions): SimulatedTraffic {
  const peoplePerMinute = options.peoplePerMinute ?? DEFAULT_PEOPLE_PER_MINUTE,
    rates: Record<string, ArmPair<number>> = { ...options.rates, [options.metric]: options.errorRate },
    minutes: Minute[] = [];
  let now = START,
    totals = NOBODY_YET;
  const arm = (side: "control" | "treatment", people: number): ArmTotals => ({
    events: Object.fromEntries(Object.entries(rates).map(([name, rate]) => [name, (totals[side].events[name] ?? 0) + Math.round(people * rate[side])])),
    people: totals[side].people + people,
  });
  const snapshot = (): MetricSnapshot => snapshotOf(minutes, Object.keys(rates), { lagMs: options.lagMs ?? 0, now });
  return {
    now: () => now,
    passMinute: () => {
      const { allocation } = options.flags.peek(options.flagKey);
      totals = {
        control: arm("control", Math.round((peoplePerMinute * allocation.control) / FULL_SHARE)),
        treatment: arm("treatment", Math.round((peoplePerMinute * allocation.treatment) / FULL_SHARE)),
      };
      now += MINUTE;
      minutes.push({ at: now, totals });
    },
    snapshot: async () => {
      await Promise.resolve();
      return snapshot();
    },
    // Every person here is new and reaches the flag.
    traffic: async () => {
      await Promise.resolve();
      return peoplePerMinute * 60;
    },
  };
}

export type { SimulatedTraffic, TrafficOptions };
export { simulatedTraffic };
