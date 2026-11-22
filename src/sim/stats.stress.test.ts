import { CONVERSION, ERRORS, ERRORS_PER_UNIT, ERROR_RATIO, LATENCY, shareOf } from "./montecarlo";
import { binomial, logNormal, pareto, poisson } from "./draws";
import { describe, expect, it, vi } from "vitest";
import type { ArmSample } from "../stats";
import type { Guardrail } from "../plan";
import type { MetricSnapshot } from "../ports";
import type { Random } from "./random";
import { createRandom } from "./random";
import { judge } from "../judge";
import { low } from "./scenarios";
import { runsOr } from "./runs";

vi.setConfig({ testTimeout: 3_600_000 });

/**
 * README claim 6, on the statistics alone: healthy code, two arms drawn from the same people, a look
 * after every few visits, and the question "was the new arm ever called worse?". The people are the ones
 * the world in `population.ts` has: a power-law few make most of the requests, each has their own error
 * rate, and the active come back, so their totals keep growing. No pipeline, no lag, no flag: if the share
 * of alarms here is above `limits.alpha`, it is the test that is wrong, not the plumbing.
 *
 * `SIM_RUNS` sets how many rollouts each case gets (default 300).
 */

/** What one visit adds. */
interface Person {
  readonly requests: number;
  readonly errors: number;
  readonly latency: number;
  readonly converted: number;
}

interface Arm {
  units: number;
  hadError: number;
  converted: number;
  errors: number;
  errorsSquared: number;
  requests: number;
  requestsSquared: number;
  cross: number;
  latency: number;
  latencySquared: number;
  readonly regulars: Regular[];
  /** One entry per chance of coming back: the active hold more of them. */
  readonly tickets: number[];
}

interface People {
  /** Power-law tail of requests per person. */
  readonly activityShape: number;
  readonly activityCap: number;
  readonly errorChance: number;
  /** Spread of a person's own error rate, as a log-normal sigma. */
  readonly errorSpread: number;
  /** Share of visits made by someone already counted: the active come back most, and what they do adds to their own totals. */
  readonly comeBack: number;
  /** The new arm gets one visit for this many on the old arm: 1 for arms of the same size. */
  readonly controlVisitsPerTreatment: number;
}

/** Someone already on an arm, who may come back. */
interface Regular {
  readonly activity: number;
  readonly errorChance: number;
  errors: number;
  requests: number;
}

const THREE_HUNDRED = 300,
  RUNS = runsOr(THREE_HUNDRED),
  PERCENT = 100,
  ALPHA = 0.05,
  VISITS_PER_ARM = 4000,
  LOOK_EVERY = 5,
  LATENCY_MS = 200,
  LATENCY_SPREAD = 0.5,
  CONVERSION_RATE = 0.08,
  MOST_TICKETS = 40,
  ACTIVITY_PER_TICKET = 3,
  ONE_VISIT_EACH: People = { activityCap: 400, activityShape: 1.3, comeBack: 0, controlVisitsPerTreatment: 1, errorChance: 0.004, errorSpread: 1.2 },
  FOUR_TO_ONE = 4,
  LOPSIDED: People = { ...ONE_VISIT_EACH, comeBack: 0.45, controlVisitsPerTreatment: FOUR_TO_ONE },
  MORE_IS_BETTER: Guardrail = { direction: "higher_is_better", kind: "ratio", metric: "error_ratio", onRegression: "rollback", tolerance: 0 },
  AS_THE_WORLD: People = { ...ONE_VISIT_EACH, comeBack: 0.45 },
  NO_BIG_SPENDERS: People = { ...AS_THE_WORLD, activityCap: 10 };

/** One visit's requests, errors and latency from someone with this activity and error rate. */
function visit(random: Random, regular: Regular): Person {
  const requests = 1 + poisson(random, regular.activity),
    errors = binomial(random, requests, regular.errorChance);
  return { converted: random.chance(CONVERSION_RATE) ? 1 : 0, errors, latency: requests * logNormal(random, LATENCY_MS, LATENCY_SPREAD), requests };
}

function emptyArm(): Arm {
  return { converted: 0, cross: 0, errors: 0, errorsSquared: 0, hadError: 0, latency: 0, latencySquared: 0, regulars: [], requests: 0, requestsSquared: 0, tickets: [], units: 0 };
}

/** Adds a person's totals to their arm (`sign` 1) or takes them back out (`sign` -1), so a returning person can be counted afresh. */
function tally(arm: Arm, one: { errors: number; requests: number }, sign: number): void {
  arm.hadError += one.errors > 0 ? sign : 0;
  arm.errors += sign * one.errors;
  arm.errorsSquared += sign * one.errors * one.errors;
  arm.requests += sign * one.requests;
  arm.requestsSquared += sign * one.requests * one.requests;
  arm.cross += sign * one.errors * one.requests;
}

/** Counts a new person and their first visit on the arm. */
function admit(arm: Arm, regular: Regular, first: Person): void {
  arm.units += 1;
  arm.converted += first.converted;
  arm.latency += first.latency;
  arm.latencySquared += first.latency * first.latency;
  tally(arm, regular, 1);
  arm.regulars.push(regular);
  for (let ticket = 0; ticket < Math.min(MOST_TICKETS, Math.ceil(regular.activity / ACTIVITY_PER_TICKET)); ticket += 1) {
    arm.tickets.push(arm.regulars.length - 1);
  }
}

/** Someone new arrives on the arm and makes their first visit. */
function arrive(random: Random, arm: Arm, people: People): void {
  const activity = Math.min(people.activityCap, pareto(random, 1, people.activityShape)),
    regular: Regular = { activity, errorChance: Math.min(1, people.errorChance * logNormal(random, 1, people.errorSpread)), errors: 0, requests: 0 },
    first = visit(random, regular);
  regular.errors = first.errors;
  regular.requests = first.requests;
  admit(arm, regular, first);
}

/** Someone already on the arm comes back, and what they do is added to their own totals. */
function comeBack(random: Random, arm: Arm): void {
  const regular = arm.regulars[arm.tickets[Math.min(arm.tickets.length - 1, Math.floor(random.next() * arm.tickets.length))]],
    again = visit(random, regular);
  tally(arm, regular, -1);
  regular.errors += again.errors;
  regular.requests += again.requests;
  tally(arm, regular, 1);
}

/** The arm's next visit: someone new, or someone back again. */
function add(random: Random, arm: Arm, people: People): void {
  if (arm.regulars.length > 0 && random.chance(people.comeBack)) {
    comeBack(random, arm);
  } else {
    arrive(random, arm, people);
  }
}

function samplesOf(arm: Arm): Record<string, ArmSample> {
  return {
    conversion: { sum: arm.converted, units: arm.units },
    error_ratio: { denominator: { crossSum: arm.cross, sum: arm.requests, sumSquares: arm.requestsSquared }, sum: arm.errors, sumSquares: arm.errorsSquared, units: arm.units },
    errors: { sum: arm.hadError, units: arm.units },
    errors_per_unit: { sum: arm.errors, sumSquares: arm.errorsSquared, units: arm.units },
    latency: { sum: arm.latency, sumSquares: arm.latencySquared, units: arm.units },
  };
}

function snapshotOf(control: Arm, treatment: Arm): MetricSnapshot {
  const before = samplesOf(control),
    after = samplesOf(treatment),
    metrics = Object.fromEntries(Object.keys(before).map((name) => [name, { control: before[name], treatment: after[name] }]));
  return { asOf: 0, contaminated: 0, exposed: { control: control.units, treatment: treatment.units }, metrics, watermark: 0 };
}

/** One healthy rollout's worth of looks; true if any guardrail ever called the new arm worse. */
function everCalledWorse(random: Random, guardrails: readonly Guardrail[], people: People): boolean {
  const plan = low(guardrails),
    control = emptyArm(),
    treatment = emptyArm();
  for (let look = 1; look <= VISITS_PER_ARM; look += 1) {
    add(random, control, people);
    if (look % people.controlVisitsPerTreatment === 0) {
      add(random, treatment, people);
    }
    if (look % LOOK_EVERY === 0 && judge(plan, snapshotOf(control, treatment)).regressions.length > 0) {
      return true;
    }
  }
  return false;
}

function alarms(guardrails: readonly Guardrail[], people: People): ReturnType<typeof shareOf> {
  let count = 0;
  for (let run = 1; run <= RUNS; run += 1) {
    count += everCalledWorse(createRandom(run * LATENCY_MS + 1), guardrails, people) ? 1 : 0;
  }
  const share = shareOf(count, RUNS);
  // eslint-disable-next-line no-console -- the numbers are the result
  console.log(`false alarms | ${guardrails.map((guardrail) => guardrail.metric).join("+")} | cap ${people.activityCap}, spread ${people.errorSpread}, come back ${people.comeBack} | ${count}/${RUNS} = ${(share.share * PERCENT).toFixed(1)}% [${(share.low * PERCENT).toFixed(1)}, ${(share.high * PERCENT).toFixed(1)}]`);
  return share;
}

describe("claim 6: healthy code under repeated looks, people as heavy-tailed as real ones", () => {
  it.each([
    ["the share of people with an error", [ERRORS]],
    ["the share of people who convert, where higher is better", [CONVERSION]],
    ["errors per person", [ERRORS_PER_UNIT]],
    ["latency per person", [LATENCY]],
    ["errors per request", [ERROR_RATIO]],
    ["all five at once", [ERRORS, CONVERSION, ERRORS_PER_UNIT, LATENCY, ERROR_RATIO]],
  ])("is not called worse on %s more often than alpha allows", (_name, guardrails) => {
    expect.hasAssertions();
    // The interval's low end above alpha means the rate is over budget beyond what chance explains.
    expect(alarms(guardrails, AS_THE_WORLD).low).toBeLessThanOrEqual(ALPHA);
  });

  it("holds its error rate on a ratio when the arms are not the same size, and when higher is better", () => {
    expect.hasAssertions();
    expect(alarms([ERROR_RATIO], LOPSIDED).low).toBeLessThanOrEqual(ALPHA);
    expect(alarms([MORE_IS_BETTER], AS_THE_WORLD).low).toBeLessThanOrEqual(ALPHA);
    expect(alarms([MORE_IS_BETTER], LOPSIDED).low).toBeLessThanOrEqual(ALPHA);
  });

  it("holds its error rate on errors per request when nobody comes back, or nobody makes many requests", () => {
    expect.hasAssertions();
    expect(alarms([ERROR_RATIO], ONE_VISIT_EACH).low).toBeLessThanOrEqual(ALPHA);
    expect(alarms([ERROR_RATIO], NO_BIG_SPENDERS).low).toBeLessThanOrEqual(ALPHA);
  });
});
