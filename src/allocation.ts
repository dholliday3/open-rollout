/**
 * Traffic shares in basis points (1% = 100), so sums and comparisons are exact.
 * `treatment` sees the new behaviour, `control` sees the old one and is measured against it,
 * and whatever is left sees the old behaviour unmeasured.
 */
interface Allocation {
  readonly control: number;
  readonly treatment: number;
}

const FULL_SHARE = 10_000,
  /** The largest measured step: half on each arm, nobody left over. */
  HALF_SHARE = 5000,
  /** Nobody sees the new behaviour. */
  NOBODY: Allocation = { control: 0, treatment: 0 },
  /** Everybody sees the new behaviour; nothing is left to compare against. */
  EVERYBODY: Allocation = { control: 0, treatment: FULL_SHARE };

/** A measured step: equal shares on both arms, so every hour of the day weighs the same on each. */
function measuredStep(treatmentShare: number): Allocation {
  return { control: treatmentShare, treatment: treatmentShare };
}

function sameAllocation(left: Allocation, right: Allocation): boolean {
  return left.control === right.control && left.treatment === right.treatment;
}

/** True when `actual` puts the new behaviour in front of more traffic than `desired` allows. */
function exposesMore(actual: Allocation, desired: Allocation): boolean {
  return actual.treatment > desired.treatment;
}

function isValidAllocation(allocation: Allocation): boolean {
  const { control, treatment } = allocation;
  return Number.isInteger(control) && Number.isInteger(treatment) && control >= 0 && treatment >= 0 && control + treatment <= FULL_SHARE;
}

export type { Allocation };
export { EVERYBODY, FULL_SHARE, HALF_SHARE, NOBODY, exposesMore, isValidAllocation, measuredStep, sameAllocation };
