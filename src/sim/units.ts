import type { ActivityEvent, Arm } from "./events";

/**
 * How the pipeline counts people: one unit per person it knows of, on the arm of its first exposure, with
 * what it did from that exposure on. Totals per arm are kept as running sums, and a unit's share of them is
 * taken out and put back whenever a late event changes what the unit is.
 */

interface UnitExposure {
  readonly at: number;
  readonly arm: Arm;
}

/** What one unit adds to its arm's totals. */
interface Contribution {
  readonly arm: Arm | "both";
  readonly errors: number;
  readonly requests: number;
  readonly latency: number;
  readonly converted: number;
}

interface Unit {
  exposures: UnitExposure[];
  activity: ActivityEvent[];
  counted: Contribution | null;
}

/** Running sums over an arm's units. */
interface ArmTotals {
  units: number;
  hadError: number;
  converted: number;
  errors: number;
  errorsSquared: number;
  requests: number;
  requestsSquared: number;
  errorsTimesRequests: number;
  latency: number;
  latencySquared: number;
  latencyTimesRequests: number;
}

interface Totals {
  control: ArmTotals;
  treatment: ArmTotals;
  /** Units seen on both arms. */
  both: number;
}

function emptyArm(): ArmTotals {
  return { converted: 0, errors: 0, errorsSquared: 0, errorsTimesRequests: 0, hadError: 0, latency: 0, latencySquared: 0, latencyTimesRequests: 0, requests: 0, requestsSquared: 0, units: 0 };
}

function emptyTotals(): Totals {
  return { both: 0, control: emptyArm(), treatment: emptyArm() };
}

/** Adds a unit's own numbers to its arm (`sign` 1), or takes them back out (`sign` -1). */
function tallyArm(arm: ArmTotals, counted: Contribution, sign: number): void {
  arm.units += sign;
  arm.hadError += counted.errors > 0 ? sign : 0;
  arm.converted += sign * counted.converted;
  arm.errors += sign * counted.errors;
  arm.requests += sign * counted.requests;
  arm.latency += sign * counted.latency;
}

function tallySquares(arm: ArmTotals, counted: Contribution, sign: number): void {
  arm.errorsSquared += sign * counted.errors * counted.errors;
  arm.requestsSquared += sign * counted.requests * counted.requests;
  arm.errorsTimesRequests += sign * counted.errors * counted.requests;
  arm.latencySquared += sign * counted.latency * counted.latency;
  arm.latencyTimesRequests += sign * counted.latency * counted.requests;
}

/** Adds a unit's share to the totals (`sign` 1), or takes it back out (`sign` -1). */
function tally(totals: Totals, counted: Contribution | null, sign: number): void {
  if (counted === null) {
    return;
  }
  if (counted.arm === "both") {
    totals.both += sign;
    return;
  }
  tallyArm(totals[counted.arm], counted, sign);
  tallySquares(totals[counted.arm], counted, sign);
}

function activityFrom(unit: Unit, first: number, arm: Arm): Contribution {
  let errors = 0,
    requests = 0,
    latency = 0,
    converted = 0;
  for (const event of unit.activity) {
    if (event.at >= first) {
      errors += event.errors;
      requests += event.requests;
      latency += event.latency;
      converted = event.converted ? 1 : converted;
    }
  }
  return { arm, converted, errors, latency, requests };
}

/** What a unit counts as, from the exposures and activity known so far and counted from `since`. */
function contributionOf(unit: Unit, since: number): Contribution | null {
  const exposures = unit.exposures.filter((exposure) => exposure.at >= since);
  let first = exposures.at(0);
  for (const exposure of exposures) {
    first = first !== undefined && exposure.at < first.at ? exposure : first;
  }
  if (first === undefined) {
    return null;
  }
  const { arm } = first;
  if (exposures.some((exposure) => exposure.arm !== arm)) {
    return { arm: "both", converted: 0, errors: 0, latency: 0, requests: 0 };
  }
  return activityFrom(unit, first.at, arm);
}

/** Drops second deliveries of the same event; true when there were any. */
function dropRepeats(unit: Unit): boolean {
  const seen = new Set<number>(),
    unique = unit.activity.filter((event) => {
      const fresh = !seen.has(event.key);
      seen.add(event.key);
      return fresh;
    }),
    dropped = unique.length < unit.activity.length;
  unit.activity = unique;
  return dropped;
}

export type { ArmTotals, Contribution, Totals, Unit, UnitExposure };
export { contributionOf, dropRepeats, emptyTotals, tally };
