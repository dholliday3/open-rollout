import { FIRST_SHARE, METRIC, ROLLOUT_ID, benchPlan, recordOf, runFor, startedBench, treatmentShare } from "./bench";
import { describe, expect, it, vi } from "vitest";
import type { ArmSample } from "../stats";
import type { Guardrail } from "../plan";
import type { MetricSnapshot } from "../ports";
import { judge } from "../judge";

vi.setConfig({ testTimeout: 10_000 });

/**
 * What a metric source can answer that is not a measurement: totals that can't go together, numbers too
 * big to square, fields left out. README claim 2 (no step-up on missing or failing metrics) and claim 6
 * (healthy code is called worse with chance at most alpha) both depend on such an answer being read as
 * "nothing", never as "healthy" and never as "worse".
 */

const UNITS = 1000,
  A_TOUCH_MORE = 1001,
  PER_UNIT = 200,
  HUGE = 1e200,
  HUGE_SQUARED = 1e300,
  A_WHILE = 5,
  WHOLE_ROLLOUT = 45,
  HALF_AN_HOUR = 30,
  REQUESTS_EACH = 5,
  LATENCY: Guardrail = { direction: "lower_is_better", kind: "mean", metric: METRIC, onRegression: "rollback", tolerance: 0 },
  PLAN = benchPlan({ guardrails: [LATENCY] });

function snapshotOf(control: ArmSample, treatment: ArmSample): MetricSnapshot {
  return { asOf: 0, contaminated: 0, exposed: { control: control.units, treatment: treatment.units }, metrics: { [METRIC]: { control, treatment } }, watermark: 0 };
}

/** Every unit took exactly `PER_UNIT`, but for one on the new arm that took one more: no evidence of anything. */
function nearlyEqualArms(squares: ((sum: number) => number) | null): MetricSnapshot {
  const control = UNITS * PER_UNIT,
    treatment = UNITS * PER_UNIT + (A_TOUCH_MORE - UNITS);
  return snapshotOf({ sum: control, sumSquares: squares?.(control), units: UNITS }, { sum: treatment, sumSquares: squares?.(treatment), units: UNITS });
}

/** Something that is not a snapshot, passed off as one: what a source with a bug, or no types, hands over. */
function malformed(answer: unknown): MetricSnapshot {
  // eslint-disable-next-line typescript/no-unsafe-type-assertion -- the point is an answer that breaks its type
  return answer as MetricSnapshot;
}

/** The old arm makes five requests a person with the usual few errors; the new arm has an error for every person and no request at all. */
function errorsWithNoRequests(snapshot: MetricSnapshot): MetricSnapshot {
  const { control, treatment } = snapshot.exposed,
    errors = snapshot.metrics[METRIC].control.sum,
    requests = control * REQUESTS_EACH;
  return {
    ...snapshot,
    metrics: {
      [METRIC]: {
        control: { denominator: { crossSum: errors * REQUESTS_EACH, sum: requests, sumSquares: requests * REQUESTS_EACH }, sum: errors, sumSquares: errors, units: control },
        treatment: { denominator: { crossSum: 0, sum: 0, sumSquares: 0 }, sum: treatment, sumSquares: treatment, units: treatment },
      },
    },
  };
}

function withoutSquares(snapshot: MetricSnapshot): MetricSnapshot {
  const { control, treatment } = snapshot.metrics[METRIC];
  return { ...snapshot, metrics: { [METRIC]: { control: { sum: control.sum * PER_UNIT, units: control.units }, treatment: { sum: treatment.sum * PER_UNIT + 1, units: treatment.units } } } };
}

describe("claim 6: totals that are not a measurement are not a regression", () => {
  it("does not call an average worse when the source left its squares out", () => {
    expect.hasAssertions();
    expect(judge(PLAN, nearlyEqualArms(null)).regressions).toHaveLength(0);
  });

  it("does not call an average worse when its squares are smaller than its sum allows", () => {
    expect.hasAssertions();
    expect(judge(PLAN, nearlyEqualArms((sum) => sum)).regressions).toHaveLength(0);
  });

  it("does not call an average worse when its totals are too big to square", () => {
    expect.hasAssertions();
    const snapshot = snapshotOf({ sum: HUGE, sumSquares: HUGE_SQUARED, units: UNITS }, { sum: HUGE * 2, sumSquares: HUGE_SQUARED, units: UNITS });
    expect(judge(PLAN, snapshot).regressions).toHaveLength(0);
  });

  it("does not roll back healthy code because an average came without its squares", async () => {
    expect.hasAssertions();
    const bench = await startedBench({ plan: { guardrails: [LATENCY] } });
    bench.distort = withoutSquares;
    await runFor(bench, A_WHILE);
    expect(recordOf(bench).outcome?.reason).not.toBe("regression");
  });
});

/**
 * A ratio guardrail (errors per request) when the new code fails before it ever logs a request: every
 * person on the new arm has an error and nothing under the line. `ratioEstimate` gives no estimate for an
 * arm whose denominator is zero, so there is no reading, no regression, and the step just waits out its
 * patience and then reports "too little traffic". The worst reading a lower-is-better ratio can have is
 * treated as no reading.
 */
describe("a ratio with errors on the new arm and nothing under the line", () => {
  it("is acted on as a regression, not waited out as too little traffic", async () => {
    expect.hasAssertions();
    const bench = await startedBench({ plan: { guardrails: [{ ...LATENCY, kind: "ratio" }] } });
    bench.distort = errorsWithNoRequests;
    await runFor(bench, HALF_AN_HOUR);
    expect(recordOf(bench).outcome?.reason).toBe("regression");
    expect(treatmentShare(bench)).toBe(0);
  });
});

describe("claim 2: an answer that can't be right moves nothing forward", () => {
  it.each([
    ["a watermark of zero", (snapshot: MetricSnapshot): MetricSnapshot => ({ ...snapshot, watermark: 0 })],
    ["a watermark that is not a number", (snapshot: MetricSnapshot): MetricSnapshot => ({ ...snapshot, watermark: Number.NaN })],
    ["negative counts", (snapshot: MetricSnapshot): MetricSnapshot => ({ ...snapshot, exposed: { control: -UNITS, treatment: -UNITS } })],
    ["endless counts", (snapshot: MetricSnapshot): MetricSnapshot => ({ ...snapshot, exposed: { control: Number.POSITIVE_INFINITY, treatment: Number.POSITIVE_INFINITY } })],
    ["more units with the event than units", (snapshot: MetricSnapshot): MetricSnapshot => ({ ...snapshot, metrics: { [METRIC]: { control: { sum: UNITS, units: 1 }, treatment: { sum: UNITS, units: 1 } } } })],
    ["no exposure counts at all", (snapshot: MetricSnapshot): MetricSnapshot => malformed({ ...snapshot, exposed: null })],
    ["no metrics at all", (snapshot: MetricSnapshot): MetricSnapshot => malformed({ ...snapshot, metrics: null })],
    ["nothing", (): MetricSnapshot => malformed(null)],
  ])("holds the first step on %s, and every tick still completes", async (_name, distort) => {
    expect.hasAssertions();
    const bench = await startedBench();
    bench.distort = distort;
    await runFor(bench, WHOLE_ROLLOUT);
    await expect(bench.autopilot.tick(ROLLOUT_ID, bench.now)).resolves.toMatchObject({ status: "ticked" });
    expect(treatmentShare(bench)).toBe(FIRST_SHARE);
  });
});
