import { describe, expect, it, vi } from "vitest";
import { forecast } from "./traffic.js";
import { planProblems } from "./plan.js";
import { standardPlan } from "./standard-plan.js";
import { testPlan } from "./__tests__/world.js";

vi.setConfig({ testTimeout: 5000 });

const HOUR = 3_600_000,
  MINUTE = 60_000,
  ERRORS = testPlan().guardrails,
  /** Busy enough for the medium plan's 1% step to gather 50 units an arm inside its ten minutes. */
  BUSY = 30_000,
  QUIET = 600,
  /** 50 units an arm at 1% of 600 an hour: eight hours and twenty minutes. */
  QUIET_FIRST_STEP_MS = 30_000_000,
  /** A path a few dozen people a day reach: each 1% step needs two days for 50 units an arm. */
  RARE = 100,
  DESERTED = 5,
  ONE_PERCENT_HOURS = 50,
  PATIENCE = 6,
  STEP_COUNT = 4,
  medium = standardPlan({ flagKey: "fix", guardrails: ERRORS, risk: "medium" });

describe("a forecast of a plan on its traffic", () => {
  it("gets through the medium plan on busy traffic, each step on its own watch", () => {
    expect.hasAssertions();
    const outlook = forecast(medium, BUSY);
    expect(outlook.problems).toStrictEqual([]);
    expect(outlook.steps.every((step) => step.finishes)).toBe(true);
    expect(outlook.expectedMs).toBe(medium.steps.reduce((total, step) => total + step.minDurationMs + medium.limits.propagationMs, 0));
  });

  it("says which step can't gather its units before it gives up on a quiet path, and how long it would need", () => {
    expect.hasAssertions();
    const outlook = forecast(medium, QUIET);
    expect(outlook.problems).toStrictEqual(["Step 1 (1% an arm) needs about 8.3 hours to give each arm 50 new units, but gives up after 61 minutes."]);
    expect(outlook.steps[0].unitsMs).toBeCloseTo(QUIET_FIRST_STEP_MS);
  });

  it("says nobody evaluates a flag with no traffic, and asks nothing of a plan with no guardrails", () => {
    expect.hasAssertions();
    expect(forecast(medium, 0).problems).toStrictEqual(["Nobody evaluates fix, so no step can gather units. Deploy the code that checks the flag first, or ship the change without one."]);
    expect(forecast({ ...medium, guardrails: [] }, 0)).toMatchObject({ problems: [], steps: medium.steps.map(() => ({ finishes: true, unitsMs: 0 })) });
  });

  it("adds the metric source's lag to every step", () => {
    expect.hasAssertions();
    const lagging = standardPlan({ flagKey: "fix", guardrails: ERRORS, risk: "medium", sourceLagMs: HOUR });
    expect(forecast(lagging, BUSY).expectedMs - forecast(medium, BUSY).expectedMs).toBe(STEP_COUNT * HOUR);
  });
});

describe("a standard plan sized to its traffic", () => {
  it("keeps the ladder's watches where the traffic is busy enough for them", () => {
    expect.hasAssertions();
    expect(standardPlan({ flagKey: "fix", guardrails: ERRORS, risk: "medium", unitsPerHour: BUSY })).toStrictEqual(medium);
  });

  it("stretches each step to the time its units take to arrive, and gets through on that traffic", () => {
    expect.hasAssertions();
    const sized = standardPlan({ flagKey: "fix", guardrails: ERRORS, risk: "medium", unitsPerHour: RARE }),
      [first] = sized.steps;
    expect(first.minDurationMs).toBe(ONE_PERCENT_HOURS * HOUR);
    expect(first.maxDurationMs).toBe(ONE_PERCENT_HOURS * HOUR * PATIENCE);
    expect(planProblems(sized)).toStrictEqual([]);
    expect(forecast(sized, RARE).problems).toStrictEqual([]);
  });

  it("is refused when a step would wait longer than a rollout may go without progress", () => {
    expect.hasAssertions();
    const sized = standardPlan({ flagKey: "fix", guardrails: ERRORS, risk: "medium", unitsPerHour: DESERTED });
    expect(planProblems(sized)[0]).toMatch(/^Step 1 may wait 250\.0 days for its units, longer than a rollout may go without progress \(expireAfterIdleMs, 21\.0 days\)/u);
  });

  it("leaves the ladder alone for traffic that is no number, and for a step the overrides already time", () => {
    expect.hasAssertions();
    expect(standardPlan({ flagKey: "fix", guardrails: ERRORS, risk: "medium", unitsPerHour: 0 })).toStrictEqual(medium);
    expect(standardPlan({ flagKey: "fix", guardrails: ERRORS, overrides: { everyStep: { minDurationMs: MINUTE } }, risk: "medium", unitsPerHour: RARE }).steps[0].minDurationMs).toBe(MINUTE);
  });
});
