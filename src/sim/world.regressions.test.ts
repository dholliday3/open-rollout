import { describe, expect, it, vi } from "vitest";
import { REGRESSIONS } from "./scenarios.js";
import { judgeScenario } from "./report.js";
import { runsOr } from "./runs.js";

vi.setConfig({ testTimeout: 7_200_000 });

/**
 * New code that really is worse, in each of the ways `effects.ts` lists, rolled out through the simulated
 * production on the standard medium-risk plan. This measures power: what share of rollouts are stopped,
 * how long that takes, how many people were on the new behaviour by then, and how many were still served it
 * after the rollback was decided (evaluators learn of a change late; a phone keeps what it fetched).
 *
 * The numbers are printed for the report. The assertions are only the ones nobody would argue with: gross
 * regressions are always stopped, no run breaks claims 1 and 2 against the truth, and nobody is served the
 * new behaviour after a rollback has settled.
 */

const A_HANDFUL = 6,
  RUNS = runsOr(A_HANDFUL),
  ALWAYS = 1,
  /** Regressions large enough that missing one would be a bug, not a question of power. */
  GROSS = new Set(["regression: outage", "regression: segment", "regression: exposure_loss", "regression: outage, provider down from minute 1 to 6", "regression: outage, metric source down from minute 1 to 13"]),
  CASES = REGRESSIONS.map((scenario) => ({ floor: GROSS.has(scenario.name) ? ALWAYS : 0, name: scenario.name, scenario }));

describe("power: new code that is worse", () => {
  it.each(CASES)("$name", async ({ scenario, floor }) => {
    expect.hasAssertions();
    const verdict = await judgeScenario(scenario, RUNS);
    expect(verdict.broken).toStrictEqual([]);
    expect(verdict.notReleased.share).toBeGreaterThanOrEqual(floor);
  });
});
