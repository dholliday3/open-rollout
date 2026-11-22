import { DEFAULT_LIMITS, planProblems, standardPlan, stepAt } from "./plan.js";
import { describe, expect, it, vi } from "vitest";
import type { RolloutPlan } from "./plan.js";
import { testPlan } from "./__tests__/world.js";

vi.setConfig({ testTimeout: 5000 });

const TOO_BIG = 6000,
  SMALLER = 500,
  [STEP] = testPlan().steps,
  RISKS = ["low", "medium", "high"] as const;

/** A plan as JSON might hold it: the right shape, with a word the types would have refused. */
function withOddGuardrail(part: Record<string, string>): RolloutPlan {
  const [guardrail] = testPlan().guardrails;
  return testPlan({ guardrails: [Object.assign(guardrail, part)] });
}

function withOddPolicy(part: Record<string, string>): RolloutPlan {
  return Object.assign(testPlan(), part);
}

function withStep(change: Partial<RolloutPlan["steps"][number]>): RolloutPlan {
  return testPlan({ steps: [{ ...STEP, ...change }] });
}

describe("checking a plan", () => {
  it("passes the standard plan for every risk", () => {
    expect.hasAssertions();
    expect(RISKS.flatMap((risk) => planProblems(standardPlan({ flagKey: "f", guardrails: [], risk })))).toStrictEqual([]);
  });

  it("asks for approval before the release only when the risk is high", () => {
    expect.hasAssertions();
    expect(RISKS.map((risk) => standardPlan({ flagKey: "f", guardrails: [], risk }).requiresApprovalToRelease)).toStrictEqual([false, false, true]);
  });

  it("refuses a plan with no flag or no steps", () => {
    expect.hasAssertions();
    expect(planProblems(testPlan({ flagKey: "" }))).toStrictEqual(["A plan names its flag."]);
    expect(planProblems(testPlan({ steps: [] }))).toStrictEqual(["A plan needs at least one step."]);
  });

  it("refuses a step above half, a fractional one, and one not above the step before", () => {
    expect.hasAssertions();
    expect(planProblems(withStep({ treatmentShare: TOO_BIG }))).toHaveLength(1);
    expect(planProblems(withStep({ treatmentShare: 0.5 }))).toHaveLength(1);
    expect(planProblems(testPlan({ steps: [STEP, { ...STEP, treatmentShare: SMALLER }] }))).toHaveLength(1);
  });

  it("refuses a step that gives up before its watch is over, or watches for no time", () => {
    expect.hasAssertions();
    expect(planProblems(withStep({ maxDurationMs: STEP.minDurationMs - 1 }))).toHaveLength(1);
    expect(planProblems(withStep({ minDurationMs: 0 }))).toHaveLength(1);
    expect(planProblems(withStep({ minFreshUnits: -1 }))).toHaveLength(1);
  });

  it("refuses a negative tolerance and the same metric twice", () => {
    expect.hasAssertions();
    const [guardrail] = testPlan().guardrails;
    expect(planProblems(testPlan({ guardrails: [{ ...guardrail, tolerance: -1 }] }))).toStrictEqual(["The tolerance for errors can't be negative."]);
    expect(planProblems(testPlan({ guardrails: [guardrail, guardrail] }))).toStrictEqual(["Each metric can guard a rollout once."]);
  });

  it("refuses error rates outside 0 to 0.5 and a tuning point of nothing", () => {
    expect.hasAssertions();
    expect(planProblems(testPlan({ limits: { ...DEFAULT_LIMITS, alpha: 0 } }))).toHaveLength(1);
    expect(planProblems(testPlan({ limits: { ...DEFAULT_LIMITS, sampleRatioAlpha: 1 } }))).toHaveLength(1);
    expect(planProblems(testPlan({ limits: { ...DEFAULT_LIMITS, tuneAtUnits: 0 } }))).toHaveLength(1);
    expect(planProblems(testPlan({ limits: { ...DEFAULT_LIMITS, minUnitsToJudge: 1 } }))).toHaveLength(1);
  });
});

describe("checking a plan's numbers", () => {
  it("refuses a number that isn't one, wherever it is", () => {
    expect.hasAssertions();
    const [guardrail] = testPlan().guardrails;
    expect(planProblems(withStep({ minDurationMs: Number.NaN }))).toHaveLength(1);
    expect(planProblems(withStep({ maxDurationMs: Number.POSITIVE_INFINITY }))).toHaveLength(1);
    expect(planProblems(withStep({ minFreshUnits: Number.NaN }))).toHaveLength(1);
    expect(planProblems(testPlan({ guardrails: [{ ...guardrail, tolerance: Number.NaN }] }))).toHaveLength(1);
    expect(planProblems(testPlan({ limits: { ...DEFAULT_LIMITS, tuneAtUnits: Number.NaN } }))).toHaveLength(1);
  });

  it("refuses a negative limit, a share above 1, and a guardrail with no metric", () => {
    expect.hasAssertions();
    const [guardrail] = testPlan().guardrails;
    expect(planProblems(testPlan({ limits: { ...DEFAULT_LIMITS, settleMs: -1 } }))).toHaveLength(1);
    expect(planProblems(testPlan({ limits: { ...DEFAULT_LIMITS, maxBlindMs: Number.NaN } }))).toHaveLength(1);
    expect(planProblems(testPlan({ limits: { ...DEFAULT_LIMITS, maxContaminatedShare: 2 } }))).toHaveLength(1);
    expect(planProblems(testPlan({ guardrails: [{ ...guardrail, metric: "" }] }))).toStrictEqual(["A guardrail names its metric."]);
  });
});

describe("checking a plan that came from somewhere untyped", () => {
  it("refuses a rollout that expires at once, and metrics that are stale at once", () => {
    expect.hasAssertions();
    expect(planProblems(testPlan({ limits: { ...DEFAULT_LIMITS, expireAfterIdleMs: 0 } }))).toHaveLength(1);
    expect(planProblems(testPlan({ limits: { ...DEFAULT_LIMITS, maxStalenessMs: 0 } }))).toHaveLength(1);
  });

  it("refuses a kind, a direction, a reaction or a policy it doesn't know", () => {
    expect.hasAssertions();
    const guardrails: Record<string, string>[] = [{ kind: "median" }, { direction: "up" }, { onRegression: "shrug" }],
      policies: Record<string, string>[] = [{ onMetricsOutage: "shrug" }, { onInsufficientData: "shrug" }];
    expect(guardrails.map((part) => planProblems(withOddGuardrail(part)).length)).toStrictEqual([1, 1, 1]);
    expect(policies.map((part) => planProblems(withOddPolicy(part)).length)).toStrictEqual([1, 1]);
  });
});

describe("the step at an index", () => {
  it("is nothing before the first step or past the last", () => {
    expect.hasAssertions();
    expect(stepAt(testPlan(), -1)).toBeUndefined();
    expect(stepAt(testPlan(), 2)).toBeUndefined();
    expect(stepAt(testPlan(), 0)).toStrictEqual(STEP);
  });
});
