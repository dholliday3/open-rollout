import type { Observation } from "./observation";
import type { Ports } from "./ports";
import type { RolloutRecord } from "./record";
import { isOpen } from "./observation";
import { isValidAllocation } from "./allocation";
import { snapshotProblem } from "./judge";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The metrics are read whenever a guarded rollout could still spread: exposure is never raised without them. */
function needsMetrics(record: RolloutRecord): boolean {
  return isOpen(record) && record.plan.guardrails.length > 0;
}

async function readFlag(ports: Ports, record: RolloutRecord, problems: string[]): Promise<Observation["flag"]> {
  try {
    const reading = await ports.flags.read(record.plan.flagKey);
    if (record.seenRevision !== null && reading.revision < record.seenRevision) {
      // Still handed on: `decide` is what ignores it. Said here so a provider stuck on an old answer is not silent.
      problems.push(`The flag provider answered at revision ${reading.revision}, behind ${record.seenRevision} already seen. Ignoring that reading.`);
    }
    if (isValidAllocation(reading.allocation) && Number.isFinite(reading.revision)) {
      return reading;
    }
    // A reading that isn't an allocation says nothing about the flag, so it is treated as no reading.
    problems.push("The flag provider answered with shares that can't be right.");
    return null;
  } catch (error) {
    problems.push(`Reading the flag failed: ${messageOf(error)}`);
    return null;
  }
}

async function readMetrics(ports: Ports, record: RolloutRecord, problems: string[]): Promise<Observation["metrics"]> {
  if (!needsMetrics(record)) {
    return null;
  }
  try {
    const snapshot = await ports.metrics.snapshot({ flagKey: record.plan.flagKey, guardrails: record.plan.guardrails, since: record.monitoringSince }),
      problem = snapshotProblem(record.plan, snapshot);
    if (problem !== null) {
      problems.push(problem);
    }
    return snapshot;
  } catch (error) {
    problems.push(`Reading the metrics failed: ${messageOf(error)}`);
    return null;
  }
}

export { messageOf, readFlag, readMetrics };
