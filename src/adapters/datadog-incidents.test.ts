import { describe, expect, it, vi } from "vitest";
import type { DatadogCall } from "./datadog-incidents.js";
import { createDatadogIncidents } from "./datadog-incidents.js";

vi.setConfig({ testTimeout: 5000 });

const OK = 200,
  UNAVAILABLE = 503,
  PAGE_SIZE = 1000,
  TAGS = ["open-rollout:hold", "env:prod"],
  ALERTING = { id: 1, name: "Checkout 5xx above 2%", overall_state: "Alert", tags: TAGS },
  WARNING = { id: 2, name: "Latency p95 above 1s", overall_state: "Warn", tags: TAGS },
  FINE = { id: 3, name: "Queue depth", overall_state: "OK", tags: TAGS },
  OTHER_ENV = { id: 4, name: "Checkout 5xx, staging", overall_state: "Alert", tags: ["open-rollout:hold", "env:staging"] };

/** A Datadog that answers each page of monitors from this list, and keeps every call. */
function datadog(monitors: readonly unknown[], status = OK): { calls: DatadogCall[]; transport: (call: DatadogCall) => Promise<{ status: number; body: unknown }> } {
  const calls: DatadogCall[] = [];
  return {
    calls,
    transport: async (call) => {
      await Promise.resolve();
      calls.push(call);
      const index = Number(new URL(call.path, "https://api.datadoghq.com").searchParams.get("page"));
      return { body: monitors.slice(index * PAGE_SIZE, (index + 1) * PAGE_SIZE), status };
    },
  };
}

describe("the Datadog incident feed", () => {
  it("reports the tagged monitors in alert as incidents, and asks Datadog for those tags", async () => {
    expect.hasAssertions();
    const api = datadog([ALERTING, WARNING, FINE]),
      feed = createDatadogIncidents({ monitorTags: TAGS, transport: api.transport });
    await expect(feed.open()).resolves.toStrictEqual([{ id: "datadog-monitor-1", title: "Checkout 5xx above 2%" }]);
    expect(api.calls[0].path).toBe("/api/v1/monitor?monitor_tags=open-rollout%3Ahold%2Cenv%3Aprod&page=0&page_size=1000");
  });

  it("counts a warning too when asked, and never a monitor missing one of the tags", async () => {
    expect.hasAssertions();
    const feed = createDatadogIncidents({ monitorTags: TAGS, states: ["Alert", "Warn"], transport: datadog([ALERTING, WARNING, OTHER_ENV]).transport });
    await expect(feed.open()).resolves.toHaveLength(2);
  });

  it("reads every page", async () => {
    expect.hasAssertions();
    const many = Array.from({ length: PAGE_SIZE }, (_unused, index) => ({ ...FINE, id: index + PAGE_SIZE })),
      api = datadog([...many, ALERTING]);
    await expect(createDatadogIncidents({ monitorTags: TAGS, transport: api.transport }).open()).resolves.toHaveLength(1);
    expect(api.calls).toHaveLength(2);
  });

  it("fails on an answer it can't read, so the rollout holds instead of taking silence for an all-clear", async () => {
    expect.hasAssertions();
    await expect(createDatadogIncidents({ monitorTags: TAGS, transport: datadog([], UNAVAILABLE).transport }).open()).rejects.toThrow("Datadog answered 503");
    await expect(createDatadogIncidents({ monitorTags: TAGS, transport: datadog([{ name: "no id" }]).transport }).open()).rejects.toThrow(/expected number/u);
  });

  it("refuses at once to be made with no tags, which would let every monitor hold every rollout", () => {
    expect.hasAssertions();
    expect(() => createDatadogIncidents({ monitorTags: [], transport: datadog([]).transport })).toThrow("Name the tags");
  });
});
