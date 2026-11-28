import { createPostHogMetrics, snapshotFrom, snapshotQuery } from "./posthog-metrics.js";
import { describe, expect, it, vi } from "vitest";
import type { MetricQuery } from "../ports.js";
import type { PostHogReply } from "./posthog-transport.js";
import { z } from "zod";

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
  GROUP_TYPES = 5,
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

describe("the PostHog metric source's unit", () => {
  it("counts people by default, in who was exposed and in what they did", () => {
    expect.hasAssertions();
    const { query } = snapshotQuery({ ...OPTIONS, transport: unused }, QUERY, NOW - LAG);
    expect(query.match(/person_id AS unit/g)).toHaveLength(2);
    expect(query).not.toContain("$group_");
  });

  it("counts a PostHog group instead when given its type index, leaving out events sent without one", () => {
    expect.hasAssertions();
    const { query } = snapshotQuery({ ...OPTIONS, transport: unused, unit: { groupTypeIndex: 2 } }, QUERY, NOW - LAG);
    expect(query.match(/\$group_2 AS unit/g)).toHaveLength(2);
    expect(query.match(/AND \$group_2 != ''/g)).toHaveLength(2);
    expect(query).not.toContain("person_id");
  });

  it("refuses at once a group type index PostHog doesn't have, which would go into the query's text", () => {
    expect.hasAssertions();
    const invalid = [-1, GROUP_TYPES, GROUP_TYPES / 2, Number.NaN];
    for (const groupTypeIndex of invalid) {
      expect(() => createPostHogMetrics({ ...OPTIONS, transport: unused, unit: { groupTypeIndex } })).toThrow("A PostHog group type index is a whole number from 0 to 4");
    }
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

describe("the PostHog metric source's traffic", () => {
  const values = z.record(z.string(), z.unknown()),
    hogQuery = z.object({ query: z.string(), values }),
    querySchema = z.object({ query: hogQuery }),
    DAY = 86_400_000,
    PEOPLE_A_DAY = 480,
    PER_HOUR = 20;

  it("counts every unit that evaluated the flag over the window, whatever it was served, as units an hour", async () => {
    expect.hasAssertions();
    const calls: { query: string; values: Record<string, unknown> }[] = [],
      source = createPostHogMetrics({
        ...OPTIONS,
        transport: async (call) => {
          await Promise.resolve();
          calls.push(querySchema.parse(call.body).query);
          return { body: { columns: ["units"], results: [[PEOPLE_A_DAY]] }, status: OK };
        },
      });
    await expect(source.traffic?.({ flagKey: "new-checkout", windowMs: DAY })).resolves.toBe(PER_HOUR);
    expect(calls[0].query).toContain("uniqExact(person_id)");
    expect(calls[0].query).toContain("event = '$feature_flag_called'");
    expect(calls[0].query).not.toContain("$feature_flag_response");
    expect(calls[0].values).toStrictEqual({ flag: "new-checkout", since: (NOW - LAG - DAY) / MS_PER_SECOND, until: (NOW - LAG) / MS_PER_SECOND });
  });

  it("counts groups when the unit is a group, and refuses a window of no time", async () => {
    expect.hasAssertions();
    const asked: string[] = [],
      source = createPostHogMetrics({
        ...OPTIONS,
        transport: async (call) => {
          await Promise.resolve();
          asked.push(JSON.stringify(call.body));
          return { body: { columns: ["units"], results: [[0]] }, status: OK };
        },
        unit: { groupTypeIndex: 2 },
      });
    await expect(source.traffic?.({ flagKey: "new-checkout", windowMs: DAY })).resolves.toBe(0);
    expect(asked[0]).toContain("uniqExact($group_2)");
    await expect(source.traffic?.({ flagKey: "new-checkout", windowMs: 0 })).rejects.toThrow("over some time");
  });
});
