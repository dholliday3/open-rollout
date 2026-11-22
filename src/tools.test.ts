import { FIRST_SHARE, FLAG_KEY, METRIC, START, createWorld, runFor, treatmentShare } from "./__tests__/world.js";
import type { RolloutTools, ToolCall } from "./tools.js";
import { describe, expect, it, vi } from "vitest";
import type { World } from "./__tests__/world.js";
import { rolloutTools } from "./tools.js";

vi.setConfig({ testTimeout: 10_000 });

const BROKEN = 0.5,
  A_WHILE = 5,
  STANDARD_FIRST_SHARE = 1000,
  START_INPUT: Parameters<RolloutTools["rollout_start"]["run"]>[0] = { flagKey: FLAG_KEY, guardrails: [{ direction: "lower_is_better", kind: "rate", metric: METRIC, onRegression: "rollback", tolerance: 0 }], id: "rollout-1", risk: "low" };

function call(world: World, callKey: string): ToolCall {
  return { actor: "dana", callKey, now: world.now };
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
