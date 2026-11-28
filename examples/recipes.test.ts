import type { ArmPair, Autopilot, RolloutPlan, RolloutRecord } from "open-rollout";
import { BUG_FLAG, billingEngine, bugFix, checkoutPlan, datadogHold, lagProblems, onboardingPlan, searchPlan, serviceRewrite, slackTools, tableFlags, unprepared } from "./recipes.js";
import type { FlagRow, PostHogConnection } from "./recipes.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAutopilot, createMemoryFlags, createMemoryNotifier, createMemoryStore, planProblems } from "open-rollout";
import type { PostHogCall } from "open-rollout/posthog";
// eslint-disable-next-line import/no-nodejs-modules -- the README is read from disk so its sample output can't drift from these recipes
import { readFile } from "node:fs/promises";
import { simulatedTraffic } from "./simulated-traffic.js";

vi.setConfig({ testTimeout: 10_000 });

const MINUTE = 60_000,
  ROLLOUT_ID = "r1",
  BASE_ERROR_RATE = 0.02,
  CONVERTS = 0.1,
  CONVERTS_40_PERCENT_LESS = 0.06,
  NO_DIFFERENCE = { control: BASE_ERROR_RATE, treatment: BASE_ERROR_RATE },
  THREE_HOURS = 180,
  TEN_PERCENT = 1000,
  README = await readFile(new URL("../README.md", import.meta.url), "utf8");

interface Run {
  readonly autopilot: Autopilot;
  readonly events: readonly { readonly type: string; readonly minute: number }[];
  readonly record: RolloutRecord;
  readonly share: number;
}

/** A plan against the quickstart's simulated traffic, a tick a minute, and what happened. */
async function rollOut(plan: RolloutPlan, minutes: number, traffic: { rates?: Record<string, ArmPair<number>>; lagMs?: number } = {}): Promise<Run> {
  const flags = createMemoryFlags(),
    notifier = createMemoryNotifier(),
    store = createMemoryStore(),
    simulated = simulatedTraffic({ errorRate: NO_DIFFERENCE, flagKey: plan.flagKey, flags, metric: "errors", ...traffic }),
    autopilot = createAutopilot({ flags, metrics: simulated, notifier, store }),
    startedAt = simulated.now();
  await autopilot.start({ id: ROLLOUT_ID, now: startedAt, plan });
  for (let minute = 0; minute < minutes; minute += 1) {
    simulated.passMinute();
    await autopilot.tickAll(simulated.now());
  }
  const stored = await store.load(ROLLOUT_ID);
  if (stored === null) {
    throw new Error("The rollout never started.");
  }
  return { autopilot, events: notifier.events.map((event) => ({ minute: (event.at - startedAt) / MINUTE, type: event.type })), record: stored.record, share: flags.peek(plan.flagKey).allocation.treatment };
}

/** A PostHog whose every event was seen lately and nobody is exposed yet; it keeps the queries it was sent. */
function recordingPostHog(): PostHogConnection & { readonly sent: PostHogCall[] } {
  const sent: PostHogCall[] = [],
    now = Date.UTC(2026, 0, 5),
    seen = ["seen0", "seen1", "seen2", "seen3", "seen4"];
  return {
    ingestionLagMs: MINUTE,
    now: () => now,
    projectId: 1,
    sent,
    transport: async (call) => {
      await Promise.resolve();
      sent.push(call);
      return { body: { columns: ["as_of", "latest", ...seen], results: [[now / 1000, now / 1000, ...seen.map(() => 1)]] }, status: 200 };
    },
  };
}

describe("recipe: a billing engine judged by account", () => {
  it("counts PostHog's $group_0, waits a day a step, and asks a person before the release", async () => {
    expect.hasAssertions();
    const postHog = recordingPostHog(),
      { metrics, plan } = billingEngine(postHog);
    await metrics.snapshot({ flagKey: plan.flagKey, guardrails: plan.guardrails, since: 0 });
    expect(JSON.stringify(postHog.sent)).toContain("$group_0 AS unit");
    expect(planProblems(plan)).toStrictEqual([]);
    expect(plan.steps.map((step) => step.minDurationMs / MINUTE)).toStrictEqual([1440, 1440]);
    expect(plan.requiresApprovalToRelease).toBe(true);
  });
});

describe("recipe: a checkout redesign that might hurt conversion", () => {
  it("releases a checkout that converts as well as the old one", async () => {
    expect.hasAssertions();
    const run = await rollOut(checkoutPlan, THREE_HOURS, { rates: { converted: { control: CONVERTS, treatment: CONVERTS } } });
    expect(run.events.at(-1)).toStrictEqual({ minute: 69, type: "released" });
  });

  it("rolls back a checkout that converts 40% less", async () => {
    expect.hasAssertions();
    const run = await rollOut(checkoutPlan, THREE_HOURS, { rates: { converted: { control: CONVERTS, treatment: CONVERTS_40_PERCENT_LESS } } });
    expect(run.events.map((event) => event.type)).toStrictEqual(["started", "step_started", "step_started", "rolling_back", "rolled_back"]);
    expect(run.events.at(-1)?.minute).toBe(23);
    expect(run.record.desired).toStrictEqual({ control: 0, treatment: 0 });
    expect(run.record.stepIndex).toBe(1);
    expect(checkoutPlan.steps[1]?.treatmentShare).toBe(TEN_PERCENT);
    expect(run.record.outcome).toMatchObject({ finding: { metric: "converted" }, reason: "regression" });
    expect(run.share).toBe(0);
  });
});

describe("recipe: a rewritten backend service", () => {
  it("has a plan that can run and metrics PostHog can be asked for", async () => {
    expect.hasAssertions();
    const { metrics, plan } = serviceRewrite(recordingPostHog());
    expect(planProblems(plan)).toStrictEqual([]);
    await expect(metrics.snapshot({ flagKey: plan.flagKey, guardrails: plan.guardrails, since: 0 })).resolves.toMatchObject({ exposed: { control: 0, treatment: 0 } });
  });
});

describe("recipe: metrics from a warehouse an hour behind", () => {
  it("releases healthy code when the plan knows the lag", async () => {
    expect.hasAssertions();
    const run = await rollOut(searchPlan, THREE_HOURS, { lagMs: 60 * MINUTE });
    expect(run.events.at(-1)).toStrictEqual({ minute: 145, type: "released" });
  });

  it("never turns the flag on, and reports an outage, when the plan doesn't know the lag", async () => {
    expect.hasAssertions();
    const run = await rollOut(unprepared, THREE_HOURS, { lagMs: 60 * MINUTE });
    expect(run.events).toStrictEqual([{ minute: 0, type: "started" }, { minute: 16, type: "metrics_outage" }]);
    expect(run.share).toBe(0);
  });

  it("names what can't work when a plan declares the lag it wasn't built for, as the README shows", () => {
    expect.hasAssertions();
    expect(lagProblems).toHaveLength(3);
    expect(README).toContain(`\`\`\`text\n${lagProblems.join("\n")}\n\`\`\``);
  });
});

describe("recipe: on-call pauses and rolls back from Slack, release leads release", () => {
  it("refuses a release from someone else, leaving the record as it was, and lets them roll back", async () => {
    expect.hasAssertions();
    const { autopilot } = await rollOut(searchPlan, 2),
      tools = slackTools(autopilot),
      before = await autopilot.inspect(ROLLOUT_ID),
      release = await tools.rollout_release.run({ id: ROLLOUT_ID }, { actor: "U09ONCALL", callKey: "slack:1", now: Date.now() });
    expect(release).toStrictEqual({ message: "Not allowed: Only a release lead can do that.", ok: false, rollout: null });
    expect((await autopilot.inspect(ROLLOUT_ID))?.record).toStrictEqual(before?.record);
    await expect(tools.rollout_rollback.run({ id: ROLLOUT_ID, note: "Errors in #support." }, { actor: "U09ONCALL", callKey: "slack:2", now: Date.now() })).resolves.toMatchObject({ ok: true, rollout: { onNewBehaviour: "0%" } });
  });

  it("lets a release lead release", async () => {
    expect.hasAssertions();
    const { autopilot } = await rollOut(searchPlan, 2);
    await expect(slackTools(autopilot).rollout_release.run({ id: ROLLOUT_ID }, { actor: "U02LEAD", callKey: "slack:3", now: Date.now() })).resolves.toMatchObject({ ok: true, rollout: { phase: "releasing" } });
  });
});

/** A one-table flag store in memory, answering the two statements `tableFlags` sends. */
function flagTable(rows: Map<string, FlagRow>) {
  return async (sql: string, values: readonly unknown[]): Promise<FlagRow> => {
    await Promise.resolve();
    const [key, control, treatment, expected] = values.map(String),
      row = rows.get(key);
    if (row === undefined || (sql.startsWith("UPDATE") && expected !== "null" && Number(expected) !== row.revision)) {
      throw new Error("No row.");
    }
    if (sql.startsWith("UPDATE")) {
      rows.set(key, { control: Number(control), revision: row.revision + 1, treatment: Number(treatment) });
    }
    return rows.get(key) ?? row;
  };
}

describe("recipe: flags in your own Postgres table", () => {
  it("writes on the revision it read, moves the revision on, and refuses a write over a stale one", async () => {
    expect.hasAssertions();
    const rows = new Map([["search-ranking-v2", { control: 0, revision: 7, treatment: 0 }]]),
      flags = tableFlags(flagTable(rows)),
      { revision } = await flags.read("search-ranking-v2");
    await expect(flags.write("search-ranking-v2", { control: 1000, treatment: 1000 }, revision)).resolves.toBe(8);
    await expect(flags.write("search-ranking-v2", { control: 0, treatment: 0 }, revision)).rejects.toThrow("No row.");
    await expect(flags.read("search-ranking-v2")).resolves.toStrictEqual({ allocation: { control: 1000, treatment: 1000 }, revision: 8 });
  });
});

/** The bug-fix recipe against the quickstart's traffic: the plan it picks from the flag's traffic, then a tick a minute. */
async function fixRun(rates: ArmPair<number>, peoplePerMinute = 1000): Promise<{ plan: RolloutPlan | null; events: readonly string[]; record: RolloutRecord | null }> {
  const flags = createMemoryFlags(),
    notifier = createMemoryNotifier(),
    store = createMemoryStore(),
    simulated = simulatedTraffic({ errorRate: NO_DIFFERENCE, flagKey: BUG_FLAG, flags, metric: "errors", peoplePerMinute, rates: { double_charged: rates } }),
    autopilot = createAutopilot({ flags, metrics: simulated, notifier, store }),
    plan = await bugFix(autopilot);
  if (plan === null) {
    return { events: [], plan, record: null };
  }
  await autopilot.start({ id: ROLLOUT_ID, now: simulated.now(), plan });
  for (let minute = 0; minute < THREE_HOURS; minute += 1) {
    simulated.passMinute();
    await autopilot.tickAll(simulated.now());
  }
  return { events: notifier.events.map((event) => event.type), plan, record: (await store.load(ROLLOUT_ID))?.record ?? null };
}

describe("recipe: a bug fix that must be shown to work", () => {
  it("releases a fix once double charges are shown rarer on it", async () => {
    expect.hasAssertions();
    const run = await fixRun({ control: 0.05, treatment: 0 });
    expect(run.events.at(-1)).toBe("released");
  });

  it("stops at the last step, as unproven, a change that left double charges as they were", async () => {
    expect.hasAssertions();
    const run = await fixRun({ control: 0.05, treatment: 0.05 });
    expect(run.record).toMatchObject({ pause: { reason: "unproven" }, phase: "paused" });
  });

  it("answers no plan on a path too quiet to flag, so the fix ships without one", async () => {
    expect.hasAssertions();
    await expect(fixRun({ control: 0.05, treatment: 0 }, 0.01)).resolves.toMatchObject({ plan: null });
  });
});

describe("recipe: a mobile app whose phones keep a copy of the flag", () => {
  it("watches each step half an hour longer, for phones to pick it up, and rolls back a build that crashes", async () => {
    expect.hasAssertions();
    expect(planProblems(onboardingPlan)).toStrictEqual([]);
    expect(onboardingPlan.limits.propagationMs).toBe(30 * MINUTE);
    const run = await rollOut({ ...onboardingPlan, flagKey: "new-checkout" }, THREE_HOURS, { rates: { crashed: { control: 0.01, treatment: 0.2 } } });
    expect(run.record).toMatchObject({ outcome: { finding: { metric: "crashed" }, reason: "regression" }, phase: "rolled_back" });
  });
});

describe("recipe: hold every rollout while a Datadog monitor alerts", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks Datadog for the tagged monitors with both keys, and reports the one in alert", async () => {
    expect.hasAssertions();
    const fetched: { url: string; headers: unknown }[] = [];
    vi.stubGlobal("fetch", async (url: URL, init: { headers: unknown }) => {
      await Promise.resolve();
      fetched.push({ headers: init.headers, url: url.toString() });
      return Response.json([{ id: 9, name: "Payments 5xx", overall_state: "Alert", tags: ["open-rollout:hold"] }]);
    });
    await expect(datadogHold({ api: "api-key", app: "app-key" }).open()).resolves.toStrictEqual([{ id: "datadog-monitor-9", title: "Payments 5xx" }]);
    expect(fetched).toStrictEqual([{ headers: { "DD-API-KEY": "api-key", "DD-APPLICATION-KEY": "app-key" }, url: "https://api.datadoghq.com/api/v1/monitor?monitor_tags=open-rollout%3Ahold&page=0&page_size=1000" }]);
  });
});
