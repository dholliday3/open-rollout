import type { Arm } from "./events.js";

/**
 * What really happened to real people, kept apart from everything the library can see. The oracle's
 * invariants and the harm counts are read off this, never off the rollout's record or the metric source.
 */
interface Truth {
  /** When each person was first really served each arm, in the order it happened. */
  readonly firstServed: Record<Arm, number[]>;
  /** The last time each person was served the new behaviour. */
  readonly lastTreatment: Map<number, number>;
  readonly visits: Record<Arm, number>;
  readonly requests: Record<Arm, number>;
  readonly errors: Record<Arm, number>;
  /** People who were really served both arms. */
  bothArms: number;
  readonly onControl: Set<number>;
}

interface ServedVisit {
  readonly person: number;
  readonly arm: Arm;
  readonly at: number;
  readonly requests: number;
  readonly errors: number;
}

function createTruth(): Truth {
  return {
    bothArms: 0,
    errors: { control: 0, treatment: 0 },
    firstServed: { control: [], treatment: [] },
    lastTreatment: new Map<number, number>(),
    onControl: new Set<number>(),
    requests: { control: 0, treatment: 0 },
    visits: { control: 0, treatment: 0 },
  };
}

function count(truth: Truth, visit: ServedVisit): void {
  truth.visits[visit.arm] += 1;
  truth.requests[visit.arm] += visit.requests;
  truth.errors[visit.arm] += visit.errors;
}

/** True when this is the person's first visit on this arm. */
function noteServed(truth: Truth, visit: ServedVisit): boolean {
  const hadControl = truth.onControl.has(visit.person),
    hadTreatment = truth.lastTreatment.has(visit.person),
    first = visit.arm === "treatment" ? !hadTreatment : !hadControl;
  count(truth, visit);
  if (first) {
    truth.firstServed[visit.arm].push(visit.at);
    truth.bothArms += (visit.arm === "treatment" ? hadControl : hadTreatment) ? 1 : 0;
  }
  if (visit.arm === "treatment") {
    truth.lastTreatment.set(visit.person, visit.at);
  } else {
    truth.onControl.add(visit.person);
  }
  return first;
}

/** People first served an arm inside a window of time. */
function firstServedBetween(truth: Truth, arm: Arm, window: { from: number; to: number }): number {
  return truth.firstServed[arm].filter((at) => at >= window.from && at <= window.to).length;
}

/** People served the new behaviour at any time after an instant. */
function servedTreatmentAfter(truth: Truth, at: number): number {
  let people = 0;
  for (const last of truth.lastTreatment.values()) {
    people += last > at ? 1 : 0;
  }
  return people;
}

export type { ServedVisit, Truth };
export { createTruth, firstServedBetween, noteServed, servedTreatmentAfter };
