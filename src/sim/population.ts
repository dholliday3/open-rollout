import { logNormal, pareto, pick } from "./draws";
import type { Allocation } from "../allocation";
import type { Random } from "./random";

/**
 * The people who visit. A few make most of the requests, each has their own luck with errors (so one
 * person's requests fail together), some are on a browser where the new code is broken, and they reach the
 * flag through a server, a browser or a phone that keeps an old answer. Some log in, and then carry a
 * second identity that the provider's hash may put on the other arm.
 */

type Client = "server" | "browser" | "mobile";

/** One distinct id and where the provider's two hashes put it. */
interface Identity {
  readonly id: number;
  /** Where the id falls in the rollout: in when below the rollout percentage. Never changes. */
  readonly bucket: number;
  /** Which variant the id gets, from a hash that doesn't depend on the percentage. Never changes. */
  readonly variant: number;
}

interface Person {
  readonly index: number;
  readonly anonymous: Identity;
  /** Who they are once logged in. The same identity when they never log in. */
  readonly known: Identity;
  loggedIn: boolean;
  /** Requests in a typical visit. */
  readonly activity: number;
  /** How much more (or less) than most this person's requests fail. */
  readonly errorMultiplier: number;
  readonly brokenBrowser: boolean;
  readonly client: Client;
  /** The flag as this person's phone last fetched it. */
  cached: Allocation | null;
  visits: number;
}

interface PopulationOptions {
  /** Share of visits made by someone who has visited before. */
  readonly returningShare: number;
  /** Power-law tail of activity: the smaller, the more a few people dominate. */
  readonly activityShape: number;
  readonly activityCap: number;
  /** Spread of a person's own error rate around the base, as a log-normal sigma. */
  readonly errorSpread: number;
  readonly brokenBrowserShare: number;
  readonly browserShare: number;
  readonly mobileShare: number;
  /** Share of people who log in at some point and so have a second identity. */
  readonly loginShare: number;
  /** When true the provider keeps a person's flag across login (PostHog's "persist across authentication"). */
  readonly stickyIdentity: boolean;
}

interface Population {
  readonly people: Person[];
  /** Whoever makes the next visit: someone new, or someone back again (the active come back most). */
  readonly visitor: () => Person;
}

const DEFAULT_POPULATION: PopulationOptions = {
    activityCap: 400,
    activityShape: 1.3,
    brokenBrowserShare: 0.1,
    browserShare: 0.5,
    errorSpread: 1.2,
    loginShare: 0,
    mobileShare: 0.2,
    returningShare: 0.45,
    stickyIdentity: true,
  },
  MOST_TICKETS = 40,
  ACTIVITY_PER_TICKET = 3;

function clientOf(random: Random, options: PopulationOptions): Client {
  const draw = random.next();
  if (draw < options.mobileShare) {
    return "mobile";
  }
  return draw < options.mobileShare + options.browserShare ? "browser" : "server";
}

function createPopulation(random: Random, options: PopulationOptions): Population {
  const people: Person[] = [],
    /** One entry per chance of coming back: the active hold more of them. */
    tickets: number[] = [],
    identity = (id: number): Identity => ({ bucket: random.next(), id, variant: random.next() }),
    arrive = (): Person => {
      const index = people.length,
        anonymous = identity(index * 2),
        splits = !options.stickyIdentity && random.chance(options.loginShare),
        activity = Math.min(options.activityCap, pareto(random, 1, options.activityShape)),
        person: Person = {
          activity,
          anonymous,
          brokenBrowser: random.chance(options.brokenBrowserShare),
          cached: null,
          client: clientOf(random, options),
          errorMultiplier: logNormal(random, 1, options.errorSpread),
          index,
          known: splits ? identity(index * 2 + 1) : anonymous,
          loggedIn: false,
          visits: 0,
        };
      people.push(person);
      for (let ticket = 0; ticket < Math.min(MOST_TICKETS, Math.ceil(activity / ACTIVITY_PER_TICKET)); ticket += 1) {
        tickets.push(index);
      }
      return person;
    };
  return {
    people,
    visitor: () => {
      if (tickets.length === 0 || !random.chance(options.returningShare)) {
        return arrive();
      }
      return people[tickets[pick(random, tickets.length)]];
    },
  };
}

export type { Client, Identity, Person, Population, PopulationOptions };
export { DEFAULT_POPULATION, createPopulation };
