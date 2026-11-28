import { DEFAULT_LIMITS, goalAlphaOf } from "../plan.js";
import { describe, expect, it, vi } from "vitest";
import { GOALS } from "./scenarios.js";
import { judgeScenario } from "./report.js";
import { runsOr } from "./runs.js";
import { shareOf } from "./montecarlo.js";

vi.setConfig({ testTimeout: 7_200_000 });

/**
 * Bug fixes rolled out with the bug's own error as a goal, on the standard medium plan, through the whole
 * simulated production. A change that fixes nothing must not be released as a fix more often than
 * `limits.goalAlpha` allows: the test fails when the low end of the released share's 95% interval is above
 * it. A real fix is measured, not asserted: how often it is shown to work before the last step's deadline.
 * Waiting for a goal keeps the last step watched longer, which costs some false alarms (evaluation.md).
 */

/** Each of these watches its last step to the deadline, so the quick suite runs few; `pnpm sim` runs hundreds. */
const TWO_DOZEN = 24,
  A_HANDFUL = 6,
  /** Seeds 9 and 11 moved on short of new people before a step's starting count waited for its watermark. */
  PAST_SEED_ELEVEN = 12,
  [NOTHING, ...FIXES] = GOALS,
  CASES = FIXES.map((scenario) => ({ name: scenario.name, runs: runsOr(scenario.name.includes("sized") ? PAST_SEED_ELEVEN : A_HANDFUL), scenario }));

describe("goals: a change that fixes nothing", () => {
  it("is not released as a fix more often than the goals' error budget allows", async () => {
    expect.hasAssertions();
    const verdict = await judgeScenario(NOTHING, runsOr(TWO_DOZEN)),
      released = shareOf(verdict.runs - verdict.notReleased.count, verdict.runs);
    expect(verdict.broken).toStrictEqual([]);
    expect(released.low).toBeLessThanOrEqual(goalAlphaOf(DEFAULT_LIMITS));
    expect(verdict.regression.low).toBeLessThanOrEqual(DEFAULT_LIMITS.alpha);
  });
});

describe("goals: a real fix", () => {
  it.each(CASES)("$name", async ({ runs, scenario }) => {
    expect.hasAssertions();
    const verdict = await judgeScenario(scenario, runs);
    expect(verdict.broken).toStrictEqual([]);
    expect(verdict.regression.low).toBeLessThanOrEqual(DEFAULT_LIMITS.alpha);
  });
});
