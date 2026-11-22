import type { Totals, Unit } from "./units.js";
import { contributionOf, dropRepeats, emptyTotals, tally } from "./units.js";
import type { Heap } from "./heap.js";
import type { SimEvent } from "./events.js";
import { createHeap } from "./heap.js";

/**
 * The metrics pipeline between the product and the metric source. Events reach it late and out of order,
 * some twice; a job removes the repeats later (so counts go down); a login merges two units into one or
 * shows a unit was on both arms; and only events up to `visibleUpTo` are counted, as a source that queries
 * "up to a minute ago" would.
 */

interface PipelineOptions {
  /** How often the job that removes repeated events runs. Zero removes them on arrival. */
  readonly dedupeEveryMs: number;
  /** Events newer than this far behind the clock are not counted yet. */
  readonly allowanceMs: number;
}

interface Pipeline {
  /** The product sends an event; it arrives when its `arrives` says. */
  readonly send: (event: SimEvent) => void;
  /** Takes in everything that has arrived by `now`. Does nothing while `frozen`. */
  readonly advance: (now: number) => void;
  /** Counts from this instant on; a new instant recounts everything received. */
  readonly countFrom: (since: number) => void;
  readonly totals: () => Totals;
  /** The oldest event still on its way, or infinity: everything before it has been counted. */
  readonly oldestInFlight: () => number;
  /** The newest event counted so far. */
  readonly newestCounted: () => number;
  /** The instant up to which arrived events are counted. */
  readonly visibleUpTo: () => number;
  /** The consumer has stopped: nothing new is taken in. */
  frozen: boolean;
  readonly counts: { sent: number; counted: number; repeatsDropped: number };
}

/** What the pipeline holds between calls. */
interface Works {
  readonly options: PipelineOptions;
  /** Sent, not yet arrived: ordered by when they arrive. */
  readonly inFlight: Heap<SimEvent>;
  /** Arrived, but newer than what is counted yet: ordered by when they happened. */
  readonly waiting: Heap<SimEvent>;
  readonly units: Map<number, Unit>;
  /** An id that turned out to be someone already known, and who. */
  readonly aliases: Map<number, number>;
  /** Units that may hold a repeated event. */
  readonly dirty: Set<Unit>;
  readonly counts: Pipeline["counts"];
  cut: number;
  lastDedupe: number;
  newest: number;
  since: number;
  totals: Totals;
  frozen: boolean;
}

function unitOf(works: Works, id: number): Unit {
  const key = works.aliases.get(id) ?? id,
    unit = works.units.get(key) ?? { activity: [], counted: null, exposures: [] };
  works.units.set(key, unit);
  return unit;
}

function recount(works: Works, unit: Unit): void {
  tally(works.totals, unit.counted, -1);
  unit.counted = contributionOf(unit, works.since);
  tally(works.totals, unit.counted, 1);
}

/** Two ids are one person: what the old id did moves to the one that is kept. */
function merge(works: Works, from: number, into: number): void {
  const old = unitOf(works, from),
    kept = unitOf(works, into);
  if (old === kept) {
    return;
  }
  tally(works.totals, old.counted, -1);
  works.units.delete(works.aliases.get(from) ?? from);
  works.aliases.set(from, works.aliases.get(into) ?? into);
  kept.exposures.push(...old.exposures);
  kept.activity.push(...old.activity);
  works.dirty.add(kept);
  recount(works, kept);
}

/** Files an exposure or a visit under its unit, and counts the unit again. */
function file(works: Works, event: Exclude<SimEvent, { kind: "merge" }>): void {
  const unit = unitOf(works, event.id);
  if (event.kind === "exposure") {
    unit.exposures.push({ arm: event.arm, at: event.at });
  } else {
    unit.activity.push(event);
    works.dirty.add(unit);
  }
  recount(works, unit);
}

function apply(works: Works, event: SimEvent): void {
  works.counts.counted += 1;
  works.newest = Math.max(works.newest, event.at);
  if (event.kind === "merge") {
    merge(works, event.id, event.into);
  } else {
    file(works, event);
  }
}

/** The job that removes repeated events, when it is due. Counts go down when it finds one. */
function dedupe(works: Works, now: number): void {
  if (now - works.lastDedupe < works.options.dedupeEveryMs) {
    return;
  }
  works.lastDedupe = now;
  for (const unit of works.dirty) {
    if (dropRepeats(unit)) {
      works.counts.repeatsDropped += 1;
      recount(works, unit);
    }
  }
  works.dirty.clear();
}

/** Moves on everything that is due in a heap: `isDue` says whether its least item is, `take` what to do with it. */
function drain(heap: Heap<SimEvent>, isDue: (event: SimEvent) => boolean, take: (event: SimEvent) => void): void {
  let next = heap.peek();
  while (next !== undefined && isDue(next)) {
    heap.pop();
    take(next);
    next = heap.peek();
  }
}

function advance(works: Works, now: number): void {
  if (works.frozen) {
    return;
  }
  drain(
    works.inFlight,
    (event) => event.arrives <= now,
    (event) => {
      works.waiting.push(event);
    },
  );
  works.cut = now - works.options.allowanceMs;
  drain(
    works.waiting,
    (event) => event.at <= works.cut,
    (event) => {
      apply(works, event);
    },
  );
  dedupe(works, now);
}

function countFrom(works: Works, since: number): void {
  if (since === works.since) {
    return;
  }
  works.since = since;
  works.totals = emptyTotals();
  for (const unit of works.units.values()) {
    unit.counted = null;
    recount(works, unit);
  }
}

function oldestInFlight(works: Works): number {
  let oldest = works.waiting.peek()?.at ?? Number.POSITIVE_INFINITY;
  for (const event of works.inFlight.items()) {
    oldest = Math.min(oldest, event.at);
  }
  return oldest;
}

function newWorks(options: PipelineOptions): Works {
  return {
    aliases: new Map<number, number>(),
    counts: { counted: 0, repeatsDropped: 0, sent: 0 },
    cut: Number.NEGATIVE_INFINITY,
    dirty: new Set<Unit>(),
    frozen: false,
    inFlight: createHeap<SimEvent>((event) => event.arrives),
    lastDedupe: Number.NEGATIVE_INFINITY,
    newest: Number.NEGATIVE_INFINITY,
    options,
    since: Number.NEGATIVE_INFINITY,
    totals: emptyTotals(),
    units: new Map<number, Unit>(),
    waiting: createHeap<SimEvent>((event) => event.at),
  };
}

function createPipeline(options: PipelineOptions): Pipeline {
  const works = newWorks(options);
  return {
    advance: (now) => {
      advance(works, now);
    },
    countFrom: (since) => {
      countFrom(works, since);
    },
    counts: works.counts,
    get frozen() {
      return works.frozen;
    },
    set frozen(value: boolean) {
      works.frozen = value;
    },
    newestCounted: () => works.newest,
    oldestInFlight: () => oldestInFlight(works),
    send: (event) => {
      works.counts.sent += 1;
      works.inFlight.push(event);
    },
    totals: () => works.totals,
    visibleUpTo: () => works.cut,
  };
}

export type { Pipeline, PipelineOptions };
export { createPipeline };
