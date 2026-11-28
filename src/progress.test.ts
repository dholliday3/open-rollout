import { DEFAULT_LIMITS, stepAt } from "./plan.js";
import { FIRST_SHARE, MINUTE, START, testPlan } from "./__tests__/world.js";
import { describe, expect, it, vi } from "vitest";
import { flagAt, healthyAt, watchingStep } from "./__tests__/records.js";
import { progress, throughOpenGate } from "./progress.js";
import type { Observation } from "./observation.js";
import type { RolloutRecord } from "./record.js";

vi.setConfig({ testTimeout: 5000 });

const STEP = stepAt(testPlan(), 0),
  WATCH_MS = (STEP?.minDurationMs ?? 0) + DEFAULT_LIMITS.propagationMs,
  PATIENCE_MS = (STEP?.maxDurationMs ?? 0) + DEFAULT_LIMITS.propagationMs,
  ENOUGH = STEP?.minFreshUnits ?? 0,
  WATCHED = START + WATCH_MS,
  MORE = 3000,
  /** Units each arm had in a snapshot taken as a step began, and once its late exposures had arrived. */
  BEFORE = 100,
  LATE = 130;

function seeing(units: { control: number; treatment: number }, watermark = WATCHED, share = FIRST_SHARE): Observation {
  return { flag: flagAt(share), metrics: healthyAt(watermark, units), staleWritesRefused: true };
}

function stepAfter(record: RolloutRecord, observation: Observation, now = WATCHED): number {
  return progress(record, observation, { now, wall: now }).stepIndex;
}

function phaseAfter(record: RolloutRecord, observation: Observation): string {
  return throughOpenGate(record, observation, { now: WATCHED, wall: WATCHED }).phase;
}

/** A rollout that has passed its last step and waits for a yes to release. */
function atReleaseGate(approved: boolean): RolloutRecord {
  return { ...watchingStep({ requiresApprovalToRelease: true }), approvedGates: approved ? ["release"] : [], pendingGate: "release", phase: "awaiting_approval", stepIndex: 1 };
}

describe("moving on from a step", () => {
  it("needs the new units on both arms, and exactly as many as the step asks is enough", () => {
    expect.hasAssertions();
    expect(stepAfter(watchingStep(), seeing({ control: ENOUGH, treatment: ENOUGH }))).toBe(1);
    expect(stepAfter(watchingStep(), seeing({ control: ENOUGH + ENOUGH, treatment: ENOUGH - 1 }))).toBe(0);
    expect(stepAfter(watchingStep(), seeing({ control: ENOUGH - 1, treatment: ENOUGH + ENOUGH }))).toBe(0);
  });

  it("counts new units from where the watch began, not from nothing", () => {
    expect.hasAssertions();
    const begun: RolloutRecord = { ...watchingStep(), freshBaseline: { asOf: START, control: ENOUGH, treatment: ENOUGH } };
    expect(stepAfter(begun, seeing({ control: ENOUGH + ENOUGH - 1, treatment: ENOUGH + ENOUGH }))).toBe(0);
    expect(stepAfter(begun, seeing({ control: ENOUGH + ENOUGH, treatment: ENOUGH + ENOUGH - 1 }))).toBe(0);
    expect(stepAfter(begun, seeing({ control: ENOUGH + ENOUGH, treatment: ENOUGH + ENOUGH }))).toBe(1);
  });

  it("needs the metrics complete up to the whole watch after it began, to the millisecond", () => {
    expect.hasAssertions();
    const units = { control: ENOUGH, treatment: ENOUGH };
    expect(stepAfter(watchingStep(), seeing(units, WATCHED - 1))).toBe(0);
    expect(stepAfter(watchingStep(), seeing(units, WATCHED))).toBe(1);
  });

  it("needs the step in force that long on the workers' clock too, so a source whose clock is put right can't cut the watch short", () => {
    expect.hasAssertions();
    const units = { control: ENOUGH, treatment: ENOUGH },
      seenLater: RolloutRecord = { ...watchingStep(), confirmedAt: START + MINUTE };
    expect(stepAfter(watchingStep(), seeing(units), WATCHED - 1)).toBe(0);
    expect(stepAfter(seenLater, seeing(units))).toBe(0);
    expect(stepAfter(seenLater, seeing(units, WATCHED + MINUTE), WATCHED + MINUTE)).toBe(1);
  });

  it("does not move while the flag serves something else, or the step has not been seen in force", () => {
    expect.hasAssertions();
    const units = { control: ENOUGH, treatment: ENOUGH };
    expect(stepAfter(watchingStep(), seeing(units, WATCHED, MORE))).toBe(0);
    expect(stepAfter({ ...watchingStep(), confirmedEpoch: 0 }, seeing(units))).toBe(0);
    expect(stepAfter(watchingStep(), { ...seeing(units), flag: null })).toBe(0);
    expect(stepAfter({ ...watchingStep(), phase: "paused" }, seeing(units))).toBe(0);
  });

  it("needs every guardrail's reading to be sharp enough, not just one", () => {
    expect.hasAssertions();
    const [errors] = testPlan().guardrails,
      strict = watchingStep({ guardrails: [{ ...errors, mustRuleOut: 0.0001 }] }),
      oneOfTwo = watchingStep({ guardrails: [{ ...errors, mustRuleOut: 0.0001 }, errors] });
    expect(stepAfter(strict, seeing({ control: ENOUGH, treatment: ENOUGH }))).toBe(0);
    expect(stepAfter(oneOfTwo, seeing({ control: ENOUGH, treatment: ENOUGH }))).toBe(0);
  });
});

describe("where a step's watch begins", () => {
  it("is not a snapshot showing fewer units on either arm than the last step ended with", () => {
    expect.hasAssertions();
    const fresh: RolloutRecord = { ...watchingStep(), freshBaseline: null, unitsFloor: { control: ENOUGH, treatment: ENOUGH } },
      baselineOf = (control: number, treatment: number): unknown => progress(fresh, seeing({ control, treatment }, START), { now: START, wall: START }).freshBaseline;
    expect(baselineOf(ENOUGH, ENOUGH - 1)).toBeNull();
    expect(baselineOf(ENOUGH - 1, ENOUGH)).toBeNull();
    expect(baselineOf(ENOUGH, ENOUGH)).toStrictEqual({ asOf: START, complete: true, control: ENOUGH, treatment: ENOUGH });
  });

  it("counts the units a step starts from only once the metrics have caught up with the step, so the last step's late ones are not new", () => {
    expect.hasAssertions();
    const fresh: RolloutRecord = { ...watchingStep(), freshBaseline: null },
      // Taken once the step is in force, but complete only up to a minute before: exposures from the step before are still on their way.
      behind = { ...healthyAt(START - MINUTE, { control: BEFORE, treatment: BEFORE }), asOf: START },
      started = progress(fresh, { ...seeing({ control: BEFORE, treatment: BEFORE }), metrics: behind }, { now: START, wall: START }),
      stillBehind = progress(started, { ...seeing({ control: LATE, treatment: LATE }), metrics: { ...behind, exposed: { control: LATE, treatment: LATE }, watermark: START - 1 } }, { now: START, wall: START }),
      caughtUp = progress(stillBehind, seeing({ control: LATE, treatment: LATE }, START), { now: START, wall: START });
    expect(started.freshBaseline).toStrictEqual({ asOf: START, complete: false, control: BEFORE, treatment: BEFORE });
    expect(stillBehind.freshBaseline).toStrictEqual(started.freshBaseline);
    expect(caughtUp.freshBaseline).toStrictEqual({ asOf: START, complete: true, control: LATE, treatment: LATE });
  });

  it("passes no step while the units it starts from are not counted yet, however much time and traffic have gone by", () => {
    expect.hasAssertions();
    const waiting: RolloutRecord = { ...watchingStep(), freshBaseline: { asOf: START, complete: false, control: 0, treatment: 0 } };
    expect(stepAfter(waiting, { ...seeing({ control: MORE, treatment: MORE }), metrics: { ...healthyAt(WATCHED, { control: MORE, treatment: MORE }), asOf: WATCHED, watermark: START - 1 } })).toBe(0);
    expect(stepAfter(waiting, seeing({ control: MORE, treatment: MORE }))).toBe(0);
  });

  it("is noted with what the last step ended with when the step passes", () => {
    expect.hasAssertions();
    const units = { control: ENOUGH, treatment: ENOUGH + 1 };
    expect(progress(watchingStep(), seeing(units), { now: WATCHED, wall: WATCHED }).unitsFloor).toStrictEqual(units);
  });
});

describe("a step that never gets its traffic", () => {
  const short = { control: 0, treatment: 0 };

  it("is given until its patience runs out, to the millisecond, then ends as the plan says", () => {
    expect.hasAssertions();
    const late = START + PATIENCE_MS;
    expect(progress(watchingStep(), seeing(short, late), { now: late, wall: late }).phase).toBe("ramping");
    expect(progress(watchingStep(), seeing(short, late + 1), { now: late + 1, wall: late + 1 }).outcome?.reason).toBe("insufficient_data");
    expect(progress(watchingStep({ onInsufficientData: "pause" }), seeing(short, late + 1), { now: late + 1, wall: late + 1 }).pause?.reason).toBe("insufficient_data");
  });

  it("is not given up on while the metrics can't be read: that is a different problem", () => {
    expect.hasAssertions();
    const late = START + PATIENCE_MS + MINUTE;
    expect(progress(watchingStep(), { flag: flagAt(FIRST_SHARE), metrics: null, staleWritesRefused: true }, { now: late, wall: late }).phase).toBe("ramping");
  });
});

describe("a step with nothing guarding it", () => {
  it("waits out its time on the worker's clock, to the millisecond", () => {
    expect.hasAssertions();
    const unguarded = watchingStep({ guardrails: [] }),
      nothing: Observation = { flag: flagAt(FIRST_SHARE), metrics: null, staleWritesRefused: true };
    expect(stepAfter(unguarded, nothing, WATCHED - 1)).toBe(0);
    expect(stepAfter(unguarded, nothing, WATCHED)).toBe(1);
  });
});

describe("going through a gate", () => {
  const enough = { control: ENOUGH, treatment: ENOUGH },
    lastStep = (share: number): Observation => ({ flag: flagAt(share), metrics: healthyAt(WATCHED, enough), staleWritesRefused: true });

  it("needs the yes, the step in force, and metrics that can be read, all at once", () => {
    expect.hasAssertions();
    expect(phaseAfter(atReleaseGate(true), lastStep(FIRST_SHARE))).toBe("releasing");
    expect(phaseAfter(atReleaseGate(false), lastStep(FIRST_SHARE))).toBe("awaiting_approval");
    expect(phaseAfter(atReleaseGate(true), lastStep(MORE))).toBe("awaiting_approval");
    expect(phaseAfter(atReleaseGate(true), { ...lastStep(FIRST_SHARE), metrics: null })).toBe("awaiting_approval");
    expect(phaseAfter(atReleaseGate(true), { ...lastStep(FIRST_SHARE), metrics: healthyAt(WATCHED, { control: 0, treatment: 0 }) })).toBe("awaiting_approval");
  });

  it("needs no metrics before anyone is exposed, or when nothing guards the rollout", () => {
    expect.hasAssertions();
    const blind: Observation = { flag: null, metrics: null, staleWritesRefused: true },
      first: RolloutRecord = { ...watchingStep(), approvedGates: [], desired: { control: 0, treatment: 0 }, pendingGate: 0, phase: "awaiting_approval", stepIndex: -1 };
    expect(phaseAfter(first, blind)).toBe("ramping");
    expect(phaseAfter({ ...atReleaseGate(true), plan: testPlan({ guardrails: [] }) }, blind)).toBe("releasing");
  });

  it("does nothing for a rollout that is not waiting at one", () => {
    expect.hasAssertions();
    const record = watchingStep();
    expect(throughOpenGate(record, lastStep(FIRST_SHARE), { now: WATCHED, wall: WATCHED })).toBe(record);
  });
});
