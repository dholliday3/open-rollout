/**
 * The statistics behind a guardrail: is the new behaviour worse than the old one, given what both arms
 * have seen so far? The answer has to stay honest however often it is asked, because a rollout asks every
 * tick. A fixed-sample test asked a thousand times cries wolf; a confidence sequence (Howard et al. 2021,
 * Waudby-Smith et al. 2024) holds its error rate over every look at once.
 */

/** How a metric is read off each unit: a share of units, an average per unit, or a ratio of two totals. */
type MetricKind = "rate" | "mean" | "ratio";

/** Running totals of a ratio's denominator over an arm's units. */
interface DenominatorSample {
  readonly sum: number;
  readonly sumSquares: number;
  /** Sum over units of numerator × denominator. */
  readonly crossSum: number;
}

/** What one arm saw of a metric, as running totals over its units. */
interface ArmSample {
  /** Units (people, accounts) counted on this arm. */
  readonly units: number;
  /** Units that had the event for a rate, the total for a mean, the numerator's total for a ratio. */
  readonly sum: number;
  /** Sum of each unit's value squared. A rate doesn't use it. */
  readonly sumSquares?: number | undefined;
  /** Ratio only (errors per request, measured per person): the requests. */
  readonly denominator?: DenominatorSample | undefined;
}

/** A metric's value on one arm, with the variance of that value. */
interface Estimate {
  readonly units: number;
  readonly value: number;
  readonly variance: number;
}

/** The new arm minus the old one, with bounds that hold at every look. */
interface Interval {
  readonly estimate: number;
  readonly lower: number;
  readonly upper: number;
}

interface SequenceTuning {
  /** Chance of a false alarm in one direction over the whole rollout. */
  readonly alpha: number;
  /** Units per arm at which the bounds should be tightest. */
  readonly tuneAtUnits: number;
}

const MIN_UNITS_FOR_VARIANCE = 2,
  /** Add-one smoothing for a rate's variance: an arm with no events yet is not an arm that can't have any. */
  SMOOTHING_SUCCESSES = 1,
  SMOOTHING_TRIALS = 2,
  /** A fair coin's variance, the most a share of units can have. */
  MAX_SHARE_VARIANCE = 0.25,
  /** Rounding can leave a true sum of squares a hair under its floor. */
  SQUARES_SLACK = 0.999999,
  FAIR_SHARE = 0.5;

function sampleVariance(units: number, sum: number, sumSquares: number): number {
  const mean = sum / units;
  return Math.max(0, (sumSquares - units * mean * mean) / (units - 1));
}

/** True when a sum of squares could go with this sum over this many units: it can't be less than the sum squared over the units. */
function squaresFit(units: number, sum: number, sumSquares: number | undefined): sumSquares is number {
  // With no units there is nothing to divide by, and nothing a sum of squares could contradict.
  const least = units > 0 ? ((sum * sum) / units) * SQUARES_SLACK : 0;
  return sumSquares !== undefined && Number.isFinite(sumSquares) && sumSquares >= least;
}

function isCount(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function denominatorProblem(sample: ArmSample): string | null {
  const { denominator, units } = sample;
  if (denominator === undefined) {
    return "a ratio needs what is under the line";
  }
  const fits = isCount(denominator.sum) && squaresFit(units, denominator.sum, denominator.sumSquares) && Number.isFinite(denominator.crossSum);
  return fits ? null : "the totals under the line don't go together";
}

/**
 * Why these totals can't be a measurement, or null when they can. A sample with too few units is thin, not
 * wrong; one whose numbers contradict each other, or that leaves out what its kind needs, is wrong.
 */
function sampleProblem(kind: MetricKind, sample: ArmSample): string | null {
  if (!isCount(sample.units) || !Number.isFinite(sample.sum)) {
    return "its units or its total is not a count";
  }
  if (kind === "rate") {
    return sample.sum >= 0 && sample.sum <= sample.units ? null : "more units had the event than there are units, or fewer than none";
  }
  if (!squaresFit(sample.units, sample.sum, sample.sumSquares)) {
    return "its sum of squares is missing or too small for its total";
  }
  return kind === "ratio" ? denominatorProblem(sample) : null;
}

function rateEstimate(sample: ArmSample): Estimate {
  const smoothed = (sample.sum + SMOOTHING_SUCCESSES) / (sample.units + SMOOTHING_TRIALS);
  return { units: sample.units, value: sample.sum / sample.units, variance: (smoothed * (1 - smoothed)) / sample.units };
}

function meanEstimate(sample: ArmSample): Estimate {
  const spread = sampleVariance(sample.units, sample.sum, sample.sumSquares ?? 0);
  return { units: sample.units, value: sample.sum / sample.units, variance: spread / sample.units };
}

/**
 * A ratio of two totals whose rows are not independent (one person makes many requests), by the delta
 * method: the variance comes from how people differ, not from how many requests there are.
 *
 * `around` is the ratio the residuals are taken from. Taken from the arm's own ratio, an arm where one or
 * two people make most of the requests fits its ratio to them and reports almost no spread, and healthy
 * code is called worse twice as often as it should be. Taken from the ratio both arms share when nothing
 * has changed, it can't, and an arm with no events yet still has a spread.
 */
function ratioEstimate(sample: ArmSample, denominator: DenominatorSample, around: number): Estimate | null {
  if (denominator.sum <= 0) {
    return null;
  }
  const { units, sum } = sample,
    residualSquares = Math.max(0, (sample.sumSquares ?? 0) - 2 * around * denominator.crossSum + around * around * denominator.sumSquares);
  return { units, value: sum / denominator.sum, variance: residualSquares / (denominator.sum * denominator.sum) };
}

function estimateOf(kind: MetricKind, sample: ArmSample, around: number): Estimate | null {
  if (kind === "rate") {
    return rateEstimate(sample);
  }
  if (kind === "mean") {
    return meanEstimate(sample);
  }
  return sample.denominator === undefined ? null : ratioEstimate(sample, sample.denominator, around);
}

/**
 * A metric's value on one arm, or null while the arm has too little to estimate a variance from, or when
 * its totals can't be a measurement. No estimate is never read as healthy and never as worse. For a ratio,
 * `around` is the ratio to take the spread from; left out, it is the arm's own.
 */
function estimateArm(kind: MetricKind, sample: ArmSample, around?: number): Estimate | null {
  if (sample.units < MIN_UNITS_FOR_VARIANCE || sampleProblem(kind, sample) !== null) {
    return null;
  }
  const estimate = estimateOf(kind, sample, around ?? sample.sum / (sample.denominator?.sum ?? 1));
  return estimate !== null && Number.isFinite(estimate.value) && Number.isFinite(estimate.variance) ? estimate : null;
}

/** The ratio both arms share when nothing has changed: every unit's total over every unit's total. */
function sharedRatio(control: ArmSample, treatment: ArmSample): number {
  return (control.sum + treatment.sum) / ((control.denominator?.sum ?? 0) + (treatment.denominator?.sum ?? 0));
}

/** Both arms' values for a metric, ready to compare, or null while either can't be estimated. */
function estimateArms(kind: MetricKind, arms: { control: ArmSample; treatment: ArmSample }): { control: Estimate; treatment: Estimate } | null {
  const around = kind === "ratio" ? sharedRatio(arms.control, arms.treatment) : undefined,
    control = estimateArm(kind, arms.control, around),
    treatment = estimateArm(kind, arms.treatment, around);
  return control === null || treatment === null ? null : { control, treatment };
}

/**
 * How far an estimate can sit from the truth at any look, with chance `alpha` of ever being further out on
 * either side. A normal mixture bound: wide early, when a few units could say anything, and tightest near
 * `tuneAtUnits`.
 */
function sequenceRadius(spread: { variance: number; effectiveUnits: number }, tuning: SequenceTuning): number {
  const logTerm = 2 * Math.log(1 / tuning.alpha),
    mixture = (logTerm + Math.log(logTerm + 1)) / tuning.tuneAtUnits,
    scaled = spread.effectiveUnits * mixture;
  return Math.sqrt(((2 * spread.variance * (1 + scaled)) / scaled) * Math.log(Math.sqrt(1 + scaled) / tuning.alpha));
}

/**
 * The new arm's value minus the old arm's. `lower` and `upper` each hold with chance `alpha` of ever being
 * wrong, so "lower is above zero" is a one-sided call at `alpha`.
 */
function differenceInterval(control: Estimate, treatment: Estimate, tuning: SequenceTuning): Interval {
  const estimate = treatment.value - control.value,
    // Two units, one on each arm, carry what one unit of a paired comparison would.
    effectiveUnits = (control.units * treatment.units) / (control.units + treatment.units),
    radius = sequenceRadius(
      { effectiveUnits, variance: control.variance + treatment.variance },
      { alpha: 2 * tuning.alpha, tuneAtUnits: tuning.tuneAtUnits / 2 },
    );
  return { estimate, lower: estimate - radius, upper: estimate + radius };
}

/**
 * True when the arms' sizes can't both have come from an even split. Units go missing unevenly when one
 * arm crashes before it reports, or when assignment is broken; either way the comparison can't be trusted.
 */
function isSampleRatioMismatch(units: { control: number; treatment: number }, tuning: SequenceTuning): boolean {
  const total = units.control + units.treatment;
  if (total === 0) {
    return false;
  }
  const radius = sequenceRadius({ effectiveUnits: total, variance: MAX_SHARE_VARIANCE / total }, tuning);
  return Math.abs(units.treatment / total - FAIR_SHARE) > radius;
}

export type { ArmSample, DenominatorSample, Estimate, Interval, MetricKind, SequenceTuning };
export { differenceInterval, estimateArm, estimateArms, isSampleRatioMismatch, sampleProblem, sequenceRadius };
