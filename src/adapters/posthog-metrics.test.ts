import { createPostHogMetrics, snapshotFrom, snapshotQuery } from "./posthog-metrics.js";
import { describe, expect, it, vi } from "vitest";
import type { MetricQuery } from "../ports.js";
import type { PostHogReply } from "./posthog-transport.js";

vi.setConfig({ testTimeout: 5000 });

const OK = 200,
  NOW = 1_795_000_000_000,
  LAG = 60_000,
  SINCE = 1_794_990_000_000,
  QUIET_SINCE_SECONDS = 1_794_999_000,
  MS_PER_SECOND = 1000,
  NOW_SECONDS = 1_795_000_000,
  /** PostHog's clock when the caller's is half a minute fast. */
  SLOWER_SECONDS = 1_794_999_970,
  OPTIONS = { ingestionLagMs: 60_000, metrics: { errors: { denominatorEvent: "request", event: "$exception" } }, now: (): number => NOW, projectId: 1 },
  QUERY: MetricQuery = { flagKey: "new-checkout", guardrails: [{ direction: "lower_is_better", kind: "ratio", metric: "errors", onRegression: "rollback", tolerance: 0 }], since: SINCE },
  ROWS = [
    { arm: "control", cross0: 30, d0_squares: 900, d0_sum: 300, n0_squares: 9, n0_sum: 5, units: 40 },
    { arm: "treatment", cross0: 60, d0_squares: 800, d0_sum: 280, n0_squares: 20, n0_sum: 12, units: 38 },
    { arm: "both", units: 2 },
  ];

async function unused(): Promise<PostHogReply> {
  await Promise.resolve();
  return { body: {}, status: OK };
}

/** A PostHog that answers every query with one row of these cells: its clock, its newest event, then one count per event asked about. */
function answering(cells: number[]): () => Promise<PostHogReply> {
  return async () => {
    await Promise.resolve();
    return { body: { columns: ["as_of", "latest", "seen0", "seen1"].slice(0, cells.length), results: [cells] }, status: OK };
  };
}

describe("the PostHog metric source", () => {
  it("turns the query's rows into per-arm totals, leaving out units seen on both arms", () => {
    expect.hasAssertions();
    const snapshot = snapshotFrom(ROWS, { asOf: NOW, query: QUERY, watermark: NOW });
    expect(snapshot.exposed).toStrictEqual({ control: 40, treatment: 38 });
    expect(snapshot.contaminated).toBe(2);
    expect(snapshot.metrics["errors"].treatment).toStrictEqual({ denominator: { crossSum: 60, sum: 280, sumSquares: 800 }, sum: 12, sumSquares: 20, units: 38 });
  });

  it("counts an arm with no rows as empty", () => {
    expect.hasAssertions();
    expect(snapshotFrom([], { asOf: NOW, query: QUERY, watermark: NOW }).exposed).toStrictEqual({ control: 0, treatment: 0 });
  });

  it("asks only for what happened after a person was first exposed, inside the window", () => {
    expect.hasAssertions();
    const built = snapshotQuery({ ingestionLagMs: LAG, metrics: { errors: { denominatorEvent: "request", event: "$exception" } }, now: () => NOW, projectId: 1, transport: unused }, QUERY, NOW - LAG);
    expect(built.query).toContain("activity.timestamp >= exposure.first_seen");
    expect(built.values).toMatchObject({ event0: "$exception", flag: "new-checkout", under0: "request" });
  });

  it("puts the watermark at the newest event when nothing has arrived lately, and takes the time from PostHog's own clock", async () => {
    expect.hasAssertions();
    const metrics = createPostHogMetrics({ ...OPTIONS, transport: answering([NOW_SECONDS, QUIET_SINCE_SECONDS, 1, 1]) });
    await expect(metrics.snapshot(QUERY)).resolves.toMatchObject({ asOf: NOW_SECONDS * MS_PER_SECOND, watermark: QUIET_SINCE_SECONDS * MS_PER_SECOND });
  });
});

describe("the PostHog metric source's times", () => {
  it("never puts the watermark later than the lag behind PostHog's own clock, however fast the caller's clock is", async () => {
    expect.hasAssertions();
    const busy = createPostHogMetrics({ ...OPTIONS, transport: answering([SLOWER_SECONDS, SLOWER_SECONDS, 1, 1]) }),
      level = createPostHogMetrics({ ...OPTIONS, transport: answering([NOW_SECONDS, NOW_SECONDS, 1, 1]) });
    await expect(busy.snapshot(QUERY)).resolves.toMatchObject({ watermark: SLOWER_SECONDS * MS_PER_SECOND - LAG });
    await expect(level.snapshot(QUERY)).resolves.toMatchObject({ watermark: NOW - LAG });
  });

});

describe("the PostHog metric source's refusals", () => {
  it("refuses to read a metric whose event PostHog has not seen in a month, unless the metric says that can happen", async () => {
    expect.hasAssertions();
    const neverSeen = answering([NOW_SECONDS, QUIET_SINCE_SECONDS, 0, 1]),
      rare = { errors: { denominatorEvent: "request", event: "$exception", mayBeUnseen: true } };
    await expect(createPostHogMetrics({ ...OPTIONS, transport: neverSeen }).snapshot(QUERY)).rejects.toThrow("PostHog has not seen $exception in a month");
    await expect(createPostHogMetrics({ ...OPTIONS, metrics: rare, transport: answering([NOW_SECONDS, QUIET_SINCE_SECONDS]) }).snapshot(QUERY)).resolves.toMatchObject({ contaminated: 0 });
  });

  it("keeps a cell that isn't a number as not a number, so the snapshot is refused rather than read as zero", () => {
    expect.hasAssertions();
    const snapshot = snapshotFrom([{ arm: "control", n0_sum: "oops", units: 40 }], { asOf: NOW, query: QUERY, watermark: NOW });
    expect(snapshot.metrics["errors"].control.sum).toBeNaN();
  });

  it("refuses a guardrail with no PostHog definition", () => {
    expect.hasAssertions();
    expect(() => snapshotQuery({ ingestionLagMs: LAG, metrics: {}, now: () => NOW, projectId: 1, transport: unused }, QUERY, NOW)).toThrow("no usable PostHog definition");
  });
});
