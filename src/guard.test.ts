import { METRIC, MINUTE, START } from "./__tests__/world";
import type { Phase, RolloutRecord } from "./record";
import { describe, expect, it, vi } from "vitest";
import { expire, guard } from "./guard";
import { healthyAt, watchingStep } from "./__tests__/records";
import { DEFAULT_LIMITS } from "./plan";
import type { Guardrail } from "./plan";
import type { MetricSnapshot } from "./ports";

vi.setConfig({ testTimeout: 5000 });

const NOW = START + MINUTE,
  UNITS = 500,
  FEW = 10,
  MANY = 250,
  LOPSIDED = 5000,
  MERGED = 100,
  REQUESTS = 3,
  FAILED = 20,
  OTHER = "checkout_errors",
  TIME = { now: NOW, wall: NOW },
  BLIND_UNTIL = NOW + DEFAULT_LIMITS.maxBlindMs,
  IDLE_UNTIL = START + DEFAULT_LIMITS.expireAfterIdleMs,
  PAUSING: Guardrail = { direction: "lower_is_better", kind: "rate", metric: METRIC, onRegression: "pause", tolerance: 0 },
  UNDOING: Guardrail = { ...PAUSING, metric: OTHER, onRegression: "rollback" },
  PER_REQUEST: Guardrail = { ...PAUSING, kind: "ratio", onRegression: "rollback" };

function arms(control: number, treatment: number): { control: { sum: number; units: number }; treatment: { sum: number; units: number } } {
  return { control: { sum: control, units: UNITS }, treatment: { sum: treatment, units: UNITS } };
}

/** A fresh snapshot where the new behaviour errors far more often than the old. */
function worse(metrics?: MetricSnapshot["metrics"]): MetricSnapshot {
  return { ...healthyAt(NOW), metrics: metrics ?? { [METRIC]: arms(FEW, MANY) } };
}

/** Errors per request where the new arm has errors and no requests at all, on the first metric and on `others`. */
function noRequests(others: readonly string[] = []): MetricSnapshot {
  const counted = { denominator: { crossSum: FEW * REQUESTS, sum: UNITS * REQUESTS, sumSquares: UNITS * REQUESTS * REQUESTS }, sum: FEW, sumSquares: FEW, units: UNITS },
    lost = { denominator: { crossSum: 0, sum: 0, sumSquares: 0 }, sum: FAILED, sumSquares: FAILED, units: UNITS };
  return worse(Object.fromEntries([METRIC, ...others].map((metric) => [metric, { control: counted, treatment: lost }])));
}

function blindAt(now: number, record: RolloutRecord): RolloutRecord {
  return guard(record, null, { now, wall: now });
}

function inPhase(phase: Phase): RolloutRecord {
  return { ...watchingStep(), phase };
}

describe("a rollout nobody is watching", () => {
  it("is undone once it has made no progress for longer than the plan allows, and not a millisecond before", () => {
    expect.hasAssertions();
    const idle: RolloutRecord = { ...watchingStep(), lastProgressAt: START };
    expect(expire(idle, IDLE_UNTIL)).toBe(idle);
    expect(expire(idle, IDLE_UNTIL + 1)).toMatchObject({ outcome: { reason: "expired" }, phase: "rolling_back" });
  });

  it("is left alone once it is being released or is over", () => {
    expect.hasAssertions();
    const releasing: RolloutRecord = { ...watchingStep(), lastProgressAt: START, phase: "releasing" };
    expect(expire(releasing, IDLE_UNTIL + MINUTE)).toBe(releasing);
  });
});

describe("guardrails with nothing to read", () => {
  it("notes when the rollout went blind, and keeps the first time", () => {
    expect.hasAssertions();
    const first = blindAt(NOW, watchingStep());
    expect(first).toMatchObject({ blindSince: NOW, outbox: [], phase: "ramping" });
    expect(blindAt(NOW + MINUTE, first)).toBe(first);
  });

  it("says so once after too long blind, and holds, when the plan says hold", () => {
    expect.hasAssertions();
    const first = blindAt(NOW, watchingStep());
    expect(blindAt(BLIND_UNTIL, first)).toBe(first);
    const reported = blindAt(BLIND_UNTIL + 1, first);
    expect(reported).toMatchObject({ blindSince: NOW, outageReported: true, outbox: [{ type: "metrics_outage" }], phase: "ramping" });
    expect(blindAt(BLIND_UNTIL + MINUTE, reported)).toBe(reported);
  });

  it("is undone after too long blind when the plan says roll back", () => {
    expect.hasAssertions();
    const first = blindAt(NOW, watchingStep({ onMetricsOutage: "rollback" }));
    expect(blindAt(BLIND_UNTIL + 1, first)).toMatchObject({ outcome: { reason: "metrics_outage" }, phase: "rolling_back" });
  });

  it("counts metrics older than the plan allows as no metrics, to the millisecond", () => {
    expect.hasAssertions();
    const stale = NOW + DEFAULT_LIMITS.maxStalenessMs;
    expect(guard(watchingStep(), healthyAt(NOW), { now: stale, wall: stale }).blindSince).toBeNull();
    expect(guard(watchingStep(), healthyAt(NOW), { now: stale + 1, wall: stale + 1 }).blindSince).toBe(stale + 1);
  });

  it("says the metrics are back only when it said they were gone", () => {
    expect.hasAssertions();
    const blind: RolloutRecord = { ...watchingStep(), blindSince: START },
      reported: RolloutRecord = { ...blind, outageReported: true };
    expect(guard(blind, healthyAt(NOW), TIME)).toMatchObject({ blindSince: null, outbox: [] });
    expect(guard(reported, healthyAt(NOW), TIME)).toMatchObject({ blindSince: null, outageReported: false, outbox: [{ type: "metrics_restored" }] });
  });
});

describe("guardrails that don't apply", () => {
  it("leaves alone a rollout that is over, being undone or released, or has no guardrails", () => {
    expect.hasAssertions();
    const over = (["rolling_back", "rolled_back", "releasing", "released"] as const).map((phase) => inPhase(phase)),
      unguarded = watchingStep({ guardrails: [] });
    expect(over.map((record) => guard(record, worse(), TIME))).toStrictEqual(over);
    expect(guard(unguarded, null, TIME)).toBe(unguarded);
  });

  it("does not judge numbers from before anyone was sent the new behaviour, and still notes going blind", () => {
    expect.hasAssertions();
    const waiting: RolloutRecord = { ...watchingStep(), exposedSince: null };
    expect(guard(waiting, worse(), TIME)).toBe(waiting);
    expect(guard(waiting, null, TIME).blindSince).toBe(NOW);
  });

  it("leaves a healthy rollout exactly as it was", () => {
    expect.hasAssertions();
    const record = watchingStep();
    expect(guard(record, healthyAt(NOW), TIME)).toBe(record);
  });
});

describe("guardrails that fail", () => {
  it("undoes a rollout whose guardrail got worse, with the reading that says so", () => {
    expect.hasAssertions();
    expect(guard(watchingStep(), worse(), TIME)).toMatchObject({ outcome: { finding: { metric: METRIC }, reason: "regression" }, phase: "rolling_back" });
  });

  it("pauses when the guardrail says pause, in every phase the new behaviour is still served", () => {
    expect.hasAssertions();
    const plan = { guardrails: [PAUSING] },
      held = guard({ ...watchingStep(plan), phase: "awaiting_approval" }, worse(), TIME);
    expect(guard(watchingStep(plan), worse(), TIME)).toMatchObject({ outcome: null, pause: { reason: "regression", since: NOW }, phase: "paused" });
    expect(held.pause?.reason).toBe("regression");
  });

  it("undoes rather than pauses when two guardrails got worse and either says undo", () => {
    expect.hasAssertions();
    const both = worse({ [METRIC]: arms(FEW, MANY), [OTHER]: arms(FEW, MANY) }),
      onlyFirst = worse({ [METRIC]: arms(FEW, MANY), [OTHER]: arms(FEW, FEW) });
    expect(guard(watchingStep({ guardrails: [PAUSING, UNDOING] }), both, TIME)).toMatchObject({ outcome: { finding: { metric: OTHER } }, phase: "rolling_back" });
    expect(guard(watchingStep({ guardrails: [PAUSING, UNDOING] }), onlyFirst, TIME)).toMatchObject({ pause: { reason: "regression" }, phase: "paused" });
  });

  it("does what the plan says when the arms are not the same size, before reading the guardrails", () => {
    expect.hasAssertions();
    const lopsided: MetricSnapshot = { ...worse(), exposed: { control: LOPSIDED, treatment: UNITS } };
    expect(guard(watchingStep(), lopsided, TIME).outcome?.reason).toBe("sample_ratio_mismatch");
    expect(guard(watchingStep({ onSampleRatioMismatch: "pause" }), lopsided, TIME).pause?.reason).toBe("sample_ratio_mismatch");
  });

  it("pauses when too many people saw both behaviours, whatever the guardrails or the arms' sizes read", () => {
    expect.hasAssertions();
    const merged: MetricSnapshot = { ...worse(), contaminated: MERGED };
    expect(guard(watchingStep(), merged, TIME)).toMatchObject({ outcome: null, pause: { reason: "contaminated" }, phase: "paused" });
    expect(guard(watchingStep(), { ...merged, exposed: { control: LOPSIDED, treatment: UNITS } }, TIME)).toMatchObject({ outcome: null, pause: { reason: "contaminated" } });
  });

  it("treats a ratio with events and nothing to divide them by as the guardrail failing", () => {
    expect.hasAssertions();
    const paused = guard(watchingStep({ guardrails: [{ ...PER_REQUEST, onRegression: "pause" }] }), noRequests(), TIME),
      undone = guard(watchingStep({ guardrails: [PER_REQUEST] }), noRequests(), TIME);
    expect(undone).toMatchObject({ outcome: { reason: "regression" }, phase: "rolling_back" });
    expect(paused).toMatchObject({ outcome: null, pause: { reason: "regression" }, phase: "paused" });
  });

});

describe("ratios the new behaviour has broken", () => {
  it("undoes rather than pauses when two ratios are broken and either says undo", () => {
    expect.hasAssertions();
    const pausing: Guardrail = { ...PER_REQUEST, onRegression: "pause" },
      undoing: Guardrail = { ...PER_REQUEST, metric: OTHER };
    expect(guard(watchingStep({ guardrails: [pausing, undoing] }), noRequests([OTHER]), TIME)).toMatchObject({ outcome: { reason: "regression" }, phase: "rolling_back" });
    expect(guard(watchingStep({ guardrails: [pausing, { ...undoing, onRegression: "pause" }] }), noRequests([OTHER]), TIME).phase).toBe("paused");
  });
});
