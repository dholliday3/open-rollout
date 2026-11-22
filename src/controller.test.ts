import { BASE_ERROR_RATE, FIRST_SHARE, FLAG_KEY, SECOND_SHARE, eventTypes, recordOf, runFor, startedWorld, treatmentShare } from "./__tests__/world";
import { EVERYBODY, NOBODY, measuredStep } from "./allocation";
import { describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 10_000 });

const BROKEN = 0.5,
  STEP_AND_A_BIT = 13,
  WHOLE_ROLLOUT = 40,
  A_WHILE = 5;

describe("a healthy rollout", () => {
  it("serves the first step as soon as it starts", async () => {
    expect.hasAssertions();
    const world = await startedWorld();
    expect(world.flags.peek(FLAG_KEY).allocation).toStrictEqual(measuredStep(FIRST_SHARE));
  });

  it("holds each step for its watch, then moves to the next", async () => {
    expect.hasAssertions();
    const world = await startedWorld();
    await runFor(world, A_WHILE);
    expect(treatmentShare(world)).toBe(FIRST_SHARE);
    await runFor(world, STEP_AND_A_BIT - A_WHILE);
    expect(treatmentShare(world)).toBe(SECOND_SHARE);
  });

  it("releases to everybody after the last step and then settles", async () => {
    expect.hasAssertions();
    const world = await startedWorld();
    await runFor(world, WHOLE_ROLLOUT);
    expect(world.flags.peek(FLAG_KEY).allocation).toStrictEqual(EVERYBODY);
    expect((await recordOf(world)).outcome?.reason).toBe("completed");
    expect((await recordOf(world)).settled).toBe(true);
    await expect(world.store.listUnsettled()).resolves.toStrictEqual([]);
  });

  it("tells people each thing once, in order", async () => {
    expect.hasAssertions();
    const world = await startedWorld();
    await runFor(world, WHOLE_ROLLOUT);
    expect(eventTypes(world)).toStrictEqual(["started", "step_started", "step_started", "releasing", "released"]);
  });
});

describe("a rollout that makes things worse", () => {
  it("is rolled back, with the reading that shows why", async () => {
    expect.hasAssertions();
    const world = await startedWorld();
    world.errorRate = { control: BASE_ERROR_RATE, treatment: BROKEN };
    await runFor(world, A_WHILE);
    const record = await recordOf(world);
    expect(world.flags.peek(FLAG_KEY).allocation).toStrictEqual(NOBODY);
    expect(record.outcome?.reason).toBe("regression");
    expect(record.outcome?.finding?.difference.lower).toBeGreaterThan(0);
  });

  it("never reaches the second step", async () => {
    expect.hasAssertions();
    const world = await startedWorld();
    world.errorRate = { control: BASE_ERROR_RATE, treatment: BROKEN };
    await runFor(world, WHOLE_ROLLOUT);
    expect(eventTypes(world)).toStrictEqual(["started", "step_started", "rolling_back", "rolled_back"]);
  });

  it("pauses instead when the plan leaves the call to a person, and stays put", async () => {
    expect.hasAssertions();
    const world = await startedWorld({ guardrails: [{ direction: "lower_is_better", kind: "rate", metric: "errors", onRegression: "pause", tolerance: 0 }] });
    world.errorRate = { control: BASE_ERROR_RATE, treatment: BROKEN };
    await runFor(world, WHOLE_ROLLOUT);
    expect((await recordOf(world)).pause?.reason).toBe("regression");
    expect(treatmentShare(world)).toBe(FIRST_SHARE);
  });

  it("is rolled back when the new arm loses units before they are counted", async () => {
    expect.hasAssertions();
    const world = await startedWorld();
    world.lostShare = BROKEN;
    await runFor(world, STEP_AND_A_BIT);
    expect((await recordOf(world)).outcome?.reason).toBe("sample_ratio_mismatch");
    expect(treatmentShare(world)).toBe(0);
  });
});
