import type { ActivityEvent, Arm } from "./events";
import { HOUR, START } from "./world.options";
import { between, binomial, logNormal, poisson } from "./draws";
import { EFFECTS } from "./effects";
import type { Person } from "./population";
import type { World } from "./world";
import { armOf } from "./evaluators";
import { noteServed } from "./truth";

/**
 * Visits: who comes, what the flag gives them, what happens to them, and what the product reports about it.
 * Traffic follows the hour of the day, with a quiet night.
 */

const HOURS_A_DAY = 24,
  QUIETEST_HOUR = 4,
  PEAKEDNESS = 1.5,
  HALF = 0.5,
  MINUTE = 60_000,
  TYPICAL_LATENCY_MS = 200,
  LATENCY_SPREAD = 0.5,
  PHONE_SLOWNESS = 2,
  LOGIN_CHANCE = 0.5;

/** Visits per millisecond at an instant. */
function visitRate(world: World, at: number): number {
  const hour = ((at - START) / HOUR) % HOURS_A_DAY,
    wave = (HALF - HALF * Math.cos((2 * Math.PI * (hour - QUIETEST_HOUR)) / HOURS_A_DAY)) ** PEAKEDNESS,
    { nightShare, peakPerMinute } = world.options;
  return (peakPerMinute * (nightShare + (1 - nightShare) * wave)) / MINUTE;
}

/** When the pipeline gets an event that happened at `at`, by how the person reaches us. */
function arrival(world: World, person: Person, at: number): number {
  const { lag } = world.options,
    random = world.random.lag;
  if (person.client === "server") {
    return at + logNormal(random, lag.serverMedianMs, lag.sigma);
  }
  if (person.client === "mobile" && random.chance(lag.offlineShare)) {
    return at + between(random, MINUTE, lag.offlineUpToMs);
  }
  return at + logNormal(random, lag.clientMedianMs * (person.client === "mobile" ? PHONE_SLOWNESS : 1), lag.sigma);
}

function errorChance(world: World, visit: { person: Person; arm: Arm | null; at: number }): number {
  const effect = EFFECTS[world.options.effect],
    { person, at } = visit,
    base = Math.min(1, world.options.baseErrorChance * person.errorMultiplier * effect.commonMode(at - world.startedAt));
  if (visit.arm !== "treatment") {
    return base;
  }
  const { treatment } = world.provider.servedAt(world.options.plan.flagKey, at);
  return effect.errorChance(base, { at, firstVisit: !world.truth.lastTreatment.has(person.index), person, startedAt: world.startedAt, treatmentShare: treatment });
}

/** What one visit did, as the event the product reports. */
function activityOf(world: World, visit: { person: Person; arm: Arm | null; at: number; id: number }): ActivityEvent {
  const random = world.random.visits,
    effect = EFFECTS[world.options.effect],
    onNew = visit.arm === "treatment",
    requests = 1 + poisson(random, visit.person.activity),
    errors = binomial(random, requests, errorChance(world, visit));
  world.nextKey += 1;
  return {
    arrives: arrival(world, visit.person, visit.at),
    at: visit.at,
    converted: random.chance(world.options.baseConversion * (onNew ? effect.conversionFactor : 1)),
    errors,
    id: visit.id,
    key: world.nextKey,
    kind: "activity",
    latency: requests * logNormal(random, TYPICAL_LATENCY_MS, LATENCY_SPREAD) * (onNew ? effect.latencyFactor : 1),
    requests,
  };
}

/** Logging in gives a person their second identity, and the pipeline hears of it a little later. */
function maybeLogIn(world: World, person: Person, at: number): void {
  if (person.loggedIn || person.known === person.anonymous || !world.random.visits.chance(LOGIN_CHANCE)) {
    return;
  }
  person.loggedIn = true;
  world.pipeline.send({ arrives: arrival(world, person, at), at, id: person.anonymous.id, into: person.known.id, kind: "merge" });
}

function report(world: World, visit: { person: Person; arm: Arm | null; at: number; id: number }, activity: ActivityEvent): void {
  const { person, arm, at, id } = visit,
    lost = arm === "treatment" && world.random.visits.chance(EFFECTS[world.options.effect].exposureLoss);
  if (arm !== null && !lost) {
    world.pipeline.send({ arm, arrives: arrival(world, person, at), at, id, kind: "exposure" });
  }
  world.pipeline.send(activity);
  if (world.random.lag.chance(world.options.duplicateChance)) {
    world.pipeline.send({ ...activity, arrives: arrival(world, person, at) });
  }
}

function serveVisit(world: World, at: number): void {
  const person = world.population.visitor(),
    identity = person.loggedIn ? person.known : person.anonymous,
    arm = armOf(world.evaluators.definitionFor(person, at), identity),
    visit = { arm, at, id: identity.id, person },
    activity = activityOf(world, visit);
  person.visits += 1;
  if (arm !== null) {
    noteServed(world.truth, { arm, at, errors: activity.errors, person: person.index, requests: activity.requests });
  }
  report(world, visit, activity);
  maybeLogIn(world, person, at);
}

/** Lets the world run up to an instant: every visit due by then happens, and the pipeline takes in what has arrived. */
function advanceWorld(world: World, to: number): void {
  while (world.nextVisitAt <= to) {
    serveVisit(world, world.nextVisitAt);
    world.nextVisitAt += Math.log(1 / world.random.traffic.next()) / visitRate(world, world.nextVisitAt);
  }
  world.now = Math.max(world.now, to);
  world.pipeline.advance(world.now);
}

export { advanceWorld, visitRate };
