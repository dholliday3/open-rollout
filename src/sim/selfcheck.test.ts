import { DEFAULT_POPULATION, createPopulation } from "./population";
import { EVERYBODY, measuredStep } from "../allocation";
import { armOf, createEvaluators } from "./evaluators";
import { binomial, logNormal, pareto, poisson } from "./draws";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_WORLD } from "./world.options";
import type { Identity } from "./population";
import type { World } from "./world";
import { advanceWorld } from "./traffic";
import { benchPlan } from "./bench";
import { createRandom } from "./random";
import { createWorld } from "./world";

vi.setConfig({ testTimeout: 60_000 });

/**
 * Checks on the simulator itself. A break found in a world that is wrong is noise, so before the library
 * is blamed for anything: the draws have the moments they should, the provider's bucketing is sticky and
 * its two hashes are independent, and the pipeline's counts come out equal to the truth once every event
 * has arrived.
 */

const DRAWS = 40_000,
  PEOPLE = 40_000,
  SEED = 11,
  MEAN = 7,
  TRIALS = 25,
  CHANCE = 0.2,
  MEDIAN = 200,
  SHAPE = 1.3,
  TENTH = 1000,
  HALF = 5000,
  CLOSE = 2,
  TEN_MINUTES = 600_000,
  A_DAY = 86_400_000,
  FLAG = "new-checkout",
  QUIET = { ...DEFAULT_WORLD, duplicateChance: 0.05, peakPerMinute: 600 };

function draws(sample: (index: number) => number): number[] {
  return Array.from({ length: DRAWS }, (_unused, index) => sample(index));
}

function meanOf(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function varianceOf(values: readonly number[]): number {
  const mean = meanOf(values);
  return meanOf(values.map((value) => (value - mean) ** 2));
}

function medianOf(values: readonly number[]): number {
  const sorted = [...values];
  sorted.sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

/** True for someone who was in at a tenth and is out, or on the other arm, at a half. */
function movedWhenRaised(identity: Identity): boolean {
  const before = armOf(measuredStep(TENTH), identity);
  return before !== null && armOf(measuredStep(HALF), identity) !== before;
}

/** A world with a fixed flag: a tenth of people on each arm for ten minutes, then every event allowed to arrive. */
function drainedWorld(seed: number): World {
  const world = createWorld({ ...QUIET, plan: benchPlan(), seed });
  world.provider.setByHand(FLAG, measuredStep(TENTH));
  advanceWorld(world, world.now + TEN_MINUTES);
  // Nobody visits after that; a day later even a phone that was offline has reported.
  world.nextVisitAt = Number.POSITIVE_INFINITY;
  advanceWorld(world, world.now + A_DAY);
  world.pipeline.countFrom(world.startedAt);
  return world;
}

describe("the simulator's draws", () => {
  it("draws counts with a Poisson's mean and variance", () => {
    expect.hasAssertions();
    const random = createRandom(SEED),
      counts = draws(() => poisson(random, MEAN));
    expect(meanOf(counts)).toBeCloseTo(MEAN, 1);
    expect(varianceOf(counts) / MEAN).toBeCloseTo(1, 1);
  });

  it("draws successes with a binomial's mean and variance", () => {
    expect.hasAssertions();
    const random = createRandom(SEED),
      hits = draws(() => binomial(random, TRIALS, CHANCE));
    expect(meanOf(hits)).toBeCloseTo(TRIALS * CHANCE, 1);
    expect(varianceOf(hits) / (TRIALS * CHANCE * (1 - CHANCE))).toBeCloseTo(1, 1);
  });

  it("draws log-normal and power-law values with the right middle", () => {
    expect.hasAssertions();
    const random = createRandom(SEED);
    expect(medianOf(draws(() => logNormal(random, MEDIAN, 1))) / MEDIAN).toBeCloseTo(1, 1);
    expect(medianOf(draws(() => pareto(random, 1, SHAPE))) / CLOSE ** (1 / SHAPE)).toBeCloseTo(1, 1);
  });
});

describe("the simulated provider's bucketing", () => {
  const people = Array.from({ length: PEOPLE }, () => createPopulation(createRandom(SEED), DEFAULT_POPULATION)).slice(0, 1),
    [population] = people,
    identities = Array.from({ length: PEOPLE }, () => population.visitor().anonymous);

  it("puts the asked share on each arm", () => {
    expect.hasAssertions();
    const arms = identities.map((identity) => armOf(measuredStep(TENTH), identity)),
      treated = arms.filter((arm) => arm === "treatment").length,
      controls = arms.filter((arm) => arm === "control").length,
      sigma = Math.sqrt(PEOPLE * (TENTH / HALF / CLOSE) * (1 - TENTH / HALF / CLOSE));
    expect(Math.abs(treated - PEOPLE / (HALF / TENTH) / CLOSE)).toBeLessThan(sigma * (CLOSE + CLOSE));
    expect(Math.abs(treated - controls)).toBeLessThan(sigma * (CLOSE + CLOSE));
  });

  it("keeps everyone who was in, on the arm they had, when the share goes up", () => {
    expect.hasAssertions();
    expect(identities.filter((identity) => movedWhenRaised(identity))).toHaveLength(0);
  });

  it("gives everybody the new behaviour on a release, and nobody anything at zero", () => {
    expect.hasAssertions();
    expect(identities.every((identity) => armOf(EVERYBODY, identity) === "treatment")).toBe(true);
    expect(identities.every((identity) => armOf(measuredStep(0), identity) === null)).toBe(true);
  });

  it("decides the variant independently of the bucket", () => {
    expect.hasAssertions();
    const early = identities.filter((identity) => identity.bucket < CHANCE),
      late = identities.filter((identity) => identity.bucket >= 1 - CHANCE),
      share = (group: typeof identities): number => group.filter((identity) => identity.variant < 1 / CLOSE).length / group.length;
    expect(share(early)).toBeCloseTo(1 / CLOSE, 1);
    expect(share(late)).toBeCloseTo(1 / CLOSE, 1);
    expect(Math.abs(share(early) - share(late))).toBeLessThan(CHANCE / CLOSE / CLOSE);
  });
});

describe("the simulated pipeline against the truth", () => {
  it("counts exactly the people who were really served each arm, once everything has arrived", () => {
    expect.hasAssertions();
    const world = drainedWorld(SEED),
      totals = world.pipeline.totals();
    expect(world.truth.firstServed.treatment.length).toBeGreaterThan(TRIALS);
    expect(totals.treatment.units).toBe(world.truth.firstServed.treatment.length);
    expect(totals.control.units).toBe(world.truth.firstServed.control.length);
    expect(totals.both).toBe(0);
  });

  it("drops every repeated event in the end, so its requests match the truth", () => {
    expect.hasAssertions();
    const world = drainedWorld(SEED),
      totals = world.pipeline.totals();
    expect(world.pipeline.counts.repeatsDropped).toBeGreaterThan(0);
    // The pipeline counts all a person did after their first exposure, including a visit a server with a stale
    // Definition didn't serve the flag to. So it is never below the truth, and only a few requests above it.
    expect(totals.treatment.requests).toBeGreaterThanOrEqual(world.truth.requests.treatment);
    expect(totals.treatment.requests / world.truth.requests.treatment).toBeCloseTo(1, CLOSE);
    expect(totals.control.requests / world.truth.requests.control).toBeCloseTo(1, CLOSE);
  });

  it("has nothing left in flight after a day, so its true watermark has caught up", () => {
    expect.hasAssertions();
    const world = drainedWorld(SEED);
    expect(world.pipeline.oldestInFlight()).toBe(Number.POSITIVE_INFINITY);
    expect(world.pipeline.counts.counted).toBe(world.pipeline.counts.sent);
  });
});

describe("the simulated evaluators", () => {
  it("reach every server within two polls of a change, when no poll fails", () => {
    expect.hasAssertions();
    const world = createWorld({ ...QUIET, plan: benchPlan(), seed: SEED }),
      evaluators = createEvaluators({ ...DEFAULT_WORLD.evaluators, pollFailChance: 0 }, { flagKey: FLAG, provider: world.provider, random: createRandom(SEED), startedAt: world.startedAt }),
      person = { ...createPopulation(createRandom(SEED), DEFAULT_POPULATION).visitor(), client: "server" as const },
      later = world.startedAt + DEFAULT_WORLD.evaluators.pollEveryMs * CLOSE;
    world.provider.setByHand(FLAG, measuredStep(TENTH));
    const seen = Array.from({ length: TRIALS * CLOSE }, () => evaluators.definitionFor(person, later));
    expect(seen.every((definition) => definition.treatment === TENTH)).toBe(true);
  });
});
