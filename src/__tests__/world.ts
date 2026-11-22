import type { ArmPair, MetricSnapshot, RolloutStore } from "../ports.js";
import type { MemoryFlags, MemoryMetrics, MemoryNotifier } from "../adapters/memory.js";
import { createMemoryFlags, createMemoryMetrics, createMemoryNotifier, createMemoryStore } from "../adapters/memory.js";
import type { Autopilot } from "../controller.js";
import { DEFAULT_LIMITS } from "../plan.js";
import { FULL_SHARE } from "../allocation.js";
import type { RolloutPlan } from "../plan.js";
import type { RolloutRecord } from "../record.js";
import { createAutopilot } from "../controller.js";

/**
 * A small, exact world for the controller's tests: traffic arrives at a steady rate, splits by whatever the
 * flag serves, and errors at a fixed rate per arm. Nothing is random, so a test can say what must happen.
 */
interface World {
  readonly autopilot: Autopilot;
  readonly flags: MemoryFlags;
  readonly metrics: MemoryMetrics;
  readonly notifier: MemoryNotifier;
  readonly store: RolloutStore;
  readonly plan: RolloutPlan;
  now: number;
  /** Units a minute across all traffic. */
  perMinute: number;
  errorRate: ArmPair<number>;
  /** How far the metrics run behind the clock. */
  lagMs: number;
  metricsDown: boolean;
  /** Share of the new arm's units that never get counted. */
  lostShare: number;
  seen: { control: number; treatment: number; controlErrors: number; treatmentErrors: number };
}

const MINUTE = 60_000,
  ROLLOUT_ID = "rollout-1",
  FLAG_KEY = "new-checkout",
  METRIC = "errors",
  TEN_MINUTES = 10,
  STEP_MINUTES = 10,
  PATIENCE_MINUTES = 60,
  FRESH_UNITS = 20,
  FIRST_SHARE = 1000,
  SECOND_SHARE = 5000,
  BASE_ERROR_RATE = 0.02,
  TRAFFIC_PER_MINUTE = 1000,
  START = 1_700_000_000_000,
  NOTHING_SEEN = { control: 0, controlErrors: 0, treatment: 0, treatmentErrors: 0 };

function testPlan(overrides: Partial<RolloutPlan> = {}): RolloutPlan {
  const step = { maxDurationMs: PATIENCE_MINUTES * MINUTE, minDurationMs: STEP_MINUTES * MINUTE, minFreshUnits: FRESH_UNITS, requiresApproval: false };
  return {
    flagKey: FLAG_KEY,
    guardrails: [{ direction: "lower_is_better", kind: "rate", metric: METRIC, onRegression: "rollback", tolerance: 0 }],
    limits: DEFAULT_LIMITS,
    onInsufficientData: "rollback",
    onMetricsOutage: "hold",
    onSampleRatioMismatch: "rollback",
    requiresApprovalToRelease: false,
    steps: [
      { ...step, treatmentShare: FIRST_SHARE },
      { ...step, treatmentShare: SECOND_SHARE },
    ],
    ...overrides,
  };
}

function createWorld(overrides: Partial<RolloutPlan> = {}): World {
  const flags = createMemoryFlags(),
    metrics = createMemoryMetrics(),
    notifier = createMemoryNotifier(),
    store = createMemoryStore();
  // The source is up and has seen nobody: a rollout doesn't start a step while its metrics can't be read.
  metrics.set({ asOf: START, contaminated: 0, exposed: { control: 0, treatment: 0 }, metrics: { [METRIC]: { control: { sum: 0, units: 0 }, treatment: { sum: 0, units: 0 } } }, watermark: START });
  return {
    autopilot: createAutopilot({ flags, metrics, notifier, store }),
    errorRate: { control: BASE_ERROR_RATE, treatment: BASE_ERROR_RATE },
    flags,
    lagMs: 0,
    lostShare: 0,
    metrics,
    metricsDown: false,
    notifier,
    now: START,
    perMinute: TRAFFIC_PER_MINUTE,
    plan: testPlan(overrides),
    seen: { ...NOTHING_SEEN },
    store,
  };
}

function snapshotOf(world: World): MetricSnapshot {
  const { seen } = world;
  return {
    asOf: world.now,
    contaminated: 0,
    exposed: { control: seen.control, treatment: seen.treatment },
    metrics: { [METRIC]: { control: { sum: seen.controlErrors, units: seen.control }, treatment: { sum: seen.treatmentErrors, units: seen.treatment } } },
    watermark: world.now - world.lagMs,
  };
}

/** A minute of traffic through whatever the flag serves, then the metrics catch up to it. */
function passMinute(world: World): void {
  const { allocation } = world.flags.peek(FLAG_KEY),
    control = (world.perMinute * allocation.control) / FULL_SHARE,
    treatment = ((world.perMinute * allocation.treatment) / FULL_SHARE) * (1 - world.lostShare);
  world.now += MINUTE;
  world.seen.control += control;
  world.seen.treatment += treatment;
  world.seen.controlErrors += control * world.errorRate.control;
  world.seen.treatmentErrors += treatment * world.errorRate.treatment;
  world.metrics.set(world.metricsDown ? null : snapshotOf(world));
}

/** Lets minutes pass, ticking once at the end of each. */
async function runFor(world: World, minutes: number): Promise<void> {
  if (minutes <= 0) {
    return;
  }
  passMinute(world);
  await world.autopilot.tick(ROLLOUT_ID, world.now);
  await runFor(world, minutes - 1);
}

async function startRollout(world: World): Promise<void> {
  await world.autopilot.start({ id: ROLLOUT_ID, now: world.now, plan: world.plan });
}

async function startedWorld(overrides: Partial<RolloutPlan> = {}): Promise<World> {
  const world = createWorld(overrides);
  await startRollout(world);
  return world;
}

async function recordOf(world: World): Promise<RolloutRecord> {
  const stored = await world.store.load(ROLLOUT_ID);
  if (stored === null) {
    throw new Error("The rollout was never started.");
  }
  return stored.record;
}

function treatmentShare(world: World): number {
  return world.flags.peek(FLAG_KEY).allocation.treatment;
}

function eventTypes(world: World): string[] {
  return world.notifier.events.map((event) => event.type);
}

export type { World };
export { BASE_ERROR_RATE, FIRST_SHARE, FLAG_KEY, METRIC, MINUTE, ROLLOUT_ID, SECOND_SHARE, START, TEN_MINUTES, createWorld, eventTypes, passMinute, recordOf, runFor, snapshotOf, startRollout, startedWorld, testPlan, treatmentShare };
