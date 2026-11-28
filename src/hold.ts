import type { Observation } from "./observation.js";
import type { RolloutRecord } from "./record.js";
import { isOpen } from "./observation.js";
import { withEvent } from "./record.js";

/**
 * An incident across the whole product hits both arms alike, so no guardrail sees it. While one is open a
 * rollout raises no exposure and goes through no gate; guardrails still watch, and a rollback still wins.
 * The hold lifts by itself when the incident clears.
 */

/**
 * Why nothing may raise exposure right now for the state of the product, or null. A feed that couldn't be
 * read is no all-clear. A release a person forced is theirs to make, as it is without metrics.
 */
function holdOf(record: RolloutRecord, observation: Observation): string | null {
  const { incidents } = observation;
  if (incidents === undefined || record.outcome?.reason === "forced") {
    return null;
  }
  if (incidents === null) {
    return "The incident feed can't be read, so an incident can't be ruled out.";
  }
  return incidents.length === 0 ? null : `${incidents.map((incident) => incident.title).join("; ")}: an incident is open.`;
}

/** The record with the hold noted as it starts and as it lifts, one event each. A rollout that has finished just forgets it. */
function noteHold(record: RolloutRecord, hold: string | null, now: number): RolloutRecord {
  const current = record.hold ?? null;
  if (current !== null && !isOpen(record)) {
    return { ...record, hold: null };
  }
  if (current !== null && hold === null) {
    return withEvent({ ...record, clock: now, hold: null }, { at: now, detail: "The incident has cleared. Carrying on.", type: "incident_cleared" });
  }
  if (current === null && hold !== null && isOpen(record) && record.phase !== "paused") {
    return withEvent({ ...record, clock: now, hold: { detail: hold, since: now } }, { at: now, detail: `Holding where it is. ${hold}`, type: "incident_hold" });
  }
  return record;
}

export { holdOf, noteHold };
