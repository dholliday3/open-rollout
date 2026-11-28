import type { Authorization, RolloutTools, ToolCall, ToolRequest } from "./tools.js";
import { FIRST_SHARE, FLAG_KEY, METRIC, ROLLOUT_ID, START, createWorld, recordOf, runFor, treatmentShare } from "./__tests__/world.js";
import { describe, expect, it, vi } from "vitest";
import type { World } from "./__tests__/world.js";
import { rolloutTools } from "./tools.js";

vi.setConfig({ testTimeout: 10_000 });

const BROKEN = 0.5,
  A_WHILE = 5,
  HOUR = 3_600_000,
  FEW_UNITS = 5,
  STANDARD_FIRST_SHARE = 1000,
  START_INPUT: Parameters<RolloutTools["rollout_start"]["run"]>[0] = { flagKey: FLAG_KEY, guardrails: [{ direction: "lower_is_better", kind: "rate", metric: METRIC, onRegression: "rollback", tolerance: 0 }], id: "rollout-1", risk: "low" };

function call(world: World, callKey: string, actor = "dana"): ToolCall {
  return { actor, callKey, now: world.now };
}

/** Lets anyone do anything but release, which only Dana may do; and keeps every request it was asked about. */
function onlyDanaReleases(asked: ToolRequest[]): (request: ToolRequest) => Promise<Authorization> {
  return async (request) => {
    await Promise.resolve();
    asked.push(request);
    return request.tool === "rollout_release" && request.actor !== "dana" ? { allowed: false, reason: "Only Dana can release." } : { allowed: true };
  };
}

describe("the agent's rollout tools", () => {
  it("starts a rollout from a flag, a risk and guardrails", async () => {
    expect.hasAssertions();
    const world = createWorld(),
      answer = await rolloutTools(world.autopilot).rollout_start.run(START_INPUT, call(world, "call-1"));
    expect(answer).toMatchObject({ ok: true, rollout: { phase: "ramping", step: "1 of 2" } });
    expect(treatmentShare(world)).toBe(STANDARD_FIRST_SHARE);
  });

  it("says why a rollout can't start", async () => {
    expect.hasAssertions();
    const world = createWorld(),
      answer = await rolloutTools(world.autopilot).rollout_start.run({ ...START_INPUT, flagKey: "" }, call(world, "call-1"));
    expect(answer).toMatchObject({ message: "A plan names its flag.", ok: false, rollout: null });
  });

  it("applies a retried tool call once, because its key is the same", async () => {
    expect.hasAssertions();
    const world = createWorld(),
      tools = rolloutTools(world.autopilot);
    await tools.rollout_start.run(START_INPUT, call(world, "call-1"));
    await tools.rollout_pause.run({ id: "rollout-1", note: "checking a graph" }, call(world, "call-2"));
    const again = await tools.rollout_pause.run({ id: "rollout-1", note: "checking a graph" }, call(world, "call-2"));
    expect(again).toMatchObject({ message: "That was already done.", ok: true, rollout: { phase: "paused", waitingOn: "A person to resume it or roll it back." } });
    expect(world.notifier.events.filter((event) => event.type === "paused")).toHaveLength(1);
  });

  it("reports what each guardrail reads, and which one is worse", async () => {
    expect.hasAssertions();
    const world = createWorld({ guardrails: [{ direction: "lower_is_better", kind: "rate", metric: METRIC, onRegression: "pause", tolerance: 0 }] }),
      tools = rolloutTools(world.autopilot);
    await world.autopilot.start({ id: "rollout-1", now: START, plan: world.plan });
    world.errorRate = { control: 0, treatment: BROKEN };
    await runFor(world, A_WHILE);
    const status = await tools.rollout_status.run({ id: "rollout-1" }, call(world, "call-1"));
    expect(status.rollout?.guardrails).toMatchObject([{ metric: METRIC, onNewBehaviour: BROKEN, onOldBehaviour: 0, worse: true }]);
    expect(status.rollout?.headline).toContain("Paused");
  });
});

describe("the agent's rollout tools, planning for metrics that are slow or thin", () => {
  it("plans for metrics that arrive late, with the agent's changes to the standard plan", async () => {
    expect.hasAssertions();
    const world = createWorld(),
      answer = await rolloutTools(world.autopilot).rollout_start.run({ ...START_INPUT, overrides: { everyStep: { minFreshUnits: FEW_UNITS }, onInsufficientData: "rollback" }, sourceLagMs: HOUR }, call(world, "call-1")),
      { plan } = await recordOf(world);
    expect(answer).toMatchObject({ ok: true });
    expect(plan.limits.sourceLagMs).toBe(HOUR);
    expect(plan.steps.map((step) => step.minFreshUnits)).toStrictEqual([FEW_UNITS, FEW_UNITS]);
    expect(plan.onInsufficientData).toBe("rollback");
  });

  it("refuses a lag or an override of the wrong kind before it runs, and says why a plan the overrides spoil can't start", async () => {
    expect.hasAssertions();
    const world = createWorld(),
      tool = rolloutTools(world.autopilot).rollout_start;
    expect(tool.inputSchema.safeParse({ ...START_INPUT, sourceLagMs: -1 }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ ...START_INPUT, overrides: { onMetricsOutage: "shrug" } }).success).toBe(false);
    await expect(tool.run({ ...START_INPUT, overrides: { everyStep: { maxDurationMs: 1 } }, sourceLagMs: HOUR }, call(world, "call-1"))).resolves.toMatchObject({ ok: false });
    expect(treatmentShare(world)).toBe(0);
  });
});

describe("the agent's rollout tools, on the flag's own traffic", () => {
  const QUIET = 600,
    BUSY = 30_000,
    QUIET_FIRST_STEP_MS = 3_000_000;

  it("sizes the steps to the traffic the source measured, and says how long the rollout should take", async () => {
    expect.hasAssertions();
    const world = createWorld();
    world.metrics.setTraffic(QUIET);
    const answer = await rolloutTools(world.autopilot).rollout_start.run(START_INPUT, call(world, "call-1"));
    expect(answer).toMatchObject({ forecast: { problems: [], unitsPerHour: QUIET }, message: "The rollout has started. At about 600 new units an hour, it should take about 62 minutes.", ok: true });
    await expect(recordOf(world)).resolves.toMatchObject({ plan: { steps: [{ minDurationMs: QUIET_FIRST_STEP_MS }, {}] } });
  });

  it("refuses to start on a flag nobody evaluates, and writes nothing", async () => {
    expect.hasAssertions();
    const world = createWorld();
    world.metrics.setTraffic(0);
    await expect(rolloutTools(world.autopilot).rollout_start.run(START_INPUT, call(world, "call-1"))).resolves.toMatchObject({ message: /^Nobody evaluates new-checkout/u, ok: false, rollout: null });
    expect(world.flags.peek(FLAG_KEY).revision).toBe(0);
  });

  it("takes the traffic the agent gives over the source's, and forecasts without starting anything", async () => {
    expect.hasAssertions();
    const world = createWorld(),
      tools = rolloutTools(world.autopilot);
    world.metrics.setTraffic(0);
    const { id: _id, ...plan } = START_INPUT;
    await expect(tools.rollout_forecast.run({ ...plan, unitsPerHour: BUSY }, call(world, "call-1"))).resolves.toMatchObject({ message: "At about 30000 new units an hour, it should take about 22 minutes.", ok: true, rollout: null });
    await expect(tools.rollout_forecast.run(plan, call(world, "call-2"))).resolves.toMatchObject({ forecast: { unitsPerHour: 0 }, ok: false });
    expect(world.flags.peek(FLAG_KEY).revision).toBe(0);
  });

  it("asks for the traffic when the source can't measure it", async () => {
    expect.hasAssertions();
    const world = createWorld(),
      { id: _id, ...plan } = START_INPUT;
    await expect(rolloutTools(world.autopilot).rollout_forecast.run(plan, call(world, "call-1"))).resolves.toStrictEqual({ message: "The metric source can't say how much traffic this flag gets. Give unitsPerHour.", ok: false, rollout: null });
    await expect(world.autopilot.traffic(FLAG_KEY)).resolves.toBeNull();
  });
});

describe("the agent's rollout tools, for a fix", () => {
  it("makes the bug's own error a goal the release waits on, and leaves other guardrails as they were", async () => {
    expect.hasAssertions();
    const world = createWorld(),
      [errors] = START_INPUT.guardrails,
      input = { ...START_INPUT, guardrails: [{ ...errors, mustImproveBy: 0 }, { ...errors, metric: "latency" }] };
    await expect(rolloutTools(world.autopilot).rollout_start.run(input, call(world, "call-1"))).resolves.toMatchObject({ ok: true });
    const { plan } = await recordOf(world);
    expect(plan.guardrails[0].mustImproveBy).toBe(0);
    expect(plan.guardrails[1]).not.toHaveProperty("mustImproveBy");
    expect(rolloutTools(world.autopilot).rollout_start.inputSchema.safeParse({ ...input, guardrails: [{ ...errors, mustImproveBy: -1 }] }).success).toBe(false);
  });
});

describe("the agent's rollout tools, behind an authorize hook", () => {
  it("refuses a release the hook refuses, with its reason, and leaves the record and the flag as they were", async () => {
    expect.hasAssertions();
    const world = createWorld(),
      tools = rolloutTools(world.autopilot, { authorize: onlyDanaReleases([]) });
    await tools.rollout_start.run(START_INPUT, call(world, "call-1"));
    const before = await world.store.load(ROLLOUT_ID),
      refused = await tools.rollout_release.run({ id: ROLLOUT_ID }, call(world, "call-2", "sam"));
    expect(refused).toStrictEqual({ message: "Not allowed: Only Dana can release.", ok: false, rollout: null });
    await expect(world.store.load(ROLLOUT_ID)).resolves.toStrictEqual(before);
    expect(treatmentShare(world)).toBe(STANDARD_FIRST_SHARE);
  });

  it("runs a release the hook allows, after telling it the tool, the input and who it is for", async () => {
    expect.hasAssertions();
    const world = createWorld(),
      asked: ToolRequest[] = [],
      tools = rolloutTools(world.autopilot, { authorize: onlyDanaReleases(asked) });
    await tools.rollout_start.run(START_INPUT, call(world, "call-1"));
    await expect(tools.rollout_release.run({ id: ROLLOUT_ID }, call(world, "call-2"))).resolves.toMatchObject({ ok: true, rollout: { phase: "releasing" } });
    expect(asked.map((request) => request.tool)).toStrictEqual(["rollout_start", "rollout_release"]);
    expect(asked.at(-1)).toStrictEqual({ actor: "dana", callKey: "call-2", input: { id: ROLLOUT_ID }, now: world.now, tool: "rollout_release" });
  });

  it("asks before a status too, and shows a refused caller no rollout", async () => {
    expect.hasAssertions();
    const world = createWorld(),
      tools = rolloutTools(world.autopilot, { authorize: () => ({ allowed: false, reason: "Sam can't see rollouts." }) });
    await rolloutTools(world.autopilot).rollout_start.run(START_INPUT, call(world, "call-1"));
    await expect(tools.rollout_status.run({ id: ROLLOUT_ID }, call(world, "call-2", "sam"))).resolves.toStrictEqual({ message: "Not allowed: Sam can't see rollouts.", ok: false, rollout: null });
  });
});

describe("the agent's rollout tools, told what to do", () => {
  it("refuses in a sentence what makes no sense, and says when there is no such rollout", async () => {
    expect.hasAssertions();
    const world = createWorld(),
      tools = rolloutTools(world.autopilot);
    await expect(tools.rollout_resume.run({ id: "nope" }, call(world, "call-1"))).resolves.toMatchObject({ message: "There is no rollout with that id.", ok: false });
    await tools.rollout_start.run(START_INPUT, call(world, "call-2"));
    await expect(tools.rollout_resume.run({ id: "rollout-1" }, call(world, "call-3"))).resolves.toMatchObject({ message: "Only a paused rollout can be resumed.", ok: false });
  });

  it("rolls back and releases on a person's word", async () => {
    expect.hasAssertions();
    const world = createWorld(),
      tools = rolloutTools(world.autopilot);
    await tools.rollout_start.run(START_INPUT, call(world, "call-1"));
    await expect(tools.rollout_rollback.run({ id: "rollout-1", note: "wrong flag" }, call(world, "call-2"))).resolves.toMatchObject({ ok: true, rollout: { onNewBehaviour: "0%" } });
    await expect(tools.rollout_release.run({ id: "rollout-1" }, call(world, "call-3"))).resolves.toMatchObject({ ok: false });
    expect(treatmentShare(world)).toBe(0);
    expect(FIRST_SHARE).toBe(STANDARD_FIRST_SHARE);
  });

  it("approves a gate ahead of time, so the rollout doesn't stop at it", async () => {
    expect.hasAssertions();
    const world = createWorld(),
      tools = rolloutTools(world.autopilot);
    await tools.rollout_start.run({ ...START_INPUT, risk: "high" }, call(world, "call-1"));
    await expect(tools.rollout_approve.run({ gate: "release", id: "rollout-1" }, call(world, "call-2"))).resolves.toMatchObject({ ok: true });
    await expect(tools.rollout_approve.run({ gate: 0, id: "rollout-1" }, call(world, "call-3"))).resolves.toMatchObject({ ok: false });
  });
});
