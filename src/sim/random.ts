/**
 * Seeded randomness for simulations and statistical tests: the same seed gives the same run, so a failure
 * can be replayed. Park-Miller's minimal standard generator, which needs no bitwise arithmetic.
 */
interface Random {
  /** A number in (0, 1). */
  next: () => number;
  /** A draw from a standard normal. */
  normal: () => number;
  /** True with the given chance. */
  chance: (probability: number) => boolean;
  /** An independent generator, so one part of a simulation can't shift another's draws. */
  fork: (label: number) => Random;
}

const MODULUS = 2_147_483_647,
  MULTIPLIER = 48_271,
  FORK_SPREAD = 7919,
  FULL_TURN = 2 * Math.PI;

function createRandom(seed: number): Random {
  let state = (Math.abs(Math.trunc(seed)) % (MODULUS - 1)) + 1;
  const next = (): number => {
      state = (state * MULTIPLIER) % MODULUS;
      return state / MODULUS;
    },
    normal = (): number => Math.sqrt(2 * Math.log(1 / next())) * Math.cos(FULL_TURN * next());
  return {
    chance: (probability: number): boolean => next() < probability,
    fork: (label: number): Random => createRandom(state + (label + 1) * FORK_SPREAD),
    next,
    normal,
  };
}

export type { Random };
export { createRandom };
