import { measuredStep, sameAllocation } from "../allocation";
import type { Arm } from "./events";
import { ROLLOUT } from "./driver";
import type { Saved } from "./store";
import type { World } from "./world";

/**
 * The oracle for a rollout in the stochastic world. It reads the truth (what the provider really served
 * and when, and who was really served which arm for the first time) against each version of the record as
 * it was saved. It never asks the metric source or the record what happened.
 */

/** What a step really had behind it at the moment the rollout moved on from it. */
interface StepEvidence {
  readonly step: number;
  /** How long the flag had really served the step, added up. */
  readonly servedMs: number;
  /** People really served each arm for the first time while it did. */
  readonly fresh: Record<Arm, number>;
  /** The share of people really on the new behaviour was this, in basis points, when the rollout moved on. */
  readonly movedOnAt: number;
}

interface Stretch {
  readonly from: number;
  readonly to: number;
}

const MS_PER_SECOND = 1000;

function stretchesServing(world: World, share: number, upTo: number): Stretch[] {
  const changes = world.provider.changes(world.options.plan.flagKey).filter((change) => change.at <= upTo);
  return changes.flatMap((change, index) => (sameAllocation(change.allocation, measuredStep(share)) ? [{ from: change.at, to: changes.at(index + 1)?.at ?? upTo }] : []));
}

function lengthOf(stretches: readonly Stretch[]): number {
  let total = 0;
  for (const stretch of stretches) {
    total += stretch.to - stretch.from;
  }
  return total;
}

function firstServedIn(world: World, arm: Arm, stretches: readonly Stretch[]): number {
  return world.truth.firstServed[arm].filter((at) => stretches.some((stretch) => at >= stretch.from && at <= stretch.to)).length;
}

function evidenceAt(world: World, before: Saved, after: Saved): StepEvidence {
  const share = world.options.plan.steps[before.record.stepIndex].treatmentShare,
    stretches = stretchesServing(world, share, after.at);
  return {
    fresh: { control: firstServedIn(world, "control", stretches), treatment: firstServedIn(world, "treatment", stretches) },
    movedOnAt: after.at,
    servedMs: lengthOf(stretches),
    step: before.record.stepIndex,
  };
}

/** The true evidence behind every move the rollout made by itself: each step-up, and a release nobody forced. */
function evidenceBehindMoves(world: World): StepEvidence[] {
  const versions = world.store.versions(ROLLOUT),
    moves: StepEvidence[] = [];
  for (const [index, after] of versions.entries()) {
    const before = versions.at(Math.max(0, index - 1)) ?? after,
      steppedUp = before.record.stepIndex >= 0 && after.record.stepIndex === before.record.stepIndex + 1,
      released = after.record.phase === "releasing" && before.record.phase !== "releasing" && after.record.outcome?.reason === "completed";
    if (steppedUp || released) {
      moves.push(evidenceAt(world, before, after));
    }
  }
  return moves;
}

/** What one move had too little of, as sentences; empty when it had enough. */
function shortfallsOf(world: World, evidence: StepEvidence): string[] {
  const { plan } = world.options,
    step = plan.steps[evidence.step],
    problems: string[] = [];
  if (evidence.servedMs < step.minDurationMs + plan.limits.propagationMs) {
    problems.push(`step ${evidence.step} had really been served for ${Math.round(evidence.servedMs / MS_PER_SECOND)}s`);
  }
  if (Math.min(evidence.fresh.control, evidence.fresh.treatment) < step.minFreshUnits) {
    problems.push(`step ${evidence.step} had really gained ${evidence.fresh.control} and ${evidence.fresh.treatment} new people`);
  }
  return problems;
}

/** Claim 2 against the truth: every move forward that really had too little time or too few new people behind it. */
function evidenceShortfalls(world: World): string[] {
  return evidenceBehindMoves(world).flatMap((evidence) => shortfallsOf(world, evidence));
}

/** Claim 1 against the truth: every change the library made to the flag that no saved record had asked for by then. */
function writesNobodyAskedFor(world: World): string[] {
  const versions = world.store.versions(ROLLOUT);
  return world.provider
    .changes(world.options.plan.flagKey)
    .filter((change) => Number.isFinite(change.at) && !change.by.startsWith("person") && !versions.some((saved) => saved.at <= change.at && sameAllocation(saved.record.desired, change.allocation)))
    .map((change) => `${change.by} wrote ${change.allocation.treatment}/${change.allocation.control}, which no saved record had asked for`);
}

export type { StepEvidence };
export { evidenceBehindMoves, evidenceShortfalls, writesNobodyAskedFor };
