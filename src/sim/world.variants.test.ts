import { describe, expect, it, vi } from "vitest";
import { DEFAULT_LIMITS } from "../plan";
import { HEALTHY } from "./scenarios";
import { judgeScenario } from "./report";
import { runsOr } from "./runs";

vi.setConfig({ testTimeout: 7_200_000 });

/**
 * Healthy code again, in each of the settings that might inflate false alarms: more guardrails, mean and
 * ratio metrics on heavy-tailed people, a rate near zero or one, a tiny first step, looks every few
 * seconds, workers whose clocks disagree, people with two identities, a small product, a quiet night, and
 * an incident that hits both arms. The budgets are README claim 6's, as in `world.healthy.test.ts`; claims
 * 1 and 2 (and the Lifecycle's rule that a step is watched for its whole time) are checked against the
 * truth on every run.
 *
 * The quick suite gives each setting a dozen rollouts, enough to catch a rate several times over budget.
 * `SIM_RUNS` gives each as many as asked for.
 */

const A_DOZEN = 12,
  RUNS = runsOr(A_DOZEN),
  CASES = HEALTHY.slice(1).map((scenario) => ({ name: scenario.name, scenario }));

describe("claim 6: healthy code, where false alarms might be inflated", () => {
  it.each(CASES)("$name", async ({ scenario }) => {
    expect.hasAssertions();
    const verdict = await judgeScenario(scenario, RUNS);
    expect(verdict.broken).toStrictEqual([]);
    expect(verdict.regression.low).toBeLessThanOrEqual(DEFAULT_LIMITS.alpha);
    expect(verdict.sampleRatio.low).toBeLessThanOrEqual(DEFAULT_LIMITS.sampleRatioAlpha);
  });
});
