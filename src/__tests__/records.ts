import { FIRST_SHARE, START, testPlan } from "./world.js";
import type { FlagReading, MetricSnapshot } from "../ports.js";
import type { RolloutPlan } from "../plan.js";
import type { RolloutRecord } from "../record.js";
import { measuredStep } from "../allocation.js";
import { newRecord } from "../record.js";

/** Hand-made records and observations for the pure stages' tests: a rollout at a known point, with nothing left to chance. */

const UNITS = 500,
  FEW_ERRORS = 10;

/** The first step, seen in force at `START`, its watch begun at `START` with nobody counted yet. */
function watchingStep(overrides: Partial<RolloutPlan> = {}): RolloutRecord {
  return {
    ...newRecord("r1", testPlan(overrides), START),
    confirmedAt: START,
    confirmedEpoch: 1,
    desired: measuredStep(FIRST_SHARE),
    epoch: 1,
    exposedSince: START,
    freshBaseline: { asOf: START, control: 0, treatment: 0 },
    pendingGate: null,
    phase: "ramping",
    seenRevision: 1,
    stepIndex: 0,
  };
}

function flagAt(share: number, revision = 1): FlagReading {
  return { allocation: measuredStep(share), revision };
}

function armOf(count: number): { sum: number; units: number } {
  return { sum: Math.min(FEW_ERRORS, count), units: count };
}

/** A healthy snapshot: each arm has its units and a few errors, complete up to `watermark` and taken then. */
function healthyAt(watermark: number, units?: { control: number; treatment: number }): MetricSnapshot {
  const exposed = units ?? { control: UNITS, treatment: UNITS };
  return { asOf: watermark, contaminated: 0, exposed, metrics: { errors: { control: armOf(exposed.control), treatment: armOf(exposed.treatment) } }, watermark };
}

export { flagAt, healthyAt, watchingStep };
