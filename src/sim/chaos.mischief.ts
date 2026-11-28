import { NOBODY, measuredStep } from "../allocation.js";
import type { Allocation } from "../allocation.js";
import type { Chaos } from "./chaos.js";
import { FLAG_KEY } from "./bench.js";
import { pick } from "./draws.js";

/**
 * What goes wrong around a rollout in a chaotic run: people at the provider's console, a provider and a
 * store that fail in each of their ways, a notifier and a metric source that go down, traffic that stops.
 */

const SECOND = 1000,
  FLAKY = 0.3,
  HALF = 0.5,
  RAISED = 4000;

function note(chaos: Chaos, line: string): void {
  chaos.story.push(`${Math.round((chaos.bench.now - chaos.bench.served[0].at) / SECOND)}s ${line}`);
}

function byHand(chaos: Chaos, allocation: Allocation, what: string): void {
  chaos.bench.provider.setByHand(FLAG_KEY, allocation, `person: ${what}`);
  note(chaos, `a person ${what}`);
}

/** What a person might do to the flag in the provider's console. */
function peopleAtTheConsole(chaos: Chaos): (() => void)[] {
  const now = chaos.bench.provider.serving(FLAG_KEY).allocation;
  return [
    () => {
      byHand(chaos, NOBODY, "kills the flag");
    },
    () => {
      byHand(chaos, measuredStep(Math.floor(now.treatment * HALF)), "lowers the flag");
    },
    () => {
      byHand(chaos, measuredStep(RAISED), "sets the flag to 40%");
    },
    () => {
      byHand(chaos, now, "edits the flag's description");
    },
  ];
}

/** Each of these switches one way the provider or the store fails on, or off again. */
function brokenServices(chaos: Chaos): (() => void)[] {
  const { faults } = chaos.bench.provider,
    store = chaos.bench.store.faults;
  return [
    () => {
      faults.down = !faults.down;
    },
    () => {
      faults.readsDown = !faults.readsDown;
    },
    () => {
      faults.writesDown = !faults.writesDown;
    },
    () => {
      faults.failChance = faults.failChance > 0 ? 0 : FLAKY;
    },
    () => {
      faults.lostReplyChance = faults.lostReplyChance > 0 ? 0 : FLAKY;
    },
    () => {
      faults.staleReadChance = faults.staleReadChance > 0 ? 0 : FLAKY;
    },
    () => {
      store.failChance = store.failChance > 0 ? 0 : FLAKY;
    },
    () => {
      store.lostReplyChance = store.lostReplyChance > 0 ? 0 : FLAKY;
    },
  ];
}

/** The notifier, the metric source and the traffic itself, each switched off or back on. */
function brokenSurroundings(chaos: Chaos): (() => void)[] {
  const { bench } = chaos;
  return [
    () => {
      bench.notifier.down = !bench.notifier.down;
    },
    () => {
      bench.metricsDown = !bench.metricsDown;
      chaos.outages.push({ at: bench.now, down: bench.metricsDown });
    },
    () => {
      bench.perMinute = bench.perMinute > 0 ? 0 : SECOND;
    },
    // Only a bench with an incident feed has incidents, so the runs of every other configuration draw as they always did.
    ...(bench.incidents === undefined
      ? []
      : [
          () => {
            bench.incident = !bench.incident;
          },
        ]),
  ];
}

/** Things that go wrong around a rollout: each call does one of them, or undoes one. */
function mischief(chaos: Chaos): void {
  const faultsOnly = [...brokenServices(chaos), ...brokenSurroundings(chaos)],
    all = chaos.options.people ? [...faultsOnly, ...peopleAtTheConsole(chaos)] : faultsOnly,
    index = pick(chaos.random, all.length);
  note(chaos, `mischief ${index}`);
  all[index]();
}

export { mischief, note };
