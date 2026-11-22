import type { FlagReading, MetricSnapshot } from "./ports";
import type { RolloutRecord } from "./record";
import { sameAllocation } from "./allocation";
import { snapshotProblem } from "./judge";

/**
 * What one tick saw. A null is a read that failed, which is never taken as good news. The metrics are read
 * after the flag: a snapshot that arrives with a flag reading was asked for after that reading was made.
 */
interface Observation {
  readonly flag: FlagReading | null;
  readonly metrics: MetricSnapshot | null;
  /** The provider's own word on whether a stale write can land (`FlagControl.refusesStaleWrites`). */
  readonly staleWritesRefused: boolean;
}

/**
 * One tick's two clocks. `wall` is the worker's own. `now` is the same, but never earlier than the record
 * has already seen, so what is stamped on the record only moves forward. Freshness is judged on `wall`: a
 * worker with a fast clock must not make the next worker think the metrics are old.
 */
interface Time {
  readonly now: number;
  readonly wall: number;
}

/** The snapshot if it says anything about now; null when it is missing, too old, or can't be right. */
function usable(record: RolloutRecord, metrics: MetricSnapshot | null, time: Time): MetricSnapshot | null {
  if (metrics === null || snapshotProblem(record.plan, metrics) !== null) {
    return null;
  }
  return time.wall - metrics.watermark <= record.plan.limits.maxStalenessMs ? metrics : null;
}

/** True when the flag was read and serves exactly what the record wants. */
function isInForce(record: RolloutRecord, flag: FlagReading | null): flag is FlagReading {
  return flag !== null && sameAllocation(flag.allocation, record.desired);
}

/** True until a rollout is undone or has landed: the phases in which the new behaviour may still spread. */
function isOpen(record: RolloutRecord): boolean {
  return record.phase === "ramping" || record.phase === "awaiting_approval" || record.phase === "paused" || record.phase === "releasing";
}

export type { Observation, Time };
export { isInForce, isOpen, usable };
