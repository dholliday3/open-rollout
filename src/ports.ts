import type { RolloutEvent, RolloutRecord } from "./record.js";
import type { Allocation } from "./allocation.js";
import type { ArmSample } from "./stats.js";
import type { Guardrail } from "./plan.js";

/**
 * What a flag serves right now, and its revision: a number that goes up every time anyone changes anything
 * about the flag, and never comes back down. A reading with a lower revision than one already seen is a
 * read that is behind (a replica, a cache), and the rollout ignores it.
 */
interface FlagReading {
  readonly allocation: Allocation;
  readonly revision: number;
}

/**
 * The flag provider. Two calls, both about one flag's whole state: no increments, so a repeated or late
 * call can only set the flag to something the rollout once wanted.
 */
interface FlagControl {
  /**
   * True when `write` refuses a write whose `expectedRevision` is stale. On such a provider a stalled
   * worker's late write can never land, so any change the rollout didn't make is a person's.
   */
  readonly refusesStaleWrites: boolean;
  read: (flagKey: string) => Promise<FlagReading>;
  /**
   * Sets the flag to exactly this allocation and returns the revision that leaves the flag at. A provider
   * that can compare revisions refuses when the flag changed since `expectedRevision`; one that can't just
   * writes, and the next tick puts a late write right.
   */
  write: (flagKey: string, allocation: Allocation, expectedRevision?: number) => Promise<number>;
  /**
   * Why this flag can't take a rollout's steps as it is set up, or null when it can. Asked once, before a
   * rollout starts, so a flag no step can be written to is refused at the start instead of failing every tick.
   */
  readonly setupProblem?: (flagKey: string) => Promise<string | null>;
}

interface MetricQuery {
  readonly flagKey: string;
  /** Count units first exposed, and what they did, from this instant on. */
  readonly since: number;
  readonly guardrails: readonly Guardrail[];
}

interface ArmPair<Value> {
  readonly control: Value;
  readonly treatment: Value;
}

interface MetricSnapshot {
  /** When the source took this snapshot, on the source's own clock. */
  readonly asOf: number;
  /** The data is complete up to this instant, on the same clock; later events may still be on their way. Never after `asOf`. */
  readonly watermark: number;
  /** Units by the arm they were first exposed on. */
  readonly exposed: ArmPair<number>;
  /** Units seen on both arms, left out of everything else. */
  readonly contaminated: number;
  /** Each guardrail's totals, by its metric's name. */
  readonly metrics: Readonly<Record<string, ArmPair<ArmSample>>>;
}

interface TrafficQuery {
  readonly flagKey: string;
  /** Count over this long, up to now. */
  readonly windowMs: number;
}

/** Where exposures and metric events are counted. */
interface MetricSource {
  snapshot: (query: MetricQuery) => Promise<MetricSnapshot>;
  /**
   * Units an hour, each counted once over the window, that evaluated the flag whatever it served them: how
   * fast a rollout's steps can gather new units. Optional; without it a plan can't be sized to the traffic.
   */
  readonly traffic?: (query: TrafficQuery) => Promise<number>;
}

/** Something wrong across the whole product right now, such as a monitor in alert. */
interface Incident {
  readonly id: string;
  /** What is wrong, in a few words, for the rollout's events. */
  readonly title: string;
}

/**
 * Where the product's incidents are known: a monitoring system. An incident hits both arms alike, so no
 * guardrail can see it; while any is open a rollout raises no exposure and goes through no gate.
 */
interface IncidentFeed {
  /** The incidents open now. An empty list is the all-clear; a call that throws is no answer, and holds. */
  open: () => Promise<readonly Incident[]>;
}

interface Stored {
  readonly record: RolloutRecord;
  readonly version: number;
}

/**
 * Where a rollout's record lives. The record is the rollout: a runtime that loses its own state loses
 * nothing. Every write is compare-and-set on `version`, so two workers can't both act on one decision.
 */
interface RolloutStore {
  /** Inserts a new record at version 1. False when the id is taken or the flag already has an unsettled rollout. */
  create: (record: RolloutRecord) => Promise<boolean>;
  load: (id: string) => Promise<Stored | null>;
  /** Replaces the record only if it is still at `expectedVersion`; returns the new version, or null when it lost. */
  save: (record: RolloutRecord, expectedVersion: number) => Promise<number | null>;
  /** Ids of rollouts that still need ticks. */
  listUnsettled: () => Promise<string[]>;
}

/** Tells people. May be called twice for one event; `event.key` names it so the second call can be dropped. */
interface Notifier {
  notify: (event: RolloutEvent) => Promise<void>;
}

interface Ports {
  readonly flags: FlagControl;
  readonly metrics: MetricSource;
  readonly store: RolloutStore;
  readonly notifier: Notifier;
  /** Optional. Without it nothing holds a rollout for an incident that hits both arms. */
  readonly incidents?: IncidentFeed;
}

export type { ArmPair, FlagControl, FlagReading, Incident, IncidentFeed, MetricQuery, MetricSnapshot, MetricSource, Notifier, Ports, RolloutStore, Stored, TrafficQuery };
