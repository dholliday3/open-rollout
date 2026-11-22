import type { Notifier, RolloutStore, Stored } from "../ports.js";
import type { RolloutEvent, RolloutRecord } from "../record.js";
import type { Random } from "./random.js";

/**
 * A rollout store and a notifier that keep everything they were ever given, so the oracle can check what
 * the library decided against what the world saw. The store is a correct compare-and-set store that can be
 * made to fail before a call, or after the write has landed.
 */

/** One version of a record, as it was saved. */
interface Saved {
  readonly record: RolloutRecord;
  readonly version: number;
  /** The true time it was saved. */
  readonly at: number;
}

interface StoreFaults {
  down: boolean;
  /** Chance a call fails before it does anything. */
  failChance: number;
  /** Chance a save lands and the call then fails. */
  lostReplyChance: number;
}

interface SimStore extends RolloutStore {
  readonly faults: StoreFaults;
  /** Every version of a rollout, oldest first. */
  readonly versions: (id: string) => readonly Saved[];
  readonly current: (id: string) => RolloutRecord;
  readonly counts: { saves: number; lost: number };
}

interface SimNotifier extends Notifier {
  /** Every call, repeats included. */
  readonly calls: RolloutEvent[];
  /** The notifier fails while this is true. */
  down: boolean;
}

interface StoreOptions {
  readonly now: () => number;
  readonly random: Random;
}

/** What the store holds: every version of every rollout, its faults, and counts of saves. */
interface Shelf {
  readonly options: StoreOptions;
  readonly rows: Map<string, Saved[]>;
  readonly faults: StoreFaults;
  readonly counts: SimStore["counts"];
}

function latest(shelf: Shelf, id: string): Saved | undefined {
  return shelf.rows.get(id)?.at(-1);
}

function fail(shelf: Shelf): void {
  if (shelf.faults.down || shelf.options.random.chance(shelf.faults.failChance)) {
    throw new Error("The store failed.");
  }
}

function unsettled(shelf: Shelf): RolloutRecord[] {
  return [...shelf.rows.keys()].flatMap((id) => {
    const record = latest(shelf, id)?.record;
    return record === undefined || record.settled ? [] : [record];
  });
}

function put(shelf: Shelf, record: RolloutRecord, version: number): void {
  shelf.rows.set(record.id, [...(shelf.rows.get(record.id) ?? []), { at: shelf.options.now(), record, version }]);
  if (shelf.options.random.chance(shelf.faults.lostReplyChance)) {
    throw new Error("The store timed out.");
  }
}

function create(shelf: Shelf, record: RolloutRecord): boolean {
  fail(shelf);
  if (shelf.rows.has(record.id) || unsettled(shelf).some((other) => other.plan.flagKey === record.plan.flagKey)) {
    return false;
  }
  put(shelf, record, 1);
  return true;
}

function save(shelf: Shelf, record: RolloutRecord, expectedVersion: number): number | null {
  fail(shelf);
  shelf.counts.saves += 1;
  if (latest(shelf, record.id)?.version !== expectedVersion) {
    shelf.counts.lost += 1;
    return null;
  }
  put(shelf, record, expectedVersion + 1);
  return expectedVersion + 1;
}

function load(shelf: Shelf, id: string): Stored | null {
  fail(shelf);
  const saved = latest(shelf, id);
  return saved === undefined ? null : { record: saved.record, version: saved.version };
}

function current(shelf: Shelf, id: string): RolloutRecord {
  const saved = latest(shelf, id);
  if (saved === undefined) {
    throw new Error(`No rollout ${id} was ever saved.`);
  }
  return saved.record;
}

/** The store's calls as the library makes them: each takes a moment, as a real one would. */
function portOf(shelf: Shelf): RolloutStore {
  return {
    create: async (record) => {
      await Promise.resolve();
      return create(shelf, record);
    },
    listUnsettled: async () => {
      await Promise.resolve();
      fail(shelf);
      return unsettled(shelf).map((record) => record.id);
    },
    load: async (id) => {
      await Promise.resolve();
      return load(shelf, id);
    },
    save: async (record, expectedVersion) => {
      await Promise.resolve();
      return save(shelf, record, expectedVersion);
    },
  };
}

function createSimStore(options: StoreOptions): SimStore {
  const shelf: Shelf = { counts: { lost: 0, saves: 0 }, faults: { down: false, failChance: 0, lostReplyChance: 0 }, options, rows: new Map<string, Saved[]>() };
  return { ...portOf(shelf), counts: shelf.counts, current: (id) => current(shelf, id), faults: shelf.faults, versions: (id) => shelf.rows.get(id) ?? [] };
}

function createSimNotifier(): SimNotifier {
  const notifier: SimNotifier = {
    calls: [],
    down: false,
    notify: async (event) => {
      await Promise.resolve();
      if (notifier.down) {
        throw new Error("The notifier is down.");
      }
      notifier.calls.push(event);
    },
  };
  return notifier;
}

export type { Saved, SimNotifier, SimStore, StoreFaults, StoreOptions };
export { createSimNotifier, createSimStore };
