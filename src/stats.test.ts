import type { ArmSample, Interval, MetricKind, SequenceTuning } from "./stats";
import { describe, expect, it, vi } from "vitest";
import { differenceInterval, estimateArm, isSampleRatioMismatch } from "./stats";
import type { Random } from "./sim/random";
import { createRandom } from "./sim/random";

vi.setConfig({ testTimeout: 60_000 });

interface Totals {
  units: number;
  sum: number;
  sumSquares: number;
  denominatorSum: number;
  denominatorSquares: number;
  crossSum: number;
}

interface Draw {
  value: number;
  denominator: number;
}

type Arm = "control" | "treatment";
type DrawFor = (random: Random) => (arm: Arm) => Draw;

const ALPHA = 0.05,
  TUNING: SequenceTuning = { alpha: ALPHA, tuneAtUnits: 1000 },
  SRM_TUNING: SequenceTuning = { alpha: 0.001, tuneAtUnits: 1000 },
  RUNS = 400,
  UNITS_PER_ARM = 4000,
  SRM_UNITS = 20_000,
  LOOK_EVERY = 20,
  BASE_RATE = 0.05,
  DOUBLE_RATE = 0.1,
  MOST = 0.9,
  FAIR = 0.5,
  LOST_SHARE = 0.1,
  TEN = 10,
  THREE = 3,
  THIRTY = 30,
  /** A person's own error rate varies around the base, so one person's requests fail together. */
  PERSON_SPREAD = 2,
  HEAVY_SHARE = 0.1,
  HEAVY_REQUESTS = 200,
  LIGHT_REQUESTS = 3,
  NOTHING: Totals = { crossSum: 0, denominatorSquares: 0, denominatorSum: 0, sum: 0, sumSquares: 0, units: 0 };

function add(totals: Totals, draw: Draw): void {
  totals.units += 1;
  totals.sum += draw.value;
  totals.sumSquares += draw.value * draw.value;
  totals.denominatorSum += draw.denominator;
  totals.denominatorSquares += draw.denominator * draw.denominator;
  totals.crossSum += draw.value * draw.denominator;
}

function sampleOf(totals: Totals): ArmSample {
  return {
    denominator: { crossSum: totals.crossSum, sum: totals.denominatorSum, sumSquares: totals.denominatorSquares },
    sum: totals.sum,
    sumSquares: totals.sumSquares,
    units: totals.units,
  };
}

function intervalOf(kind: MetricKind, control: Totals, treatment: Totals): Interval | null {
  const before = estimateArm(kind, sampleOf(control)),
    after = estimateArm(kind, sampleOf(treatment));
  return before === null || after === null ? null : differenceInterval(before, after, TUNING);
}

function calledWorse(kind: MetricKind, control: Totals, treatment: Totals): boolean {
  return (intervalOf(kind, control, treatment)?.lower ?? 0) > 0;
}

/** One person's errors and requests: a few people make most of the requests, and each has their own bad luck. */
function person(random: Random, rate: number): Draw {
  const requests = random.chance(HEAVY_SHARE) ? HEAVY_REQUESTS : LIGHT_REQUESTS,
    own = Math.min(1, rate * Math.exp(PERSON_SPREAD * random.normal()));
  let errors = 0;
  for (let request = 0; request < requests; request += 1) {
    errors += random.chance(own) ? 1 : 0;
  }
  return { denominator: requests, value: errors };
}

/** Runs one rollout's worth of looks and says whether the new arm was ever called worse. */
function everCalledWorse(kind: MetricKind, draw: (arm: Arm) => Draw): boolean {
  const control = { ...NOTHING },
    treatment = { ...NOTHING };
  for (let unit = 1; unit <= UNITS_PER_ARM; unit += 1) {
    add(control, draw("control"));
    add(treatment, draw("treatment"));
    if (unit % LOOK_EVERY === 0 && calledWorse(kind, control, treatment)) {
      return true;
    }
  }
  return false;
}

function shareCalledWorse(kind: MetricKind, drawFor: DrawFor): number {
  let alarms = 0;
  for (let run = 0; run < RUNS; run += 1) {
    alarms += everCalledWorse(kind, drawFor(createRandom(run + 1))) ? 1 : 0;
  }
  return alarms / RUNS;
}

function rateOf(random: Random, rate: number): Draw {
  return { denominator: 1, value: random.chance(rate) ? 1 : 0 };
}

/** The same people as `person`, but every request counted as a unit of its own. */
function requestsAsUnits(random: Random): Draw & { units: number } {
  const { denominator, value } = person(random, BASE_RATE);
  return { denominator, units: denominator, value };
}

function everCalledWorseCountingRequests(random: Random): boolean {
  const control = { ...NOTHING },
    treatment = { ...NOTHING };
  for (let unit = 1; unit <= UNITS_PER_ARM; unit += 1) {
    for (const totals of [control, treatment]) {
      const drawn = requestsAsUnits(random);
      totals.units += drawn.units;
      totals.sum += drawn.value;
    }
    if (unit % LOOK_EVERY === 0 && calledWorse("rate", control, treatment)) {
      return true;
    }
  }
  return false;
}

function shareCalledWorseCountingRequests(): number {
  let alarms = 0;
  for (let run = 0; run < RUNS; run += 1) {
    alarms += everCalledWorseCountingRequests(createRandom(run + 1)) ? 1 : 0;
  }
  return alarms / RUNS;
}

/** An even split where the new arm keeps only `keep` of its units; true if the check ever fires. */
function everMismatched(random: Random, keep: number): boolean {
  const units = { control: 0, treatment: 0 };
  for (let unit = 1; unit <= SRM_UNITS; unit += 1) {
    if (random.chance(FAIR)) {
      units.control += 1;
    } else if (random.chance(keep)) {
      units.treatment += 1;
    }
    if (unit % LOOK_EVERY === 0 && isSampleRatioMismatch(units, SRM_TUNING)) {
      return true;
    }
  }
  return false;
}

function fairSplitAlarms(): number {
  let alarms = 0;
  for (let run = 0; run < RUNS; run += 1) {
    alarms += everMismatched(createRandom(run + 1), 1) ? 1 : 0;
  }
  return alarms;
}

describe("a guardrail's call under repeated looks", () => {
  it("rarely calls an unchanged rate worse, however often it looks", () => {
    expect.hasAssertions();
    expect(shareCalledWorse("rate", (random) => () => rateOf(random, BASE_RATE))).toBeLessThanOrEqual(ALPHA);
  });

  it("calls a doubled error rate worse in most rollouts", () => {
    expect.hasAssertions();
    const rates = { control: BASE_RATE, treatment: DOUBLE_RATE };
    expect(shareCalledWorse("rate", (random) => (arm) => rateOf(random, rates[arm]))).toBeGreaterThan(MOST);
  });

  it("rarely calls an unchanged average worse", () => {
    expect.hasAssertions();
    expect(shareCalledWorse("mean", (random) => () => ({ denominator: 1, value: Math.exp(random.normal()) }))).toBeLessThanOrEqual(ALPHA);
  });

  it("rarely calls an unchanged errors-per-request ratio worse when a few people make most requests", () => {
    expect.hasAssertions();
    expect(shareCalledWorse("ratio", (random) => () => person(random, BASE_RATE))).toBeLessThanOrEqual(ALPHA);
  });

  it("would cry wolf on the same people if every request were counted as its own unit", () => {
    expect.hasAssertions();
    // The reason a ratio metric exists: one person's requests fail together, so counting requests overstates the evidence.
    expect(shareCalledWorseCountingRequests()).toBeGreaterThan(ALPHA);
  });
});

describe("a guardrail's call on little data", () => {
  it("does not call three errors in ten against none in ten", () => {
    expect.hasAssertions();
    expect(intervalOf("rate", { ...NOTHING, units: TEN }, { ...NOTHING, sum: THREE, units: TEN })?.lower).toBeLessThan(0);
  });

  it("calls an arm where everything fails within thirty units", () => {
    expect.hasAssertions();
    expect(intervalOf("rate", { ...NOTHING, units: THIRTY }, { ...NOTHING, sum: THIRTY, units: THIRTY })?.lower).toBeGreaterThan(0);
  });

  it("has no estimate for one unit, or for a ratio with nothing under the line", () => {
    expect.hasAssertions();
    expect(estimateArm("mean", { sum: 1, sumSquares: 1, units: 1 })).toBeNull();
    expect(estimateArm("ratio", { denominator: { crossSum: 0, sum: 0, sumSquares: 0 }, sum: 0, sumSquares: 0, units: TEN })).toBeNull();
    expect(estimateArm("ratio", { sum: 0, units: TEN })).toBeNull();
  });
});

describe("the sample ratio check", () => {
  it("stays quiet on an even split, however often it looks", () => {
    expect.hasAssertions();
    expect(fairSplitAlarms()).toBe(0);
  });

  it("catches an arm that loses a tenth of its units", () => {
    expect.hasAssertions();
    expect(everMismatched(createRandom(1), 1 - LOST_SHARE)).toBe(true);
  });

  it("says nothing before anyone has arrived", () => {
    expect.hasAssertions();
    expect(isSampleRatioMismatch({ control: 0, treatment: 0 }, SRM_TUNING)).toBe(false);
  });
});
