import type { SimNotifier, SimStore } from "./store";
import { createSimNotifier, createSimStore } from "./store";
import type { Evaluators } from "./evaluators";
import type { Pipeline } from "./pipeline";
import type { Population } from "./population";
import type { Ports } from "../ports";
import type { Random } from "./random";
import type { SimProvider } from "./provider";
import type { SimSource } from "./source";
import type { Truth } from "./truth";
import type { WorldOptions } from "./world.options";
import { createEvaluators } from "./evaluators";
import { createPipeline } from "./pipeline";
import { createPopulation } from "./population";
import { createRandom } from "./random";
import { createSimProvider } from "./provider";
import { createSimSource } from "./source";
import { createTruth } from "./truth";
import { startOf } from "./world.options";

/**
 * One simulated production: people, a flag provider, evaluators, a metrics pipeline, a store, and the truth
 * about what happened. Everything random comes from the seed, each part from its own stream, so changing
 * how one part draws does not shift another.
 */

interface World {
  readonly options: WorldOptions;
  readonly startedAt: number;
  now: number;
  /** When the next visit happens. */
  nextVisitAt: number;
  nextKey: number;
  readonly random: { readonly traffic: Random; readonly visits: Random; readonly lag: Random; readonly runtime: Random };
  readonly provider: SimProvider;
  readonly pipeline: Pipeline;
  readonly source: SimSource;
  readonly store: SimStore;
  readonly notifier: SimNotifier;
  readonly population: Population;
  readonly evaluators: Evaluators;
  readonly truth: Truth;
  /** The four ports as one worker sees them. */
  readonly portsFor: (worker: string) => Ports;
}

const SCRAMBLE = { line: 104_729, modulus: 2_147_483_629, shift: 12_345, square: 7907 },
  STREAMS = { lag: 3, provider: 4, runtime: 5, store: 6, traffic: 1, visits: 2 };

/**
 * A seed for the generator that is not a straight line in the run's number. The generator is linear in its
 * seed, so runs seeded 1, 2, 3 would otherwise draw their n-th numbers in an even march.
 */
function scrambled(seed: number): number {
  return (seed * seed * SCRAMBLE.square + seed * SCRAMBLE.line + SCRAMBLE.shift) % SCRAMBLE.modulus;
}

function createWorld(options: WorldOptions): World {
  const root = createRandom(scrambled(options.seed)),
    startedAt = startOf(options),
    clock = { now: startedAt },
    now = (): number => clock.now,
    provider = createSimProvider({ checksRevision: options.checksRevision, now, random: root.fork(STREAMS.provider) }),
    pipeline = createPipeline(options.pipeline),
    source = createSimSource({ now, pipeline, rule: options.watermark }),
    store = createSimStore({ now, random: root.fork(STREAMS.store) }),
    notifier = createSimNotifier(),
    visits = root.fork(STREAMS.visits),
    world: World = {
      evaluators: createEvaluators(options.evaluators, { flagKey: options.plan.flagKey, provider, random: visits, startedAt }),
      nextKey: 0,
      nextVisitAt: startedAt,
      notifier,
      get now() {
        return clock.now;
      },
      set now(value: number) {
        clock.now = value;
      },
      options,
      pipeline,
      population: createPopulation(visits, options.population),
      portsFor: (worker) => ({ flags: provider.controlFor(worker), metrics: source, notifier, store }),
      provider,
      random: { lag: root.fork(STREAMS.lag), runtime: root.fork(STREAMS.runtime), traffic: root.fork(STREAMS.traffic), visits },
      source,
      startedAt,
      store,
      truth: createTruth(),
    };
  return world;
}

export type { World };
export { createWorld };
