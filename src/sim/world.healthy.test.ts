import { describe, expect, it, vi } from "vitest";
import { DEFAULT_LIMITS } from "../plan.js";
import { HEALTHY } from "./scenarios.js";
import { judgeScenario } from "./report.js";
import { runsOr } from "./runs.js";

vi.setConfig({ testTimeout: 7_200_000 });

/**
 * Healthy code rolled out through the whole simulated production: heavy-tailed people, a daily curve,
 * evaluators that learn of a change at different times, events that arrive late, twice and out of order.
 * The new code changes nothing, so every action the library takes here is a false one.
 *
 * README claim 6 gives the budgets: a guardrail may call healthy code worse in at most `limits.alpha` of
 * rollouts, and the sample ratio check may fire in at most `limits.sampleRatioAlpha`. A test fails when the
 * low end of the measured rate's 95% interval is above the budget, which is to say when chance does not
 * explain it. Claims 1 and 2 are checked against the truth on every run by the oracle (`broken`).
 */

const SEVERAL_HUNDRED = 300,
  RUNS = runsOr(SEVERAL_HUNDRED),
  CASES = HEALTHY.slice(0, 1).map((scenario) => ({ name: scenario.name, scenario }));

describe("claim 6: healthy code in a realistic world, several hundred rollouts", () => {
  it.each(CASES)("$name", async ({ scenario }) => {
    expect.hasAssertions();
    const verdict = await judgeScenario(scenario, RUNS);
    expect(verdict.broken).toStrictEqual([]);
    expect(verdict.regression.low).toBeLessThanOrEqual(DEFAULT_LIMITS.alpha);
    expect(verdict.sampleRatio.low).toBeLessThanOrEqual(DEFAULT_LIMITS.sampleRatioAlpha);
  });
});
