import type { Person } from "./population.js";

/**
 * What the new code does to the people who get it. Each effect is the ground truth of one rollout: the
 * library never sees it, only the metrics it leaves behind.
 */

/** One visit served the new behaviour, and what was true at that moment. */
interface Served {
  readonly person: Person;
  readonly at: number;
  /** When the rollout started. */
  readonly startedAt: number;
  /** The share really on the new behaviour right now, in basis points. */
  readonly treatmentShare: number;
  /** True on a person's first visit under the new behaviour. */
  readonly firstVisit: boolean;
}

interface Effect {
  /** A request's chance of failing under the new behaviour, from its chance under the old. */
  readonly errorChance: (base: number, served: Served) => number;
  /** What a visit's latency is multiplied by. */
  readonly latencyFactor: number;
  /** What a visit's chance of converting is multiplied by. */
  readonly conversionFactor: number;
  /** Chance the new behaviour crashes before the exposure is logged, so the unit is never counted. */
  readonly exposureLoss: number;
  /** A failure that hits everybody, on both arms: what every request's error chance is multiplied by at an instant. */
  readonly commonMode: (sinceStartMs: number) => number;
}

type EffectName = "healthy" | "outage" | "moderate" | "subtle" | "leak" | "segment" | "heavy_users" | "load" | "novelty" | "latency" | "conversion" | "common_mode" | "exposure_loss";

const MINUTE = 60_000,
  DOUBLE = 2,
  SUBTLE = 1.25,
  LEAK_AFTER_MS = 1_200_000,
  LEAK_FACTOR = 5,
  HEAVY_FROM = 15,
  HEAVY_FACTOR = 4,
  LOAD_ABOVE_SHARE = 2500,
  LOAD_FACTOR = 4,
  NOVELTY_FACTOR = 6,
  SLOWER = 1.3,
  FEWER = 0.6,
  LOST = 0.2,
  INCIDENT_FROM_MIN = 8,
  INCIDENT_FOR_MIN = 15,
  INCIDENT_FACTOR = 25,
  HEALTHY: Effect = { commonMode: () => 1, conversionFactor: 1, errorChance: (base) => base, exposureLoss: 0, latencyFactor: 1 };

function times(factor: number): Effect["errorChance"] {
  return (base) => Math.min(1, base * factor);
}

function incident(sinceStartMs: number): number {
  const minutes = sinceStartMs / MINUTE;
  return minutes >= INCIDENT_FROM_MIN && minutes < INCIDENT_FROM_MIN + INCIDENT_FOR_MIN ? INCIDENT_FACTOR : 1;
}

const EFFECTS: Record<EffectName, Effect> = {
  common_mode: { ...HEALTHY, commonMode: incident },
  conversion: { ...HEALTHY, conversionFactor: FEWER },
  exposure_loss: { ...HEALTHY, exposureLoss: LOST },
  healthy: HEALTHY,
  heavy_users: { ...HEALTHY, errorChance: (base, served) => Math.min(1, base * (served.person.activity >= HEAVY_FROM ? HEAVY_FACTOR : 1)) },
  latency: { ...HEALTHY, latencyFactor: SLOWER },
  leak: { ...HEALTHY, errorChance: (base, served) => Math.min(1, base * (served.at - served.startedAt >= LEAK_AFTER_MS ? LEAK_FACTOR : 1)) },
  load: { ...HEALTHY, errorChance: (base, served) => Math.min(1, base * (served.treatmentShare > LOAD_ABOVE_SHARE ? LOAD_FACTOR : 1)) },
  moderate: { ...HEALTHY, errorChance: times(DOUBLE) },
  novelty: { ...HEALTHY, errorChance: (base, served) => Math.min(1, base * (served.firstVisit ? NOVELTY_FACTOR : 1)) },
  outage: { ...HEALTHY, errorChance: () => 1 },
  segment: { ...HEALTHY, errorChance: (base, served) => (served.person.brokenBrowser ? 1 : base) },
  subtle: { ...HEALTHY, errorChance: times(SUBTLE) },
};

export type { Effect, EffectName, Served };
export { EFFECTS };
