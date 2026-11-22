import type { Random } from "./random.js";

/**
 * Distributions the simulated world draws from, all on top of the seeded generator so a run replays from
 * its seed. Each is the textbook sampler; `selfcheck.test.ts` checks their moments.
 */

const NORMAL_APPROXIMATION_FROM = 30,
  EXACT_UP_TO = 2000;

/** A count of events in a window whose expected count is `mean`. */
function poisson(random: Random, mean: number): number {
  if (mean <= 0) {
    return 0;
  }
  if (mean > NORMAL_APPROXIMATION_FROM) {
    return Math.max(0, Math.round(mean + Math.sqrt(mean) * random.normal()));
  }
  const limit = Math.exp(-mean);
  let count = 0,
    product = random.next();
  while (product > limit) {
    count += 1;
    product *= random.next();
  }
  return count;
}

/** Successes in very many tries, by the normal approximation. */
function manySuccesses(random: Random, trials: number, chance: number): number {
  const spread = Math.sqrt(trials * chance * (1 - chance)),
    drawn = Math.round(trials * chance + spread * random.normal());
  return Math.min(trials, Math.max(0, drawn));
}

/** Successes in `trials` tries: counted one by one, or by the normal approximation when there are very many. */
function binomial(random: Random, trials: number, chance: number): number {
  if (chance <= 0 || trials <= 0) {
    return 0;
  }
  if (chance >= 1 || trials > EXACT_UP_TO) {
    return chance >= 1 ? trials : manySuccesses(random, trials, chance);
  }
  let hits = 0;
  for (let trial = 0; trial < trials; trial += 1) {
    hits += random.chance(chance) ? 1 : 0;
  }
  return hits;
}

/** A positive value whose logarithm is normal: most are near the median, a few are many times it. */
function logNormal(random: Random, median: number, sigma: number): number {
  return median * Math.exp(sigma * random.normal());
}

/** A value of at least `least` with a power-law tail: the smaller `shape`, the heavier the tail. */
function pareto(random: Random, least: number, shape: number): number {
  return least / random.next() ** (1 / shape);
}

/** A whole number from 0 up to, not including, `count`. */
function pick(random: Random, count: number): number {
  return Math.min(count - 1, Math.floor(random.next() * count));
}

/** A value spread evenly between two bounds. */
function between(random: Random, low: number, high: number): number {
  return low + (high - low) * random.next();
}

export { between, binomial, logNormal, pareto, pick, poisson };
