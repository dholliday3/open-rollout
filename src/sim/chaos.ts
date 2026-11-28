import type { Gate, Parked } from "./gate.js";
import { MINUTE, ROLLOUT_ID, createBench, gatedWorker, passTime, recordOf } from "./bench.js";
import { between, pick } from "./draws.js";
import { createGate, settle } from "./gate.js";
import { mischief, note } from "./chaos.mischief.js";
import type { Bench } from "./bench.js";
import type { Command } from "../commands.js";
import type { Random } from "./random.js";
import type { RolloutPlan } from "../plan.js";
import { createRandom } from "./random.js";

/**
 * A runtime that does everything a durable runtime is allowed to: several workers at once with their port
 * calls interleaved in any order, the same step run twice, workers that die between any two calls or stall
 * for minutes and then finish, clocks that disagree, a provider, store, metric source and notifier that
 * fail in every way they can, and people at the console and in chat. Seeded, so a run that breaks an
 * invariant can be replayed call for call.
 */

interface ChaosOptions {
  readonly seed: number;
  readonly rounds: number;
  readonly checksRevision: boolean;
  readonly plan?: Partial<RolloutPlan>;
  /** How far workers' clocks may be from the true time, either way. */
  readonly skewMs: number;
  /** Whether people change the flag by hand and send commands. */
  readonly people: boolean;
  /** Whether the bench has an incident feed, for incidents to come and go. */
  readonly incidents?: boolean;
}

interface Chaos {
  readonly options: ChaosOptions;
  readonly bench: Bench;
  readonly gate: Gate;
  readonly random: Random;
  /** What happened, in order, for replaying a failure by eye. */
  readonly story: string[];
  /** When each worker's flag write went on the wire. */
  readonly wired: Map<string, number>;
  /** Workers stalled in the middle of a tick, to be finished later. */
  zombies: string[];
  /** Every command sent, by its id. */
  readonly sent: Map<string, Command>;
  /** When each command was first sent. */
  readonly sentAt: Map<string, number>;
  /** When the metric source went down and came back. */
  readonly outages: { at: number; down: boolean }[];
  /** When an incident opened and cleared. */
  readonly incidents: { at: number; open: boolean }[];
  /** When each worker last read the incident feed. */
  readonly incidentReads: Map<string, number>;
  readonly rejected: string[];
  workers: number;
  commands: number;
}

const SECOND = 1000,
  SHORTEST_GAP = 5,
  LONGEST_GAP = 90,
  MOST_AT_ONCE = 3,
  CRASH_CHANCE = 0.02,
  STALL_CHANCE = 0.03,
  COMMAND_CHANCE = 0.12,
  MISCHIEF_CHANCE = 0.25,
  WAKE_CHANCE = 0.3,
  REPEAT_CHANCE = 0.3;

function nextCommand(chaos: Chaos): Command {
  const { random, sent } = chaos,
    ids = [...sent.keys()],
    again = ids.length > 0 && random.chance(REPEAT_CHANCE) ? sent.get(ids[pick(random, ids.length)]) : undefined;
  if (again !== undefined) {
    return again;
  }
  chaos.commands += 1;
  const id = `c${chaos.commands}`,
    by = `person(${id})`,
    kinds: Command[] = [
      { by, id, type: "pause" },
      { by, id, type: "resume" },
      { by, id, type: "resume" },
      { by, gate: "release", id, type: "approve" },
      { by, gate: 1, id, type: "approve" },
      { by, id, type: "rollback" },
      { by, id, type: "release" },
    ];
  // Rollbacks and forced releases end the story, so they are rare.
  return kinds[Math.min(kinds.length - 1, Math.floor(random.next() * random.next() * kinds.length * 2))];
}

/** A person's command. It may fail when the store does, and the person sends it again; only a tick promises never to throw. */
async function sendCommand(chaos: Chaos, worker: { name: string; now: number }): Promise<void> {
  const command = nextCommand(chaos);
  chaos.sent.set(command.id, command);
  chaos.sentAt.set(command.id, chaos.sentAt.get(command.id) ?? chaos.bench.now);
  note(chaos, `${worker.name} sends ${command.type} ${command.id}`);
  try {
    await gatedWorker(chaos.bench, chaos.gate, worker.name).command(ROLLOUT_ID, command, worker.now);
  } catch (error) {
    note(chaos, `${worker.name}'s command failed: ${String(error)}`);
  }
}

async function tickOnce(chaos: Chaos, worker: { name: string; now: number }): Promise<void> {
  try {
    await gatedWorker(chaos.bench, chaos.gate, worker.name).tick(ROLLOUT_ID, worker.now);
  } catch (error) {
    chaos.rejected.push(`tick threw: ${String(error)}`);
  }
}

/** Starts one worker on one thing: a tick, or a command from a person. Its port calls park at the gate. */
function launch(chaos: Chaos): { name: string; done: Promise<void> } {
  const { bench, random, options } = chaos;
  chaos.workers += 1;
  const worker = { name: `w${chaos.workers}`, now: bench.now + Math.round(between(random, -options.skewMs, options.skewMs)) },
    asCommand = options.people && random.chance(COMMAND_CHANCE);
  return { done: asCommand ? sendCommand(chaos, worker) : tickOnce(chaos, worker), name: worker.name };
}

function fate(chaos: Chaos, call: Parked): "pass" | "crash" | "stall" {
  if (call.port === "flags.write" && !chaos.wired.has(call.worker)) {
    chaos.wired.set(call.worker, chaos.bench.now);
  }
  if (call.port === "incidents.open") {
    chaos.incidentReads.set(call.worker, chaos.bench.now);
  }
  if (chaos.random.chance(CRASH_CHANCE)) {
    return "crash";
  }
  return chaos.random.chance(STALL_CHANCE) ? "stall" : "pass";
}

/** A worker dies where it stands, or stalls there to finish much later. */
function stop(chaos: Chaos, call: Parked, what: "crash" | "stall"): void {
  note(chaos, `${call.worker} ${what === "crash" ? "dies" : "stalls"} at ${call.port} #${call.sequence}`);
  if (what === "crash") {
    chaos.gate.crash(call.worker);
  } else {
    chaos.zombies.push(call.worker);
  }
}

/** Lets the running workers' calls through in a random order, until every one has ended, died or stalled. */
async function interleave(chaos: Chaos, running: string[]): Promise<void> {
  const waiting = chaos.gate.parked().filter((call) => running.includes(call.worker));
  if (waiting.length === 0) {
    return;
  }
  const call = waiting[pick(chaos.random, waiting.length)],
    what = fate(chaos, call);
  if (what === "pass") {
    await chaos.gate.pass(call);
    await interleave(chaos, running);
    return;
  }
  stop(chaos, call, what);
  await interleave(
    chaos,
    running.filter((name) => name !== call.worker),
  );
}

async function wakeZombie(chaos: Chaos): Promise<void> {
  const zombie = chaos.zombies.at(0);
  if (zombie === undefined) {
    return;
  }
  chaos.zombies = chaos.zombies.slice(1);
  note(chaos, `${zombie} wakes`);
  await chaos.gate.finish(zombie);
}

async function round(chaos: Chaos): Promise<void> {
  const { bench, random } = chaos;
  passTime(bench, Math.round(between(random, SHORTEST_GAP, LONGEST_GAP)) * SECOND);
  if (random.chance(MISCHIEF_CHANCE)) {
    mischief(chaos);
  }
  const launched = Array.from({ length: 1 + pick(random, MOST_AT_ONCE) }, () => launch(chaos));
  await settle();
  await interleave(
    chaos,
    launched.map((worker) => worker.name),
  );
  if (random.chance(WAKE_CHANCE)) {
    await wakeZombie(chaos);
  }
}

async function rounds(chaos: Chaos, left: number): Promise<void> {
  if (left <= 0 || recordOf(chaos.bench).settled) {
    return;
  }
  await round(chaos);
  await rounds(chaos, left - 1);
}

async function wakeEveryZombie(chaos: Chaos): Promise<void> {
  if (chaos.zombies.length === 0) {
    return;
  }
  await wakeZombie(chaos);
  await wakeEveryZombie(chaos);
}

/** The metric source comes back and any incident clears, each noted in its timeline for the oracle. */
function clearSurroundings(chaos: Chaos): void {
  const { bench } = chaos;
  if (bench.metricsDown) {
    bench.metricsDown = false;
    chaos.outages.push({ at: bench.now, down: false });
  }
  if (bench.incident) {
    bench.incident = false;
    chaos.incidents.push({ at: bench.now, open: false });
  }
}

/** Everything stops going wrong: faults clear, traffic returns, and every stalled worker finishes what it was doing. */
async function calm(chaos: Chaos): Promise<void> {
  const { bench } = chaos;
  Object.assign(bench.provider.faults, { down: false, failChance: 0, lostReplyChance: 0, readsDown: false, staleReadChance: 0, writesDown: false });
  Object.assign(bench.store.faults, { down: false, failChance: 0, lostReplyChance: 0 });
  bench.notifier.down = false;
  bench.perMinute = SECOND;
  clearSurroundings(chaos);
  await wakeEveryZombie(chaos);
  note(chaos, "calm");
}

async function runChaos(options: ChaosOptions): Promise<Chaos> {
  const bench = createBench({ checksRevision: options.checksRevision, incidents: options.incidents, plan: options.plan }),
    chaos: Chaos = {
      bench,
      commands: 0,
      gate: createGate(),
      incidentReads: new Map<string, number>(),
      incidents: [],
      options,
      outages: [],
      random: createRandom(options.seed),
      rejected: [],
      sent: new Map<string, Command>(),
      sentAt: new Map<string, number>(),
      story: [],
      wired: new Map<string, number>(),
      workers: 0,
      zombies: [],
    };
  bench.served.push({ at: bench.now, control: 0, treatment: 0 });
  await bench.autopilot.start({ id: ROLLOUT_ID, now: bench.now, plan: bench.plan });
  await rounds(chaos, options.rounds);
  await calm(chaos);
  return chaos;
}

/** Clean ticks a minute apart from one healthy worker, which is all claim 7 asks for. */
async function cleanTicks(chaos: Chaos, count: number): Promise<void> {
  if (count <= 0) {
    return;
  }
  passTime(chaos.bench, MINUTE);
  await chaos.bench.autopilot.tick(ROLLOUT_ID, chaos.bench.now);
  await cleanTicks(chaos, count - 1);
}

export type { Chaos, ChaosOptions };
export { cleanTicks, runChaos };
