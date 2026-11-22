import type { Scenario, Share, Summary } from "./montecarlo.js";
import { evidenceShortfalls, writesNobodyAskedFor } from "./oracle.js";
import { median, runMany, shareOf } from "./montecarlo.js";
import type { Outcome } from "./driver.js";
import type { World } from "./world.js";

/**
 * Runs a scenario many times and reads the results the way the report wants them: how often the library
 * acted and why, how long a regression took to catch, how many people it reached first, and whether any
 * run broke a claim against the truth.
 */

interface Verdict {
  readonly name: string;
  readonly runs: number;
  readonly endings: Readonly<Record<string, number>>;
  /** Runs where a guardrail called the new code worse (a rollback or a pause for a regression). */
  readonly regression: Share;
  readonly sampleRatio: Share;
  /** Runs that ended any way but a completed release. */
  readonly notReleased: Share;
  readonly medianMinutesToDecision: number | null;
  readonly medianExposedBeforeDecision: number | null;
  readonly medianServedAfterDecision: number | null;
  readonly worstServedAfterSettled: number;
  /** Sentences from the oracle, each with its seed. */
  readonly broken: readonly string[];
}

const MINUTE = 60_000,
  PERCENT = 100;

function count(summary: Summary, ending: string): number {
  return summary.endings[ending] ?? 0;
}

function decided(outcomes: readonly Outcome[]): Outcome[] {
  return outcomes.filter((outcome) => outcome.decidedAfterMs !== null);
}

function verdictOf(summary: Summary, broken: readonly string[]): Verdict {
  const caught = decided(summary.outcomes);
  return {
    broken,
    endings: summary.endings,
    medianExposedBeforeDecision: median(caught.map((outcome) => outcome.exposedBeforeDecision)),
    medianMinutesToDecision: median(caught.map((outcome) => (outcome.decidedAfterMs ?? 0) / MINUTE)),
    medianServedAfterDecision: median(caught.map((outcome) => outcome.servedAfterDecision)),
    name: summary.name,
    notReleased: shareOf(summary.runs - count(summary, "completed"), summary.runs),
    regression: shareOf(count(summary, "regression"), summary.runs),
    runs: summary.runs,
    sampleRatio: shareOf(count(summary, "sample_ratio_mismatch"), summary.runs),
    worstServedAfterSettled: Math.max(0, ...summary.outcomes.map((outcome) => outcome.servedAfterSettled)),
  };
}

function asPercent(share: Share): string {
  return `${(share.share * PERCENT).toFixed(1)}% [${(share.low * PERCENT).toFixed(1)}, ${(share.high * PERCENT).toFixed(1)}]`;
}

/** One line for the report: the scenario, how its runs ended, and the numbers behind the table. */
function lineOf(verdict: Verdict): string {
  return [
    `## ${verdict.name}`,
    `runs ${verdict.runs}`,
    JSON.stringify(verdict.endings),
    `regression ${asPercent(verdict.regression)}`,
    `sample ratio ${asPercent(verdict.sampleRatio)}`,
    `minutes to decision ${verdict.medianMinutesToDecision?.toFixed(1) ?? "-"}`,
    `exposed before ${verdict.medianExposedBeforeDecision ?? "-"}`,
    `served after ${verdict.medianServedAfterDecision ?? "-"}`,
    `worst served after settled ${verdict.worstServedAfterSettled}`,
    `broken ${verdict.broken.length}`,
  ].join(" | ");
}

/** Runs a scenario and judges it; every world is also checked by the oracle before it is thrown away. */
async function judgeScenario(scenario: Scenario, runs: number): Promise<Verdict> {
  const broken: string[] = [],
    inspect = (world: World, seed: number): void => {
      broken.push(...[...evidenceShortfalls(world), ...writesNobodyAskedFor(world)].map((problem) => `seed ${seed}: ${problem}`));
    },
    summary = await runMany({ ...scenario, inspect }, runs),
    verdict = verdictOf(summary, broken);
  // eslint-disable-next-line no-console -- the numbers are the result
  console.log(lineOf(verdict));
  return verdict;
}

export type { Verdict };
export { judgeScenario, lineOf };
