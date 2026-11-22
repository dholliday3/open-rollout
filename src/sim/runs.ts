/**
 * How many seeded rollouts a statistical test runs. The default suite uses each test's own small number,
 * so it stays quick; `SIM_RUNS=2000 pnpm exec vitest run src/sim` (or `pnpm sim`) gives every scenario that
 * many, for the numbers in a report.
 */
// eslint-disable-next-line node/no-process-env -- the switches between the quick suite and the heavy one live here and nowhere else
const { SIM_CHAOS_RUNS, SIM_CHAOS_SEED, SIM_RUNS } = process.env,
  REQUESTED = Number(SIM_RUNS ?? "0"),
  CHAOS_REQUESTED = Number(SIM_CHAOS_RUNS ?? "0");

/** The number asked for with `SIM_RUNS`, or else the test's own. */
function runsOr(usual: number): number {
  return REQUESTED > 0 ? REQUESTED : usual;
}

/** The seeds a chaotic test runs: the one named by `SIM_CHAOS_SEED` (to replay it), or else 1 up to `SIM_CHAOS_RUNS` or the test's own number. */
function chaosSeeds(usual: number): number[] {
  if (SIM_CHAOS_SEED !== undefined) {
    return [Number(SIM_CHAOS_SEED)];
  }
  return Array.from({ length: CHAOS_REQUESTED > 0 ? CHAOS_REQUESTED : usual }, (_unused, index) => index + 1);
}

/** True when one chaotic seed is being replayed, and its story should be printed. */
function isReplay(): boolean {
  return SIM_CHAOS_SEED !== undefined;
}

export { chaosSeeds, isReplay, runsOr };
