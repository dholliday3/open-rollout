import { BASE_ERROR_RATE, FIRST_SHARE, FLAG_KEY, ROLLOUT_ID, SECOND_SHARE, createWorld, eventTypes, recordOf, runFor, startedWorld, treatmentShare } from "./__tests__/world.js";
import { EVERYBODY, FULL_SHARE, NOBODY, measuredStep } from "./allocation.js";
import { describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 10_000 });

const BROKEN = 0.5,
  STEP_AND_A_BIT = 13,
  WHOLE_ROLLOUT = 40,
  A_WHILE = 5,
  LOWERED = 200,
  RAISED = 4000;

describe("a flag someone else changes", () => {
  it("pauses and leaves the flag alone when a person lowers it", async () => {
    expect.hasAssertions();
    const world = await startedWorld();
    await runFor(world, 2);
    world.flags.setByHand(FLAG_KEY, measuredStep(LOWERED));
    await runFor(world, STEP_AND_A_BIT);
    expect((await recordOf(world)).pause?.reason).toBe("external_change");
    expect(treatmentShare(world)).toBe(LOWERED);
  });

  it("puts the step back when that person resumes", async () => {
    expect.hasAssertions();
    const world = await startedWorld();
    await runFor(world, 2);
    world.flags.setByHand(FLAG_KEY, NOBODY);
    await runFor(world, 2);
    await world.autopilot.command(ROLLOUT_ID, { by: "dana", id: "c1", type: "resume" }, world.now);
    expect(treatmentShare(world)).toBe(FIRST_SHARE);
  });

  it("brings the flag back down when something raises it", async () => {
    expect.hasAssertions();
    const world = await startedWorld();
    await runFor(world, 2);
    world.flags.setByHand(FLAG_KEY, measuredStep(RAISED));
    await runFor(world, 1);
    expect(treatmentShare(world)).toBe(FIRST_SHARE);
    expect(eventTypes(world)).toContain("drift_corrected");
  });

  it("turns the flag off again when it comes back on after a rollback", async () => {
    expect.hasAssertions();
    const world = await startedWorld();
    await world.autopilot.command(ROLLOUT_ID, { by: "dana", id: "c1", type: "rollback" }, world.now);
    world.flags.setByHand(FLAG_KEY, measuredStep(RAISED));
    await runFor(world, 2);
    expect(treatmentShare(world)).toBe(0);
    expect((await recordOf(world)).phase).toBe("rolled_back");
  });

  it("refuses to start on a flag that is already on", async () => {
    expect.hasAssertions();
    const world = createWorld();
    world.flags.setByHand(FLAG_KEY, { control: 0, treatment: FULL_SHARE });
    const result = await world.autopilot.start({ id: ROLLOUT_ID, now: world.now, plan: world.plan });
    expect(result.status).toBe("refused");
    expect(treatmentShare(world)).toBe(FULL_SHARE);
  });
});

describe("what people tell a rollout", () => {
  it("waits at a step that needs approval, and moves when it is given", async () => {
    expect.hasAssertions();
    const world = createWorld();
    await world.autopilot.start({ id: ROLLOUT_ID, now: world.now, plan: { ...world.plan, requiresApprovalToRelease: true } });
    await runFor(world, WHOLE_ROLLOUT);
    expect((await recordOf(world)).phase).toBe("awaiting_approval");
    expect(treatmentShare(world)).toBe(SECOND_SHARE);
    await world.autopilot.command(ROLLOUT_ID, { by: "dana", gate: "release", id: "c1", type: "approve" }, world.now);
    expect(world.flags.peek(FLAG_KEY).allocation).toStrictEqual(EVERYBODY);
  });

  it("still rolls back a regression while it waits for approval", async () => {
    expect.hasAssertions();
    const world = createWorld();
    await world.autopilot.start({ id: ROLLOUT_ID, now: world.now, plan: { ...world.plan, requiresApprovalToRelease: true } });
    await runFor(world, WHOLE_ROLLOUT);
    world.errorRate = { control: BASE_ERROR_RATE, treatment: BROKEN };
    await runFor(world, A_WHILE);
    expect((await recordOf(world)).outcome?.reason).toBe("regression");
    expect(treatmentShare(world)).toBe(0);
  });

  it("applies a command once however often it is sent", async () => {
    expect.hasAssertions();
    const world = await startedWorld(),
      pause = { by: "dana", id: "c1", type: "pause" } as const;
    expect((await world.autopilot.command(ROLLOUT_ID, pause, world.now)).status).toBe("applied");
    expect((await world.autopilot.command(ROLLOUT_ID, pause, world.now)).status).toBe("duplicate");
    expect(eventTypes(world).filter((type) => type === "paused")).toHaveLength(1);
  });
});

describe("what people tell a rollout to stop or finish", () => {
  it("holds a paused rollout on its step", async () => {
    expect.hasAssertions();
    const world = await startedWorld();
    await world.autopilot.command(ROLLOUT_ID, { by: "dana", id: "c1", type: "pause" }, world.now);
    await runFor(world, WHOLE_ROLLOUT);
    expect(treatmentShare(world)).toBe(FIRST_SHARE);
  });

  it("rolls back at once on a person's word, without waiting for a tick", async () => {
    expect.hasAssertions();
    const world = await startedWorld();
    await world.autopilot.command(ROLLOUT_ID, { by: "dana", id: "c1", note: "support is on fire", type: "rollback" }, world.now);
    expect(treatmentShare(world)).toBe(0);
    expect((await recordOf(world)).outcome?.detail).toContain("support is on fire");
  });

  it("releases to everybody on a person's word, skipping what is left", async () => {
    expect.hasAssertions();
    const world = await startedWorld();
    await world.autopilot.command(ROLLOUT_ID, { by: "dana", id: "c1", type: "release" }, world.now);
    expect(world.flags.peek(FLAG_KEY).allocation).toStrictEqual(EVERYBODY);
    expect((await recordOf(world)).outcome?.reason).toBe("forced");
  });
});

describe("an approval that arrives while the rollout is paused", () => {
  it("is honoured when the rollout is resumed", async () => {
    expect.hasAssertions();
    const world = createWorld();
    await world.autopilot.start({ id: ROLLOUT_ID, now: world.now, plan: { ...world.plan, requiresApprovalToRelease: true } });
    await runFor(world, WHOLE_ROLLOUT);
    await world.autopilot.command(ROLLOUT_ID, { by: "dana", id: "c1", type: "pause" }, world.now);
    await world.autopilot.command(ROLLOUT_ID, { by: "dana", gate: "release", id: "c2", type: "approve" }, world.now);
    expect(treatmentShare(world)).toBe(SECOND_SHARE);
    await world.autopilot.command(ROLLOUT_ID, { by: "dana", id: "c3", type: "resume" }, world.now);
    await runFor(world, 2);
    expect(world.flags.peek(FLAG_KEY).allocation).toStrictEqual(EVERYBODY);
  });
});
