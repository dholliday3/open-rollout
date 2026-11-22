import { DEFAULT_LIMITS, planProblems } from "../plan.js";
import { describe, expect, it, vi } from "vitest";
import type { RolloutPlan } from "../plan.js";
import { benchPlan } from "./bench.js";

vi.setConfig({ testTimeout: 5000 });

/**
 * Plans that can't mean anything, or that quietly switch a safeguard off. `planProblems` is the only check
 * before a plan is stored for good, so each of these should come back with at least one problem.
 */

const PLAN = benchPlan(),
  [STEP] = PLAN.steps,
  [GUARDRAIL] = PLAN.guardrails,
  NOT_A_NUMBER = Number.NaN,
  ENDLESS = Number.POSITIVE_INFINITY,
  MINUS_TEN_MINUTES = -600_000,
  ABOVE_ALL = 1.5;

/** A plan as it arrives from JSON or an agent: shaped like one, with nothing checked. */
function fromJson(plan: unknown): RolloutPlan {
  // eslint-disable-next-line typescript/no-unsafe-type-assertion -- the point is a plan that breaks its type
  return plan as RolloutPlan;
}

function withLimit(change: Partial<RolloutPlan["limits"]>): RolloutPlan {
  return benchPlan({ limits: { ...DEFAULT_LIMITS, ...change } });
}

function withStep(change: Partial<RolloutPlan["steps"][number]>): RolloutPlan {
  return benchPlan({ steps: [{ ...STEP, ...change }] });
}

describe("checking a plan: what switches a safeguard off", () => {
  it.each([
    ["a tolerance that is not a number (the guardrail can never fire)", benchPlan({ guardrails: [{ ...GUARDRAIL, tolerance: NOT_A_NUMBER }] })],
    ["an endless tolerance", benchPlan({ guardrails: [{ ...GUARDRAIL, tolerance: ENDLESS }] })],
    ["a tuning point that is not a number (no guardrail and no sample ratio check can fire)", withLimit({ tuneAtUnits: NOT_A_NUMBER })],
    ["an endless tuning point", withLimit({ tuneAtUnits: ENDLESS })],
    ["a negative propagation time (it comes off every step's watch)", withLimit({ propagationMs: MINUS_TEN_MINUTES })],
    ["a propagation time that is not a number", withLimit({ propagationMs: NOT_A_NUMBER })],
    ["a contamination limit that is not a number (the check never fires)", withLimit({ maxContaminatedShare: NOT_A_NUMBER })],
    ["a contamination limit above everything", withLimit({ maxContaminatedShare: ABOVE_ALL })],
    ["a floor of units that is not a number", withLimit({ minUnitsToJudge: NOT_A_NUMBER })],
    ["metrics that never go stale", withLimit({ maxStalenessMs: ENDLESS })],
  ])("refuses %s", (_name, plan) => {
    expect.hasAssertions();
    expect(planProblems(plan)).not.toHaveLength(0);
  });
});

describe("checking a plan: what can never run", () => {
  it.each([
    ["a settle time that is not a number (the rollout never settles, and its flag can never be rolled out again)", withLimit({ settleMs: NOT_A_NUMBER })],
    ["a negative settle time", withLimit({ settleMs: -1 })],
    ["a staleness limit below zero (every snapshot is stale)", withLimit({ maxStalenessMs: -1 })],
    ["a staleness limit that is not a number", withLimit({ maxStalenessMs: NOT_A_NUMBER })],
    ["a blind limit that is not a number", withLimit({ maxBlindMs: NOT_A_NUMBER })],
    ["an expiry that is not a number (the rollout is undone on its first tick)", withLimit({ expireAfterIdleMs: NOT_A_NUMBER })],
    ["an expiry of no time", withLimit({ expireAfterIdleMs: 0 })],
    ["a step watched for a time that is not a number", withStep({ minDurationMs: NOT_A_NUMBER })],
    ["a step that gives up at a time that is not a number", withStep({ maxDurationMs: NOT_A_NUMBER })],
    ["a step that needs a number of new units that is not a number", withStep({ minFreshUnits: NOT_A_NUMBER })],
    ["a step watched for ever", withStep({ maxDurationMs: ENDLESS, minDurationMs: ENDLESS })],
    ["a kind of metric that doesn't exist", fromJson({ ...PLAN, guardrails: [{ ...GUARDRAIL, kind: "median" }] })],
    ["a direction that doesn't exist", fromJson({ ...PLAN, guardrails: [{ ...GUARDRAIL, direction: "up" }] })],
    ["a reaction that doesn't exist", fromJson({ ...PLAN, onMetricsOutage: "panic" })],
  ])("refuses %s", (_name, plan) => {
    expect.hasAssertions();
    expect(planProblems(plan)).not.toHaveLength(0);
  });
});
