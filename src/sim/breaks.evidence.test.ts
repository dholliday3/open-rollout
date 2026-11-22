import { EVERYBODY, measuredStep } from "../allocation";
import { FIRST_SHARE, FLAG_KEY, METRIC, MINUTE, ROLLOUT_ID, SECOND_SHARE, createBench, idleFor, recordOf, runFor, send, startedBench, treatmentShare } from "./bench";
import { describe, expect, it, vi } from "vitest";
import type { Bench } from "./bench";
import type { MetricSnapshot } from "../ports";

vi.setConfig({ testTimeout: 10_000 });

/**
 * README claim 2, "Never forward without evidence": no step-up and no release happens on missing, stale or
 * failing metrics, on a failed flag read, or on time passing with no new units. Each test here is one way
 * the rollout moved forward anyway.
 */

const WHOLE_ROLLOUT = 45,
  STEP_AND_A_BIT = 13,
  STEP_MINUTES = 10,
  A_WHILE = 5,
  BROKEN = 0.5,
  AN_HOUR = 60,
  A_DAY_MS = 86_400_000,
  NO_SAMPLE = { sum: 0, units: 0 },
  APPROVE_RELEASE = { by: "dana", gate: "release", id: "approve-release", type: "approve" } as const;

function withoutTheMetric(snapshot: MetricSnapshot): MetricSnapshot {
  return { ...snapshot, metrics: {} };
}

function withNoUnitsJoined(snapshot: MetricSnapshot): MetricSnapshot {
  return { ...snapshot, metrics: { [METRIC]: { control: NO_SAMPLE, treatment: NO_SAMPLE } } };
}

function emptied(snapshot: MetricSnapshot): MetricSnapshot {
  return { ...snapshot, exposed: { control: 0, treatment: 0 }, metrics: { [METRIC]: { control: NO_SAMPLE, treatment: NO_SAMPLE } } };
}

/** Nobody visits from here on. The source restarts and answers one sane, empty snapshot on the tick that sees the step in force. */
async function oneEmptyAnswer(bench: Bench): Promise<void> {
  bench.perMinute = 0;
  bench.distort = emptied;
  await runFor(bench, 1);
  bench.distort = (snapshot) => snapshot;
}

function withNotANumber(snapshot: MetricSnapshot): MetricSnapshot {
  const broken = { sum: Number.NaN, units: Number.NaN };
  return { ...snapshot, metrics: { [METRIC]: { control: broken, treatment: broken } } };
}

/** A rollout at its last step, waiting for a person to approve the release. */
async function waitingForRelease(): Promise<Bench> {
  const bench = createBench({ plan: { requiresApprovalToRelease: true } });
  await bench.autopilot.start({ id: ROLLOUT_ID, now: bench.now, plan: bench.plan });
  await runFor(bench, WHOLE_ROLLOUT);
  return bench;
}

describe("claim 2: a guardrail that was never read", () => {
  it("does not move past the first step when the snapshot leaves the guardrail's metric out", async () => {
    expect.hasAssertions();
    const bench = await startedBench();
    bench.distort = withoutTheMetric;
    bench.errorRate = { control: 0, treatment: BROKEN };
    await runFor(bench, WHOLE_ROLLOUT);
    expect(treatmentShare(bench)).toBeLessThanOrEqual(FIRST_SHARE);
  });

  it("does not move past the first step while the metric has no units to read on either arm", async () => {
    expect.hasAssertions();
    const bench = await startedBench();
    bench.distort = withNoUnitsJoined;
    await runFor(bench, WHOLE_ROLLOUT);
    expect(treatmentShare(bench)).toBeLessThanOrEqual(FIRST_SHARE);
  });

  it("does not move past the first step when the metric's totals are not numbers", async () => {
    expect.hasAssertions();
    const bench = await startedBench();
    bench.distort = withNotANumber;
    await runFor(bench, WHOLE_ROLLOUT);
    expect(treatmentShare(bench)).toBeLessThanOrEqual(FIRST_SHARE);
  });
});

describe("claim 2: an approval is not evidence", () => {
  it("waits at the release gate, as the plan says", async () => {
    expect.hasAssertions();
    const bench = await waitingForRelease();
    expect(recordOf(bench)).toMatchObject({ pendingGate: "release", phase: "awaiting_approval" });
    expect(treatmentShare(bench)).toBe(SECOND_SHARE);
  });

  it("does not release on an approval that arrives while the metrics are down", async () => {
    expect.hasAssertions();
    const bench = await waitingForRelease();
    bench.metricsDown = true;
    await runFor(bench, AN_HOUR);
    await send(bench, APPROVE_RELEASE);
    await runFor(bench, 2);
    expect(bench.provider.serving(FLAG_KEY).allocation).not.toStrictEqual(EVERYBODY);
  });

  it("does not release on an approval when the metrics already show the new arm failing", async () => {
    expect.hasAssertions();
    const bench = await waitingForRelease();
    bench.errorRate = { control: 0, treatment: 1 };
    // The scheduler is down for an hour: nobody ticks, the world goes on, and the metrics are there to read.
    idleFor(bench, AN_HOUR);
    await send(bench, APPROVE_RELEASE);
    await runFor(bench, 2);
    expect(bench.provider.serving(FLAG_KEY).allocation).not.toStrictEqual(EVERYBODY);
  });
});

describe("claim 2: time and units the step never had", () => {
  it("watches a step for its whole time even when the source's watermark is ahead of the clock", async () => {
    expect.hasAssertions();
    const bench = await startedBench();
    bench.lagMs = -A_DAY_MS;
    await runFor(bench, A_WHILE);
    expect(bench.provider.changes(FLAG_KEY).map((change) => change.allocation.treatment)).not.toContain(SECOND_SHARE);
  });

  it("does not count units from before the step as new when the source answers empty once", async () => {
    expect.hasAssertions();
    const bench = await startedBench();
    await runFor(bench, STEP_MINUTES + 2);
    expect(bench.provider.serving(FLAG_KEY).allocation).toStrictEqual(measuredStep(SECOND_SHARE));
    await oneEmptyAnswer(bench);
    await runFor(bench, STEP_AND_A_BIT + A_WHILE);
    expect(recordOf(bench)).toMatchObject({ phase: "ramping", stepIndex: 1 });
    expect(bench.provider.serving(FLAG_KEY).allocation).toStrictEqual(measuredStep(SECOND_SHARE));
  });

  it("keeps time on the metric source's clock when every worker's clock is behind it", async () => {
    expect.hasAssertions();
    const bench = await startedBench();
    // The workers' clock is eleven minutes behind the metric source's, which is the same as its watermark being ahead.
    bench.lagMs = -(STEP_AND_A_BIT - 2) * MINUTE;
    await runFor(bench, 2 + 1);
    expect(treatmentShare(bench)).toBe(FIRST_SHARE);
  });
});
