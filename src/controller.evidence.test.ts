import { FIRST_SHARE, METRIC, MINUTE, ROLLOUT_ID, SECOND_SHARE, createWorld, eventTypes, passMinute, recordOf, runFor, snapshotOf, startRollout, startedWorld, treatmentShare } from "./__tests__/world.js";
import { describe, expect, it, vi } from "vitest";
import type { MetricSnapshot } from "./ports.js";
import type { World } from "./__tests__/world.js";

vi.setConfig({ testTimeout: 10_000 });

const STEP_AND_A_BIT = 13,
  LONG_ENOUGH_TO_SETTLE = 60,
  PAST_PATIENCE = 70,
  A_WHILE = 5,
  BLIND_TOO_LONG = 20,
  THREE_WEEKS_AND_A_DAY = 31_680;

describe("a rollout without evidence", () => {
  it("does not move on while no new units arrive, however long it waits", async () => {
    expect.hasAssertions();
    const world = await startedWorld();
    world.perMinute = 0;
    await runFor(world, STEP_AND_A_BIT * 2);
    expect(treatmentShare(world)).toBe(FIRST_SHARE);
  });

  it("is rolled back when a step never gets enough traffic", async () => {
    expect.hasAssertions();
    const world = await startedWorld();
    world.perMinute = 0;
    await runFor(world, PAST_PATIENCE);
    expect((await recordOf(world)).outcome?.reason).toBe("insufficient_data");
    expect(treatmentShare(world)).toBe(0);
  });

  it("holds while the metrics are down, and says so once", async () => {
    expect.hasAssertions();
    const world = await startedWorld();
    world.metricsDown = true;
    await runFor(world, BLIND_TOO_LONG);
    expect(treatmentShare(world)).toBe(FIRST_SHARE);
    expect(eventTypes(world).filter((type) => type === "metrics_outage")).toHaveLength(1);
  });

  it("carries on when the metrics return, watching the step from then: time spent blind was not watched", async () => {
    expect.hasAssertions();
    const world = await startedWorld();
    world.metricsDown = true;
    await runFor(world, BLIND_TOO_LONG);
    world.metricsDown = false;
    await runFor(world, A_WHILE);
    expect(treatmentShare(world)).toBe(FIRST_SHARE);
    await runFor(world, STEP_AND_A_BIT);
    expect(eventTypes(world)).toContain("metrics_restored");
    expect(treatmentShare(world)).toBe(SECOND_SHARE);
  });
});

describe("a rollout whose evidence is late or gone", () => {
  it("does not count stale metrics as a watch", async () => {
    expect.hasAssertions();
    const world = await startedWorld();
    world.lagMs = LONG_ENOUGH_TO_SETTLE * MINUTE;
    await runFor(world, STEP_AND_A_BIT * 2);
    expect(treatmentShare(world)).toBe(FIRST_SHARE);
  });

  it("is rolled back after too long blind when the plan says so", async () => {
    expect.hasAssertions();
    const world = await startedWorld({ onMetricsOutage: "rollback" });
    world.metricsDown = true;
    await runFor(world, BLIND_TOO_LONG);
    expect((await recordOf(world)).outcome?.reason).toBe("metrics_outage");
  });

  it("is undone after three weeks with no progress", async () => {
    expect.hasAssertions();
    const world = await startedWorld();
    await world.autopilot.command(ROLLOUT_ID, { by: "dana", id: "c1", type: "pause" }, world.now);
    world.now += THREE_WEEKS_AND_A_DAY * MINUTE;
    await runFor(world, 2);
    expect((await recordOf(world)).outcome?.reason).toBe("expired");
    expect(treatmentShare(world)).toBe(0);
  });
});

/** Minutes of traffic where the metric source answers with whatever `garble` makes of the truth. */
async function runGarbled(world: World, minutes: number, garble: (snapshot: MetricSnapshot) => MetricSnapshot): Promise<string[]> {
  if (minutes <= 0) {
    return [];
  }
  passMinute(world);
  world.metrics.set(garble(snapshotOf(world)));
  const { problems } = await world.autopilot.tick(ROLLOUT_ID, world.now);
  return [...problems, ...(await runGarbled(world, minutes - 1, garble))];
}

function withNoRequests(snapshot: MetricSnapshot): MetricSnapshot {
  const nothing = { denominator: { crossSum: 0, sum: 0, sumSquares: 0 }, sum: 0, sumSquares: 0 };
  return { ...snapshot, metrics: { [METRIC]: { control: { ...nothing, units: snapshot.exposed.control }, treatment: { ...nothing, units: snapshot.exposed.treatment } } } };
}

describe("a rollout fed numbers that can't be right", () => {
  it("holds, and says why, when a count is not a number", async () => {
    expect.hasAssertions();
    const world = await startedWorld(),
      problems = await runGarbled(world, STEP_AND_A_BIT * 2, (snapshot) => ({ ...snapshot, metrics: { [METRIC]: { control: { sum: Number.NaN, units: Number.NaN }, treatment: { sum: Number.NaN, units: Number.NaN } } } }));
    expect(treatmentShare(world)).toBe(FIRST_SHARE);
    expect(problems).toContain("The numbers for errors can't be right: its units or its total is not a count.");
  });

  it("holds when the source leaves a guardrail's metric out", async () => {
    expect.hasAssertions();
    const world = await startedWorld(),
      problems = await runGarbled(world, STEP_AND_A_BIT * 2, (snapshot) => ({ ...snapshot, metrics: {} }));
    expect(treatmentShare(world)).toBe(FIRST_SHARE);
    expect(problems).toContain("The metrics say nothing about errors.");
  });

  it("holds when more units had the event than there are units", async () => {
    expect.hasAssertions();
    const world = await startedWorld();
    await runGarbled(world, STEP_AND_A_BIT * 2, (snapshot) => ({ ...snapshot, metrics: { [METRIC]: { control: { sum: 2, units: 1 }, treatment: { sum: 2, units: 1 } } } }));
    expect(treatmentShare(world)).toBe(FIRST_SHARE);
    expect((await recordOf(world)).blindSince).not.toBeNull();
  });

  it("does not move on while a guardrail has too little to read, however many units were exposed", async () => {
    expect.hasAssertions();
    // Errors per request, and nobody has made a request: the totals are fine, there is just nothing to divide by.
    const world = createWorld({ guardrails: [{ direction: "lower_is_better", kind: "ratio", metric: METRIC, onRegression: "rollback", tolerance: 0 }] });
    world.metrics.set(withNoRequests(snapshotOf(world)));
    await startRollout(world);
    await runGarbled(world, STEP_AND_A_BIT * 2, withNoRequests);
    expect(treatmentShare(world)).toBe(FIRST_SHARE);
  });
});
