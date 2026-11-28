import type { FlagControl, FlagReading, MetricSnapshot, MetricSource, Notifier, RolloutStore, Stored } from "../ports.js";
import type { RolloutEvent, RolloutRecord } from "../record.js";
import type { Allocation } from "../allocation.js";
import { NOBODY } from "../allocation.js";

/** A flag provider in memory that compares revisions, with a back door for a test to change a flag by hand. */
interface MemoryFlags extends FlagControl {
  /** Changes a flag as a person in the provider's console would. */
  setByHand: (flagKey: string, allocation: Allocation) => void;
  peek: (flagKey: string) => FlagReading;
}

/** A notifier that keeps what it was sent, once per key. */
interface MemoryNotifier extends Notifier {
  readonly events: RolloutEvent[];
}

/** A metric source that answers with whatever a test last gave it. */
interface MemoryMetrics extends MetricSource {
  /** The next snapshots are this one; null makes the source fail. */
  set: (snapshot: MetricSnapshot | null) => void;
  /** Units an hour that `traffic` answers; until it is set, or after null, `traffic` fails. */
  setTraffic: (unitsPerHour: number | null) => void;
  readonly traffic: NonNullable<MetricSource["traffic"]>;
}

function createMemoryStore(): RolloutStore {
  const rows = new Map<string, Stored>(),
    holdsFlag = (record: RolloutRecord): boolean => [...rows.values()].some((row) => !row.record.settled && row.record.plan.flagKey === record.plan.flagKey);
  return {
    create: async (record) => {
      await Promise.resolve();
      if (rows.has(record.id) || holdsFlag(record)) {
        return false;
      }
      rows.set(record.id, { record, version: 1 });
      return true;
    },
    listUnsettled: async () => {
      await Promise.resolve();
      return [...rows.values()].filter((row) => !row.record.settled).map((row) => row.record.id);
    },
    load: async (id) => {
      await Promise.resolve();
      return rows.get(id) ?? null;
    },
    save: async (record, expectedVersion) => {
      await Promise.resolve();
      if (rows.get(record.id)?.version !== expectedVersion) {
        return null;
      }
      rows.set(record.id, { record, version: expectedVersion + 1 });
      return expectedVersion + 1;
    },
  };
}

function createMemoryFlags(): MemoryFlags {
  const flags = new Map<string, { allocation: Allocation; revision: number }>(),
    peek = (flagKey: string): FlagReading => {
      const flag = flags.get(flagKey);
      return { allocation: flag?.allocation ?? NOBODY, revision: flag?.revision ?? 0 };
    },
    setByHand = (flagKey: string, allocation: Allocation): void => {
      flags.set(flagKey, { allocation, revision: peek(flagKey).revision + 1 });
    };
  return {
    peek,
    read: async (flagKey) => {
      await Promise.resolve();
      return peek(flagKey);
    },
    refusesStaleWrites: true,
    setByHand,
    write: async (flagKey, allocation, expectedRevision) => {
      await Promise.resolve();
      if (expectedRevision !== undefined && expectedRevision !== peek(flagKey).revision) {
        throw new Error("The flag changed since it was read.");
      }
      setByHand(flagKey, allocation);
      return peek(flagKey).revision;
    },
  };
}

function createMemoryNotifier(): MemoryNotifier {
  const events: RolloutEvent[] = [];
  return {
    events,
    notify: async (event) => {
      await Promise.resolve();
      if (!events.some((seen) => seen.key === event.key)) {
        events.push(event);
      }
    },
  };
}

function createMemoryMetrics(): MemoryMetrics {
  let current: MetricSnapshot | null = null,
    perHour: number | null = null;
  return {
    set: (snapshot) => {
      current = snapshot;
    },
    setTraffic: (unitsPerHour) => {
      perHour = unitsPerHour;
    },
    snapshot: async () => {
      await Promise.resolve();
      if (current === null) {
        throw new Error("The metric source is down.");
      }
      return current;
    },
    traffic: async () => {
      await Promise.resolve();
      if (perHour === null) {
        throw new Error("The metric source can't say how much traffic the flag gets.");
      }
      return perHour;
    },
  };
}

export type { MemoryFlags, MemoryMetrics, MemoryNotifier };
export { createMemoryFlags, createMemoryMetrics, createMemoryNotifier, createMemoryStore };
