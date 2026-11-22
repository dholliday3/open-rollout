import type { FlagControl, FlagReading } from "../ports.js";
import type { Allocation } from "../allocation.js";
import { NOBODY } from "../allocation.js";
import type { Random } from "./random.js";

/**
 * A flag provider's management side, modelled on PostHog: one flag is one whole state with a version that
 * goes up on every change. The library talks to `control`; the simulation reads the truth (`serving`,
 * `servedAt`, `changes`) that the library never sees, and breaks the API through `faults`.
 */

/** One change that really landed, whoever made it. */
interface FlagChange {
  readonly at: number;
  readonly allocation: Allocation;
  readonly revision: number;
  /** Who made it: a worker's name, or a person's. */
  readonly by: string;
}

/** Ways the management API misbehaves. All off by default. */
interface ProviderFaults {
  /** Every call fails. */
  down: boolean;
  /** Reads fail while writes still work. */
  readsDown: boolean;
  /** Writes fail while reads still work. */
  writesDown: boolean;
  /** Chance a call fails before it does anything (a 5xx, a rate limit). */
  failChance: number;
  /** Chance a write lands and the call then fails (a timeout after the write). */
  lostReplyChance: number;
  /** For this long after a change, a read may still answer with the state before it. */
  staleReadMs: number;
  staleReadChance: number;
  /** A write answers with a revision this much above the one it really left the flag at. */
  revisionOverstatedBy: number;
}

interface ProviderOptions {
  /** The true time. */
  readonly now: () => number;
  readonly random: Random;
  /** Whether a write whose expected revision is stale is refused (409), as PostHog's versioned calls do. */
  readonly checksRevision: boolean;
}

interface SimProvider {
  /** The management API as one caller sees it; `by` names that caller in the list of changes. */
  readonly controlFor: (by: string) => FlagControl;
  readonly faults: ProviderFaults;
  /** What the flag really is right now. */
  readonly serving: (flagKey: string) => FlagChange;
  /** What the flag really was at an instant. */
  readonly servedAt: (flagKey: string, at: number) => Allocation;
  readonly changes: (flagKey: string) => readonly FlagChange[];
  /** A person changing the flag in the provider's console. */
  readonly setByHand: (flagKey: string, allocation: Allocation, by?: string) => void;
  /** The flag is deleted and made again under the same key: it serves this, and its revision starts over at 1. */
  readonly recreate: (flagKey: string, allocation: Allocation) => void;
  readonly counts: { reads: number; writes: number; landed: number; refused: number };
}

/** What the provider holds: every flag's changes, its faults, and counts of what was asked of it. */
interface State {
  readonly options: ProviderOptions;
  readonly flags: Map<string, FlagChange[]>;
  readonly faults: ProviderFaults;
  readonly counts: SimProvider["counts"];
}

interface WriteRequest {
  readonly flagKey: string;
  readonly allocation: Allocation;
  readonly expectedRevision: number | undefined;
}

const NO_FAULTS: ProviderFaults = { down: false, failChance: 0, lostReplyChance: 0, readsDown: false, revisionOverstatedBy: 0, staleReadChance: 0, staleReadMs: 0, writesDown: false },
  NEVER: FlagChange = { allocation: NOBODY, at: Number.NEGATIVE_INFINITY, by: "nobody", revision: 0 },
  THE_ONE_BEFORE = -2;

function changesOf(state: State, flagKey: string): FlagChange[] {
  const known = state.flags.get(flagKey) ?? [NEVER];
  state.flags.set(flagKey, known);
  return known;
}

function servingNow(state: State, flagKey: string): FlagChange {
  return changesOf(state, flagKey).at(-1) ?? NEVER;
}

function land(state: State, change: { flagKey: string; allocation: Allocation; by: string }): void {
  state.counts.landed += 1;
  changesOf(state, change.flagKey).push({ allocation: change.allocation, at: state.options.now(), by: change.by, revision: servingNow(state, change.flagKey).revision + 1 });
}

function fail(state: State, broken: boolean, what: string): void {
  if (state.faults.down || broken || state.options.random.chance(state.faults.failChance)) {
    throw new Error(`The flag provider failed to ${what}.`);
  }
}

function read(state: State, flagKey: string): FlagReading {
  state.counts.reads += 1;
  fail(state, state.faults.readsDown, "read");
  const now = servingNow(state, flagKey),
    before = changesOf(state, flagKey).at(THE_ONE_BEFORE),
    stale = before !== undefined && state.options.now() - now.at < state.faults.staleReadMs && state.options.random.chance(state.faults.staleReadChance),
    answer = stale ? before : now;
  return { allocation: answer.allocation, revision: answer.revision };
}

/** Makes a write and answers with the revision it left the flag at (plus `revisionOverstatedBy`, when the provider lies). */
function write(state: State, by: string, request: WriteRequest): number {
  state.counts.writes += 1;
  fail(state, state.faults.writesDown, "write");
  if (state.options.checksRevision && request.expectedRevision !== undefined && request.expectedRevision !== servingNow(state, request.flagKey).revision) {
    state.counts.refused += 1;
    throw new Error("409: the flag changed since it was read.");
  }
  land(state, { allocation: request.allocation, by, flagKey: request.flagKey });
  if (state.options.random.chance(state.faults.lostReplyChance)) {
    throw new Error("The flag provider timed out.");
  }
  return servingNow(state, request.flagKey).revision + state.faults.revisionOverstatedBy;
}

function servedAt(state: State, flagKey: string, at: number): Allocation {
  let serving = NOBODY;
  for (const change of changesOf(state, flagKey)) {
    serving = change.at <= at ? change.allocation : serving;
  }
  return serving;
}

function controlOf(state: State, by: string): FlagControl {
  return {
    read: async (flagKey) => {
      await Promise.resolve();
      return read(state, flagKey);
    },
    refusesStaleWrites: state.options.checksRevision,
    write: async (flagKey, allocation, expectedRevision) => {
      await Promise.resolve();
      return write(state, by, { allocation, expectedRevision, flagKey });
    },
  };
}

function createSimProvider(options: ProviderOptions): SimProvider {
  const state: State = { counts: { landed: 0, reads: 0, refused: 0, writes: 0 }, faults: { ...NO_FAULTS }, flags: new Map<string, FlagChange[]>(), options };
  return {
    changes: (flagKey) => changesOf(state, flagKey),
    controlFor: (by) => controlOf(state, by),
    counts: state.counts,
    faults: state.faults,
    servedAt: (flagKey, at) => servedAt(state, flagKey, at),
    serving: (flagKey) => servingNow(state, flagKey),
    recreate: (flagKey, allocation) => {
      changesOf(state, flagKey).push({ allocation, at: state.options.now(), by: "person: made the flag again", revision: 1 });
    },
    setByHand: (flagKey, allocation, by = "a person") => {
      land(state, { allocation, by, flagKey });
    },
  };
}

export type { FlagChange, ProviderFaults, ProviderOptions, SimProvider };
export { createSimProvider };
