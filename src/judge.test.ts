import { describe, expect, it, vi } from "vitest";
import { judge, snapshotProblem } from "./judge";
import type { Guardrail } from "./plan";
import type { MetricSnapshot } from "./ports";
import { testPlan } from "./__tests__/world";

vi.setConfig({ testTimeout: 5000 });

const UNITS = 1000,
  FEW = 5,
  BASE = 100,
  WORSE = 200,
  A_BIT_WORSE = 140,
  MANY_MORE = 1400,
  LOTS_SEEN_TWICE = 100,
  JUST_ENOUGH = 10,
  FIFTY = 50,
  TWENTY = 20,
  PREFIX = "The numbers for errors can't be right",
  ERRORS: Guardrail = { direction: "lower_is_better", kind: "rate", metric: "errors", onRegression: "rollback", tolerance: 0 },
  SIGNUPS: Guardrail = { direction: "higher_is_better", kind: "rate", metric: "signups", onRegression: "pause", tolerance: 0 };

/** A snapshot where each arm has `units` and the given number of units with the event. */
function snapshot(counts: Record<string, [number, number]>, units = UNITS): MetricSnapshot {
  const metrics = Object.fromEntries(Object.entries(counts).map(([metric, [control, treatment]]) => [metric, { control: { sum: control, units }, treatment: { sum: treatment, units } }]));
  return { asOf: 0, contaminated: 0, exposed: { control: units, treatment: units }, metrics, watermark: 0 };
}

/** A snapshot where each arm has `each` units and `contaminated` more were seen on both. */
function seen(each: number, contaminated: number): MetricSnapshot {
  return { ...snapshot({ errors: [0, 0] }), contaminated, exposed: { control: each, treatment: each } };
}

describe("judging a snapshot", () => {
  it("calls a doubled error rate a regression, with both arms' readings", () => {
    expect.hasAssertions();
    const judgement = judge(testPlan(), snapshot({ errors: [BASE, WORSE] }));
    expect(judgement.regressions).toHaveLength(1);
    expect(judgement.regressions[0].finding).toMatchObject({ control: 0.1, metric: "errors", treatment: 0.2, units: { control: UNITS, treatment: UNITS } });
  });

  it("calls a higher-is-better metric a regression when it drops, not when it rises", () => {
    expect.hasAssertions();
    const plan = testPlan({ guardrails: [SIGNUPS] });
    expect(judge(plan, snapshot({ signups: [WORSE, BASE] })).regressions).toHaveLength(1);
    expect(judge(plan, snapshot({ signups: [BASE, WORSE] })).regressions).toHaveLength(0);
  });

  it("lets through a gap inside the tolerance", () => {
    expect.hasAssertions();
    const plan = testPlan({ guardrails: [{ ...ERRORS, tolerance: 0.2 }] });
    expect(judge(plan, snapshot({ errors: [BASE, WORSE] })).regressions).toHaveLength(0);
  });

  it("reads nothing from an arm with too few units, or from a metric the source left out", () => {
    expect.hasAssertions();
    expect(judge(testPlan(), snapshot({ errors: [0, FEW] }, FEW)).findings).toHaveLength(0);
    expect(judge(testPlan(), snapshot({})).findings).toHaveLength(0);
  });

  it("asks for stronger evidence from each guardrail when there are more of them", () => {
    expect.hasAssertions();
    const alone = judge(testPlan(), snapshot({ errors: [BASE, A_BIT_WORSE] })),
      among = judge(testPlan({ guardrails: [ERRORS, SIGNUPS] }), snapshot({ errors: [BASE, A_BIT_WORSE], signups: [BASE, BASE] }));
    expect(among.findings[0].difference.lower).toBeLessThan(alone.findings[0].difference.lower);
  });

  it("flags arms of different sizes, and units seen on both", () => {
    expect.hasAssertions();
    const lopsided = { ...snapshot({ errors: [BASE, BASE] }), exposed: { control: MANY_MORE, treatment: UNITS } },
      mixed = { ...snapshot({ errors: [BASE, BASE] }), contaminated: LOTS_SEEN_TWICE };
    expect(judge(testPlan(), lopsided).mismatched).toBe(true);
    expect(judge(testPlan(), mixed).contaminated).toBe(true);
    expect(judge(testPlan(), snapshot({ errors: [BASE, BASE] }))).toMatchObject({ contaminated: false, mismatched: false });
  });
});

describe("judging at the edges", () => {
  it("reads a guardrail once both arms have exactly the least units, and not while either is short", () => {
    expect.hasAssertions();
    const short = { ...snapshot({ errors: [1, 1] }, JUST_ENOUGH), metrics: { errors: { control: { sum: 1, units: UNITS }, treatment: { sum: 1, units: FEW } } } };
    expect(judge(testPlan(), snapshot({ errors: [1, 1] }, JUST_ENOUGH)).findings).toHaveLength(1);
    expect(judge(testPlan(), short).findings).toHaveLength(0);
  });

  it("reads nothing when only one arm can be estimated", () => {
    expect.hasAssertions();
    const ratio = testPlan({ guardrails: [{ ...ERRORS, kind: "ratio" }] }),
      top = { sum: BASE, sumSquares: BASE, units: UNITS },
      under = { crossSum: BASE, sum: UNITS, sumSquares: UNITS },
      oneSided = { ...snapshot({}), metrics: { errors: { control: { ...top, denominator: under }, treatment: top } } };
    expect(judge(ratio, oneSided).findings).toHaveLength(0);
  });

  it("lets a higher-is-better metric drop inside its tolerance, and no further", () => {
    expect.hasAssertions();
    const tolerant = testPlan({ guardrails: [{ ...SIGNUPS, tolerance: 0.2 }] });
    expect(judge(tolerant, snapshot({ signups: [WORSE, BASE] })).regressions).toHaveLength(0);
    expect(judge(tolerant, snapshot({ signups: [UNITS, BASE] })).regressions).toHaveLength(1);
  });

  it("calls units seen on both arms a problem only above the plan's share of everyone seen, and never for a handful", () => {
    expect.hasAssertions();
    expect(judge(testPlan(), seen(UNITS, TWENTY)).contaminated).toBe(false);
    expect(judge(testPlan(), seen(UNITS, TWENTY + 1)).contaminated).toBe(true);
    expect(judge(testPlan(), seen(FIFTY, FEW)).contaminated).toBe(false);
    expect(judge(testPlan(), seen(0, 0)).contaminated).toBe(false);
  });

  it("calls a reading inconclusive until it has ruled out what its guardrail must rule out", () => {
    expect.hasAssertions();
    const strict = testPlan({ guardrails: [{ ...ERRORS, mustRuleOut: 0.02 }] }),
      loose = testPlan({ guardrails: [{ ...ERRORS, mustRuleOut: 0.5 }] });
    expect(judge(strict, snapshot({ errors: [BASE, BASE] })).findings[0].conclusive).toBe(false);
    expect(judge(loose, snapshot({ errors: [BASE, BASE] })).findings[0].conclusive).toBe(true);
    expect(judge(testPlan(), snapshot({ errors: [BASE, BASE] })).findings[0].conclusive).toBe(true);
  });
});

describe("a ratio the new arm has broken", () => {
  const ratio = testPlan({ guardrails: [{ ...ERRORS, kind: "ratio" }] }),
    under = { crossSum: BASE, sum: UNITS, sumSquares: UNITS },
    nothingUnder = { crossSum: 0, sum: 0, sumSquares: 0 },
    top = { sum: BASE, sumSquares: BASE, units: UNITS },
    arms = (control: typeof under, treatment: typeof under): MetricSnapshot => ({ ...snapshot({}), metrics: { errors: { control: { ...top, denominator: control }, treatment: { ...top, denominator: treatment } } } });

  it("is called out when the new arm has errors and no requests while the old arm has both", () => {
    expect.hasAssertions();
    expect(judge(ratio, arms(under, nothingUnder)).broken).toHaveLength(1);
    expect(judge(ratio, arms(under, under)).broken).toHaveLength(0);
  });

  it("is not called out when the old arm is the one with nothing under the line, or when there are only a few events", () => {
    expect.hasAssertions();
    const few = { ...arms(under, nothingUnder).metrics.errors, treatment: { ...top, denominator: nothingUnder, sum: FEW } };
    expect(judge(ratio, arms(nothingUnder, under)).broken).toHaveLength(0);
    expect(judge(ratio, { ...snapshot({}), metrics: { errors: few } }).broken).toHaveLength(0);
  });
});

describe("a snapshot that can't be used", () => {
  const good = snapshot({ errors: [BASE, BASE] }),
    arm = { sum: BASE, units: UNITS },
    withTreatment = (treatment: object): MetricSnapshot => ({ ...good, metrics: { errors: { control: arm, treatment: { ...arm, ...treatment } } } });

  it("has no problem when every count is a count, and lets an average's total be more than its units", () => {
    expect.hasAssertions();
    const average = { sum: UNITS + UNITS, sumSquares: UNITS * FEW, units: UNITS };
    expect(snapshotProblem(testPlan(), good)).toBeNull();
    expect(snapshotProblem(testPlan({ guardrails: [{ ...ERRORS, kind: "mean" }] }), { ...good, metrics: { errors: { control: average, treatment: average } } })).toBeNull();
  });

  it("names the metric the source left out", () => {
    expect.hasAssertions();
    expect(snapshotProblem(testPlan({ guardrails: [ERRORS, SIGNUPS] }), good)).toBe("The metrics say nothing about signups.");
  });

  it("refuses a watermark or a count of units that isn't a number, or is below nothing", () => {
    expect.hasAssertions();
    const broken = [{ watermark: Number.NaN }, { asOf: Number.NaN }, { watermark: 1 }, { contaminated: -1 }, { exposed: { control: Number.NaN, treatment: 1 } }, { exposed: { control: 1, treatment: -1 } }];
    expect(broken.map((part) => snapshotProblem(testPlan(), { ...good, ...part }))).toStrictEqual(broken.map(() => "The metrics' counts or watermark can't be right."));
  });

  it("refuses one arm's numbers that can't be right, even when the other arm's are fine", () => {
    expect.hasAssertions();
    const broken = [{ units: -1 }, { sum: Number.NaN }, { sum: UNITS + 1 }, { sum: -1 }];
    expect(broken.map((part) => snapshotProblem(testPlan(), withTreatment(part))?.slice(0, PREFIX.length))).toStrictEqual(broken.map(() => PREFIX));
  });

  it("refuses an average without its squares, or with squares too small for its total", () => {
    expect.hasAssertions();
    const mean = testPlan({ guardrails: [{ ...ERRORS, kind: "mean" }] }),
      broken = [{}, { sumSquares: 1 }, { sumSquares: Number.NaN }];
    expect(broken.map((part) => snapshotProblem(mean, withTreatment(part)))).toStrictEqual(broken.map(() => "The numbers for errors can't be right: its sum of squares is missing or too small for its total."));
  });

  it("refuses a ratio with nothing under the line given, or with totals there that don't go together", () => {
    expect.hasAssertions();
    const ratio = testPlan({ guardrails: [{ ...ERRORS, kind: "ratio" }] }),
      under = { crossSum: BASE, sum: UNITS, sumSquares: UNITS },
      top = { sum: BASE, sumSquares: BASE, units: UNITS },
      against = (treatment: object): MetricSnapshot => ({ ...good, metrics: { errors: { control: { ...top, denominator: under }, treatment: { ...top, ...treatment } } } }),
      broken = [{ denominator: { ...under, sum: -1 } }, { denominator: { ...under, crossSum: Number.NaN } }, { denominator: { ...under, sumSquares: 1 } }];
    expect(snapshotProblem(ratio, against({ denominator: under }))).toBeNull();
    expect(snapshotProblem(ratio, against({}))).toBe("The numbers for errors can't be right: a ratio needs what is under the line.");
    expect(broken.map((part) => snapshotProblem(ratio, against(part)))).toStrictEqual(broken.map(() => "The numbers for errors can't be right: the totals under the line don't go together."));
  });
});
