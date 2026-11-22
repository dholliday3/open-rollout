/**
 * What the product sends to the metrics pipeline. Every event is stamped when it happened (`at`) and
 * reaches the pipeline later (`arrives`); the gap has a long tail, so events arrive out of order.
 */

type Arm = "control" | "treatment";

interface Sent {
  /** The distinct id the product knew the person by. */
  readonly id: number;
  /** When it happened. */
  readonly at: number;
  /** When the pipeline gets it. */
  readonly arrives: number;
}

/** The flag was evaluated for someone and answered with a variant. */
interface ExposureEvent extends Sent {
  readonly kind: "exposure";
  readonly arm: Arm;
}

/** One visit's worth of what a person did. */
interface ActivityEvent extends Sent {
  readonly kind: "activity";
  /** Names the event, so a second delivery of it can be told from a second event. */
  readonly key: number;
  readonly requests: number;
  readonly errors: number;
  readonly latency: number;
  readonly converted: boolean;
}

/** Two distinct ids turned out to be one person (they logged in). */
interface MergeEvent extends Sent {
  readonly kind: "merge";
  /** The id they are known by from now on. */
  readonly into: number;
}

type SimEvent = ExposureEvent | ActivityEvent | MergeEvent;

export type { ActivityEvent, Arm, ExposureEvent, MergeEvent, Sent, SimEvent };
