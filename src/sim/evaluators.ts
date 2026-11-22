import { FULL_SHARE, NOBODY } from "../allocation";
import type { Identity, Person } from "./population";
import { between, pick } from "./draws";
import type { Allocation } from "../allocation";
import type { Arm } from "./events";
import type { Random } from "./random";
import type { SimProvider } from "./provider";

/**
 * Where flags are really evaluated. Nobody asks the provider on every request: servers poll for the flag's
 * definition on an interval (and sometimes miss a poll), browsers fetch it when a page loads through an
 * endpoint that caches for a few seconds, and a phone uses whatever it fetched last time it was opened.
 * So a change to the flag reaches different people at different times, and some long after.
 */

interface EvaluatorOptions {
  readonly servers: number;
  readonly pollEveryMs: number;
  /** Chance a server's poll fails and it keeps its old definition for another interval. */
  readonly pollFailChance: number;
  /** How stale the endpoint a browser fetches from may be. */
  readonly edgeCacheMs: number;
}

interface Evaluators {
  /** The definition this person's next evaluation uses at an instant. */
  readonly definitionFor: (person: Person, at: number) => Allocation;
}

interface Server {
  definition: Allocation;
  nextPollAt: number;
}

const DEFAULT_EVALUATORS: EvaluatorOptions = { edgeCacheMs: 5000, pollEveryMs: 30_000, pollFailChance: 0.02, servers: 6 },
  POLL_JITTER = 0.1;

/**
 * Which arm an identity gets under a definition, the way PostHog decides: one hash says whether the id is
 * inside the rollout percentage, another says which variant, and the second never depends on the first.
 */
function armOf(definition: Allocation, identity: Identity): Arm | null {
  const served = definition.control + definition.treatment;
  if (served === 0 || identity.bucket >= served / FULL_SHARE) {
    return null;
  }
  return identity.variant < definition.treatment / served ? "treatment" : "control";
}

function createEvaluators(options: EvaluatorOptions, world: { provider: SimProvider; random: Random; flagKey: string; startedAt: number }): Evaluators {
  const servers: Server[] = [],
    { provider, random, flagKey } = world,
    poll = (server: Server, at: number): void => {
      while (server.nextPollAt <= at) {
        if (!random.chance(options.pollFailChance)) {
          server.definition = provider.servedAt(flagKey, server.nextPollAt);
        }
        server.nextPollAt += options.pollEveryMs * between(random, 1 - POLL_JITTER, 1 + POLL_JITTER);
      }
    },
    fromPhone = (person: Person, at: number): Allocation => {
      const used = person.cached ?? provider.servedAt(flagKey, at);
      // The app refreshes in the background, for next time.
      person.cached = provider.servedAt(flagKey, at);
      return used;
    };
  for (let index = 0; index < options.servers; index += 1) {
    servers.push({ definition: NOBODY, nextPollAt: world.startedAt + options.pollEveryMs * random.next() });
  }
  return {
    definitionFor: (person, at) => {
      if (person.client === "mobile") {
        return fromPhone(person, at);
      }
      if (person.client === "browser") {
        return provider.servedAt(flagKey, at - options.edgeCacheMs * random.next());
      }
      const server = servers[pick(random, servers.length)];
      poll(server, at);
      return server.definition;
    },
  };
}

export type { EvaluatorOptions, Evaluators };
export { DEFAULT_EVALUATORS, armOf, createEvaluators };
