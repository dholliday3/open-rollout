import { between, pick } from "./draws";
import type { Autopilot } from "../controller";
import type { RolloutRecord } from "../record";
import type { World } from "./world";
import { advanceWorld } from "./traffic";
import { createAutopilot } from "../controller";
import { servedTreatmentAfter } from "./truth";

/**
 * A runtime that drives one rollout through a world the way a schedule with leases would: ticks at
 * irregular intervals, now and then the same tick twice, from workers whose clocks disagree. Things a
 * scenario wants to happen at set times (a person at the console, an outage) go in `script`.
 */

interface Worker {
  readonly name: string;
  /** How far this worker's clock is from the true time. */
  readonly clockOffsetMs: number;
}

interface Scripted {
  /** How long after the start. */
  readonly afterMs: number;
  readonly run: (world: World, autopilot: Autopilot) => Promise<void> | void;
}

interface Runtime {
  /** The gap between ticks is drawn evenly between these two. */
  readonly tickEveryMs: readonly [number, number];
  /** Chance a tick is run again straight after: a replayed step. */
  readonly repeatChance: number;
  readonly workers: readonly Worker[];
  /** Give up after this long, whatever state the rollout is in. */
  readonly horizonMs: number;
  /** After a rollback has settled, how much longer the world runs with nobody ticking, to see who is still served the new behaviour. */
  readonly lingerMs: number;
  readonly script: readonly Scripted[];
}

/** How one rollout went, from the store's history and the truth. */
interface Outcome {
  readonly record: RolloutRecord;
  /** Why it ended or stopped: the outcome's reason, else the pause's, else "running". */
  readonly ending: string;
  readonly ticks: number;
  /** True time from the start until a rollback was decided; null when none was. */
  readonly decidedAfterMs: number | null;
  /** People first served the new behaviour before the rollback was decided (or ever, when none was). */
  readonly exposedBeforeDecision: number;
  /** People still served the new behaviour after the rollback was decided. */
  readonly servedAfterDecision: number;
  /** People still served the new behaviour after the rollout settled as rolled back. */
  readonly servedAfterSettled: number;
  readonly endedAfterMs: number;
}

const ROLLOUT = "rollout-1",
  START_TRIES = 30,
  SIX_HOURS = 21_600_000,
  SOONEST_TICK = 20_000,
  LATEST_TICK = 70_000,
  USUAL_TICKS: readonly [number, number] = [SOONEST_TICK, LATEST_TICK],
  HALF_AN_HOUR = 1_800_000,
  DEFAULT_RUNTIME: Runtime = { horizonMs: SIX_HOURS, lingerMs: HALF_AN_HOUR, repeatChance: 0.05, script: [], tickEveryMs: USUAL_TICKS, workers: [{ clockOffsetMs: 0, name: "worker-1" }] };

function endingOf(record: RolloutRecord): string {
  return record.outcome?.reason ?? record.pause?.reason ?? "running";
}

/** The true time the first version in a phase was saved, or null when the rollout was never in it. */
function firstSavedAs(world: World, test: (record: RolloutRecord) => boolean): number | null {
  return world.store.versions(ROLLOUT).find((saved) => test(saved.record))?.at ?? null;
}

function outcomeOf(world: World, ticks: number): Outcome {
  const record = world.store.current(ROLLOUT),
    decided = firstSavedAs(world, (saved) => saved.phase === "rolling_back"),
    settled = firstSavedAs(world, (saved) => saved.settled && saved.phase === "rolled_back");
  return {
    decidedAfterMs: decided === null ? null : decided - world.startedAt,
    endedAfterMs: world.now - world.startedAt,
    ending: endingOf(record),
    exposedBeforeDecision: world.truth.firstServed.treatment.filter((at) => at <= (decided ?? Number.POSITIVE_INFINITY)).length,
    record,
    servedAfterDecision: decided === null ? 0 : servedTreatmentAfter(world.truth, decided),
    servedAfterSettled: settled === null ? 0 : servedTreatmentAfter(world.truth, settled),
    ticks,
  };
}

interface Run {
  readonly world: World;
  readonly runtime: Runtime;
  readonly autopilots: readonly Autopilot[];
  script: Scripted[];
  ticks: number;
}

async function runDue(run: Run): Promise<void> {
  const due = run.script.filter((item) => run.world.startedAt + item.afterMs <= run.world.now);
  run.script = run.script.filter((item) => !due.includes(item));
  for (const item of due) {
    // One at a time, in order: a script is a story.
    // eslint-disable-next-line no-await-in-loop -- each scripted step must finish before the next starts
    await item.run(run.world, run.autopilots[0]);
  }
}

async function tickOnce(run: Run): Promise<void> {
  const { world, runtime } = run,
    index = pick(world.random.runtime, runtime.workers.length),
    now = world.now + runtime.workers[index].clockOffsetMs;
  run.ticks += 1;
  await run.autopilots[index].tick(ROLLOUT, now);
  if (world.random.runtime.chance(runtime.repeatChance)) {
    await run.autopilots[index].tick(ROLLOUT, now);
  }
}

async function loop(run: Run): Promise<void> {
  const { world, runtime } = run;
  while (!world.store.current(ROLLOUT).settled && world.now - world.startedAt < runtime.horizonMs) {
    advanceWorld(world, world.now + between(world.random.runtime, runtime.tickEveryMs[0], runtime.tickEveryMs[1]));
    // eslint-disable-next-line no-await-in-loop -- time in the simulation only moves between ticks
    await runDue(run);
    // eslint-disable-next-line no-await-in-loop -- ticks happen one after another here; gate.ts interleaves them
    await tickOnce(run);
  }
}

/**
 * Starts the rollout the way a runtime does: again, a little later, when the call fails (it throws when the
 * flag can't be read), until the record exists.
 */
async function begin(run: Run, triesLeft: number): Promise<void> {
  const { world, runtime } = run,
    [worker] = runtime.workers;
  try {
    await run.autopilots[0].start({ id: ROLLOUT, now: world.now + worker.clockOffsetMs, plan: world.options.plan });
  } catch {
    advanceWorld(world, world.now + runtime.tickEveryMs[0]);
  }
  if (world.store.versions(ROLLOUT).length > 0) {
    return;
  }
  if (triesLeft <= 0) {
    throw new Error("The rollout did not start.");
  }
  await begin(run, triesLeft - 1);
}

/** Starts the world's rollout and drives it until it settles or the horizon passes. */
async function runRollout(world: World, runtime: Runtime = DEFAULT_RUNTIME): Promise<Outcome> {
  const autopilots = runtime.workers.map((worker) => createAutopilot(world.portsFor(worker.name))),
    run: Run = { autopilots, runtime, script: [...runtime.script], ticks: 0, world };
  await begin(run, START_TRIES);
  await loop(run);
  if (world.store.current(ROLLOUT).phase === "rolled_back") {
    advanceWorld(world, world.now + runtime.lingerMs);
  }
  return outcomeOf(world, run.ticks);
}

export type { Outcome, Runtime, Scripted, Worker };
export { DEFAULT_RUNTIME, ROLLOUT, runRollout };
