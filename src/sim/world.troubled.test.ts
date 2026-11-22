import { describe, expect, it, vi } from "vitest";
import { DEFAULT_LIMITS } from "../plan";
import { TROUBLED } from "./scenarios";
import { judgeScenario } from "./report";
import { runsOr } from "./runs";

vi.setConfig({ testTimeout: 7_200_000 });

/**
 * Healthy code again, but the provider fails calls, loses replies and answers stale; the metric source
 * goes down; the watermark is one a real source might report. None of that is the new code's fault, so the
 * budgets of claim 6 still apply, and claims 1 and 2 are still checked against the truth on every run.
 */

const TWO_DOZEN = 24,
  RUNS = runsOr(TWO_DOZEN),
  CASES = TROUBLED.map((scenario) => ({ name: scenario.name, scenario }));

describe("claims 1, 2 and 6: healthy code while everything around the rollout misbehaves", () => {
  it.each(CASES)("$name", async ({ scenario }) => {
    expect.hasAssertions();
    const verdict = await judgeScenario(scenario, RUNS);
    expect(verdict.broken).toStrictEqual([]);
    expect(verdict.regression.low).toBeLessThanOrEqual(DEFAULT_LIMITS.alpha);
    expect(verdict.sampleRatio.low).toBeLessThanOrEqual(DEFAULT_LIMITS.sampleRatioAlpha);
  });
});
