import { BASE_ERROR_RATE, METRIC, ROLLOUT_ID, SECOND_SHARE, createWorld, eventTypes, passMinute, recordOf, runFor, snapshotOf, startRollout } from "./__tests__/world.js";
import { describe, expect, it, vi } from "vitest";
import { FULL_SHARE } from "./allocation.js";
import type { Guardrail } from "./plan.js";
import type { RolloutSummary } from "./summary.js";
import type { World } from "./__tests__/world.js";
import { summarize } from "./summary.js";

vi.setConfig({ testTimeout: 10_000 });

/**
 * A goal is a guardrail the new behaviour must be shown better on before the release: for a bug fix, the
 * bug's own error. The test world serves 1,000 units a minute, errors at a fixed rate per arm, and has two
 * steps of ten minutes, each giving up after an hour.
 */

const FIXED = 0.005,
  WHOLE_ROLLOUT = 40,
  PAST_THE_LAST_DEADLINE = 90,
  INTO_THE_LAST_STEP = 25,
  ERRORS: Guardrail = { direction: "lower_is_better", kind: "rate", metric: METRIC, onRegression: "rollback", tolerance: 0 },
  GOAL: Guardrail = { ...ERRORS, mustImproveBy: 0 };

async function startedWithGoal(treatmentErrorRate: number, overrides: Parameters<typeof createWorld>[0] = {}): Promise<World> {
  const world = createWorld({ guardrails: [GOAL], onInsufficientData: "pause", ...overrides });
  world.errorRate = { control: BASE_ERROR_RATE, treatment: treatmentErrorRate };
  await startRollout(world);
  return world;
}

/** A minute of traffic, with a "rare" metric that reads like the errors until the last step is on, and then has too few units to read. */
function passMinuteThinAtTheEnd(world: World, thin: { sum: number; units: number }): void {
  passMinute(world);
  const { metrics } = snapshotOf(world),
    atTheEnd = world.flags.peek(world.plan.flagKey).allocation.treatment === SECOND_SHARE,
    rare = atTheEnd ? { control: thin, treatment: thin } : metrics[METRIC];
  world.metrics.set({ ...snapshotOf(world), metrics: { ...metrics, rare } });
}

async function summaryOf(world: World): Promise<RolloutSummary> {
  const inspection = await world.autopilot.inspect(ROLLOUT_ID);
  if (inspection === null) {
    throw new Error("The rollout was never started.");
  }
  return summarize(inspection);
}

/** The source recounts, and the bug turns out as common on the new behaviour as on the old. */
function recountAsUnfixed(world: World): void {
  world.seen = { ...world.seen, treatmentErrors: world.seen.controlErrors };
  world.errorRate = { control: BASE_ERROR_RATE, treatment: BASE_ERROR_RATE };
  passMinute(world);
}

describe("a rollout with a goal", () => {
  it("releases a fix once the bug's error is shown lower on the new behaviour", async () => {
    expect.hasAssertions();
    const world = await startedWithGoal(FIXED);
    await runFor(world, WHOLE_ROLLOUT);
    expect(world.flags.peek(world.plan.flagKey).allocation.treatment).toBe(FULL_SHARE);
    expect(eventTypes(world)).toContain("released");
  });

  it("does not release a change that left the bug's error as it was, and stops at the last step's deadline", async () => {
    expect.hasAssertions();
    const world = await startedWithGoal(BASE_ERROR_RATE);
    await runFor(world, PAST_THE_LAST_DEADLINE);
    const record = await recordOf(world);
    expect(record.phase).toBe("paused");
    expect(record.pause?.reason).toBe("unproven");
    expect(record.pause?.detail).toMatch(/not shown to make things better.*errors is 0\.02 on the new behaviour against 0\.02 on the old/u);
    expect(world.flags.peek(world.plan.flagKey).allocation.treatment).toBe(SECOND_SHARE);
  });

  it("rolls back instead when the plan says a step without its evidence is undone", async () => {
    expect.hasAssertions();
    const world = await startedWithGoal(BASE_ERROR_RATE, { onInsufficientData: "rollback" });
    await runFor(world, PAST_THE_LAST_DEADLINE);
    expect((await recordOf(world)).outcome?.reason).toBe("unproven");
    expect(world.flags.peek(world.plan.flagKey).allocation.treatment).toBe(0);
  });
});

describe("the release gate of a rollout with a goal", () => {
  it("says what the release is waiting for while the last step is watched", async () => {
    expect.hasAssertions();
    const world = await startedWithGoal(BASE_ERROR_RATE);
    await runFor(world, INTO_THE_LAST_STEP);
    const summary = await summaryOf(world);
    expect(summary.headline).toBe("Watching 50% of traffic on the new behaviour. The release waits until errors is shown better.");
    expect(summary.guardrails[0]).toMatchObject({ improved: false, metric: METRIC });
  });

  it("opens the release gate on a yes only if the goal is still shown better then", async () => {
    expect.hasAssertions();
    const world = await startedWithGoal(FIXED, { requiresApprovalToRelease: true });
    await runFor(world, WHOLE_ROLLOUT);
    await expect(recordOf(world)).resolves.toMatchObject({ pendingGate: "release", phase: "awaiting_approval" });
    recountAsUnfixed(world);
    await world.autopilot.command(ROLLOUT_ID, { by: "dana", gate: "release", id: "c1", type: "approve" }, world.now);
    await runFor(world, 2);
    expect(world.flags.peek(world.plan.flagKey).allocation.treatment).toBe(SECOND_SHARE);
    expect((await recordOf(world)).phase).toBe("awaiting_approval");
  });
});

describe("a goal too thin to read", () => {
  it("ends the last step as unproven, not as too little traffic, when the step had its watch and its units", async () => {
    expect.hasAssertions();
    const world = createWorld({ guardrails: [ERRORS, { ...GOAL, metric: "rare" }], onInsufficientData: "pause" }),
      thin = { sum: 0, units: 5 };
    await startRollout(world);
    for (let minute = 0; minute < PAST_THE_LAST_DEADLINE; minute += 1) {
      passMinuteThinAtTheEnd(world, thin);
      // eslint-disable-next-line no-await-in-loop -- a tick a minute, as a scheduler would send them
      await world.autopilot.tick(ROLLOUT_ID, world.now);
    }
    await expect(recordOf(world)).resolves.toMatchObject({ pause: { detail: /rare has too little data to read/u, reason: "unproven" } });
  });
});
