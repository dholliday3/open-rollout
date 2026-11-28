import type { Allocation } from "./allocation.js";
import type { Interval } from "./stats.js";
import { NOBODY } from "./allocation.js";
import type { RolloutPlan } from "./plan.js";

/**
 * Where a rollout is.
 * - `awaiting_approval`: traffic stays where it is until a person approves the next move.
 * - `ramping`: a step is being applied or watched.
 * - `paused`: held where it is; guardrails still watch, and nothing raises exposure.
 * - `rolling_back` / `releasing`: the flag is being set to nobody / everybody.
 * - `rolled_back` / `released`: done, and watched a little longer before it settles.
 */
type Phase = "awaiting_approval" | "ramping" | "paused" | "rolling_back" | "rolled_back" | "releasing" | "released";

/** What a person approves: moving to a step, or the release to everybody. */
type Gate = number | "release";

/** `unproven`: the last step ran out of time before every goal was shown better. */
type PauseReason = "manual" | "regression" | "sample_ratio_mismatch" | "contaminated" | "insufficient_data" | "unproven" | "external_change";

type RollbackReason = "manual" | "regression" | "sample_ratio_mismatch" | "insufficient_data" | "unproven" | "metrics_outage" | "expired";

type EventType =
  | "started"
  | "awaiting_approval"
  | "approved"
  | "step_started"
  | "paused"
  | "resumed"
  | "metrics_outage"
  | "metrics_restored"
  | "drift_corrected"
  | "external_change"
  | "incident_hold"
  | "incident_cleared"
  | "rolling_back"
  | "rolled_back"
  | "releasing"
  | "released";

/** A guardrail's reading: what each arm measured and how far apart they are. */
interface Finding {
  readonly metric: string;
  readonly control: number;
  readonly treatment: number;
  readonly difference: Interval;
  readonly units: { readonly control: number; readonly treatment: number };
  /** False while the reading is too wide to rule out what its guardrail must rule out; such a reading can't pass a step. */
  readonly conclusive: boolean;
  /** On a goal only: true once the new behaviour is shown better by more than `mustImproveBy`. The release waits for it. */
  readonly improved?: boolean;
}

/** Something a person should hear about. `key` is the same however often it is sent. */
interface RolloutEvent {
  readonly key: string;
  readonly rolloutId: string;
  readonly flagKey: string;
  readonly type: EventType;
  readonly at: number;
  /** One plain sentence. */
  readonly detail: string;
  readonly finding?: Finding;
}

interface Pause {
  readonly reason: PauseReason;
  readonly since: number;
  readonly detail: string;
}

/** An incident across the product is holding the rollout where it is. It lifts by itself when the incident clears. */
interface Hold {
  readonly since: number;
  readonly detail: string;
}

interface Baseline {
  readonly control: number;
  readonly treatment: number;
  /** When the snapshot was taken, on the metric source's clock, so no worker's clock and no lag can shorten a watch. */
  readonly asOf: number;
  /**
   * False while the counts come from data complete only up to before `asOf`: a unit exposed just before the
   * step, whose exposure hadn't been counted yet, would later look new. They are taken again from the first
   * snapshot whose watermark has reached `asOf`. A record from before this was kept has none, and its counts
   * are taken as they are.
   */
  readonly complete?: boolean;
}

/** The last time a tick set out to write the flag. */
interface WriteAttempt {
  /** Which wish it was writing. */
  readonly epoch: number;
  readonly at: number;
  /** The flag's revision when the write was sent; null when the flag couldn't be read and the write went out blind. A flag still at it has not taken the write. */
  readonly base: number | null;
  /** What the flag served when the write was sent; null when that isn't known. */
  readonly over: Allocation | null;
}

/** A command this rollout has been sent, and why it was refused if it was. */
interface CommandEntry {
  readonly id: string;
  /** What it asked for. The same id asking for something else is another command, not this one again. */
  readonly ask: string;
  readonly refusal: string | null;
}

interface Outcome {
  readonly reason: RollbackReason | "completed" | "forced";
  readonly at: number;
  readonly detail: string;
  readonly finding?: Finding;
}

/**
 * Everything about one rollout. This record, not the runtime driving it, is the rollout: any worker can
 * load it and carry on, and a worker acts only on what it managed to save here.
 */
interface RolloutRecord {
  /** The record's shape, `RECORD_SCHEMA_VERSION` of the package that made it, so a store can tell an older record from a newer one. */
  readonly schemaVersion: number;
  readonly id: string;
  readonly plan: RolloutPlan;
  readonly phase: Phase;
  /** The step traffic is on, or headed to; -1 before the first. */
  readonly stepIndex: number;
  /** What the flag should serve. Writes only ever copy this. */
  readonly desired: Allocation;
  /** Counts changes to `desired`. */
  readonly epoch: number;
  /** The last epoch seen in force on the flag. Behind `epoch` while a write is still owed. */
  readonly confirmedEpoch: number;
  /** When the current `desired` was first seen in force; null while it is owed. */
  readonly confirmedAt: number | null;
  /**
   * Where the current step's watch began: the units each arm had, and the metrics' watermark, in the first
   * snapshot taken after the step was seen in force. A step needs new units and watched time on top of it.
   */
  readonly freshBaseline: Baseline | null;
  /** Units each arm had when the last step passed. The next step never starts counting from below this. */
  readonly unitsFloor: { readonly control: number; readonly treatment: number };
  /** Behind `epoch` until a write for the current wish has gone out. */
  readonly attempt: WriteAttempt | null;
  readonly startedAt: number;
  /** When the new behaviour was first sent to anyone, seen to land or not; guardrails start here. Null until then. */
  readonly exposedSince: number | null;
  /** Evidence is counted from here. Moves forward when a person resumes past a regression. */
  readonly monitoringSince: number;
  readonly lastProgressAt: number;
  /** The latest time this record was changed at; time never runs backwards past it. */
  readonly clock: number;
  readonly pause: Pause | null;
  /** Set while an incident holds the rollout; missing on a record from before holds. */
  readonly hold?: Hold | null;
  readonly pendingGate: Gate | null;
  readonly approvedGates: readonly Gate[];
  readonly outcome: Outcome | null;
  /** Since when the metrics have been missing or stale; null while they are fine. */
  readonly blindSince: number | null;
  readonly outageReported: boolean;
  /** True once a change the rollout didn't make has been reported, until the flag matches again. */
  readonly correctingDrift: boolean;
  /** The highest revision of the flag this rollout has read or written. A reading below it is a read that is behind. */
  readonly seenRevision: number | null;
  /** Since when every reading of the flag has been below `seenRevision`; null while the flag reads at or above it. */
  readonly behindSince: number | null;
  /** True once people have been told the release is on its way, so a release that has to be sent again isn't announced again. */
  readonly releaseAnnounced: boolean;
  /** Every command this rollout was sent, so one sent again gets the answer it got the first time. */
  readonly commands: readonly CommandEntry[];
  readonly eventCount: number;
  /** Events saved but not yet known to be delivered. */
  readonly outbox: readonly RolloutEvent[];
  /** Nothing more will happen; ticks stop. */
  readonly settled: boolean;
}

const MAX_OUTBOX = 100,
  /** Goes up when a release changes what a record holds in a way an older record can't be read as. */
  RECORD_SCHEMA_VERSION = 1;

function isLive(record: RolloutRecord): boolean {
  return record.phase === "ramping" || record.phase === "awaiting_approval" || record.phase === "paused";
}

function isDone(record: RolloutRecord): boolean {
  return record.phase === "rolled_back" || record.phase === "released";
}

/** What an event says. A note with no finding leaves it out of the event, so a record read back from JSON is the same record. */
interface EventNote {
  readonly at: number;
  readonly detail: string;
  readonly type: EventType;
  readonly finding?: Finding | undefined;
}

/** The record with one more event to deliver. */
function withEvent(record: RolloutRecord, { finding, ...note }: EventNote): RolloutRecord {
  const eventCount = record.eventCount + 1,
    full: RolloutEvent = { ...note, ...(finding === undefined ? {} : { finding }), flagKey: record.plan.flagKey, key: `${record.id}:${eventCount}`, rolloutId: record.id };
  return { ...record, eventCount, outbox: [...record.outbox, full].slice(-MAX_OUTBOX) };
}

function withCommand(record: RolloutRecord, entry: CommandEntry): RolloutRecord {
  return { ...record, commands: [...record.commands, entry] };
}

/** A rollout that has done nothing yet: nobody exposed, waiting to enter its first step. */
function newRecord(id: string, plan: RolloutPlan, now: number): RolloutRecord {
  return {
    approvedGates: [],
    attempt: null,
    behindSince: null,
    blindSince: null,
    clock: now,
    commands: [],
    confirmedAt: now,
    confirmedEpoch: 0,
    correctingDrift: false,
    desired: NOBODY,
    epoch: 0,
    eventCount: 0,
    exposedSince: null,
    freshBaseline: null,
    id,
    lastProgressAt: now,
    monitoringSince: now,
    outageReported: false,
    outbox: [],
    outcome: null,
    pause: null,
    pendingGate: 0,
    phase: "awaiting_approval",
    plan,
    releaseAnnounced: false,
    schemaVersion: RECORD_SCHEMA_VERSION,
    seenRevision: null,
    settled: false,
    startedAt: now,
    stepIndex: -1,
    unitsFloor: { control: 0, treatment: 0 },
  };
}

export type { Baseline, CommandEntry, EventType, Finding, Gate, Hold, Outcome, Pause, PauseReason, Phase, RollbackReason, RolloutEvent, RolloutRecord, WriteAttempt };
export { RECORD_SCHEMA_VERSION, isDone, isLive, newRecord, withCommand, withEvent };
