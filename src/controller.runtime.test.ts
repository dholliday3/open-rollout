import { FIRST_SHARE, FLAG_KEY, MINUTE, ROLLOUT_ID, createWorld, eventTypes, passMinute, recordOf, runFor, startRollout, startedWorld, treatmentShare } from "./__tests__/world.js";
import { describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 10_000 });

const LONG_ENOUGH_TO_SETTLE = 60,
  A_WHILE = 5;

describe("a runtime that misbehaves", () => {
  it("lets only one of two workers act on the same tick", async () => {
    expect.hasAssertions();
    const world = await startedWorld();
    passMinute(world);
    const results = await Promise.all([world.autopilot.tick(ROLLOUT_ID, world.now), world.autopilot.tick(ROLLOUT_ID, world.now)]);
    expect(results.map((result) => result.status)).toContain("lost_race");
    expect(results.map((result) => result.status)).toContain("ticked");
    expect(eventTypes(world).filter((type) => type === "step_started")).toHaveLength(1);
  });

  it("delivers an event later when the notifier was down, and only once", async () => {
    expect.hasAssertions();
    const world = await startedWorld();
    vi.spyOn(world.notifier, "notify").mockRejectedValueOnce(new Error("slack is down"));
    await runFor(world, 1);
    expect((await recordOf(world)).outbox).toHaveLength(1);
    await runFor(world, 1);
    expect((await recordOf(world)).outbox).toHaveLength(0);
    expect(eventTypes(world).filter((type) => type === "step_started")).toHaveLength(1);
  });

  it("turns the flag off blind when it can't read it during a rollback", async () => {
    expect.hasAssertions();
    const world = await startedWorld(),
      read = vi.spyOn(world.flags, "read").mockRejectedValue(new Error("provider is down"));
    await world.autopilot.command(ROLLOUT_ID, { by: "dana", id: "c1", type: "rollback" }, world.now);
    expect(treatmentShare(world)).toBe(0);
    expect(read).toHaveBeenCalledWith(FLAG_KEY);
  });
});

describe("a runtime that fails partway", () => {
  it("keeps trying a flag write that fails", async () => {
    expect.hasAssertions();
    const world = createWorld();
    vi.spyOn(world.flags, "write").mockRejectedValueOnce(new Error("timeout"));
    await startRollout(world);
    expect(treatmentShare(world)).toBe(0);
    await runFor(world, 1);
    expect(treatmentShare(world)).toBe(FIRST_SHARE);
  });

  it("does not let time run backwards when a worker's clock is behind", async () => {
    expect.hasAssertions();
    const world = await startedWorld();
    await runFor(world, A_WHILE);
    const before = await recordOf(world);
    await world.autopilot.tick(ROLLOUT_ID, world.now - LONG_ENOUGH_TO_SETTLE * MINUTE);
    expect((await recordOf(world)).clock).toBe(before.clock);
    expect(treatmentShare(world)).toBe(FIRST_SHARE);
  });

  it("stops ticking a rollback once it has settled", async () => {
    expect.hasAssertions();
    const world = await startedWorld();
    await world.autopilot.command(ROLLOUT_ID, { by: "dana", id: "c1", type: "rollback" }, world.now);
    await runFor(world, LONG_ENOUGH_TO_SETTLE);
    expect((await world.autopilot.tick(ROLLOUT_ID, world.now)).status).toBe("settled");
  });
});

describe("a flag provider that answers nonsense", () => {
  it("treats shares that can't be right as no reading, and says so", async () => {
    expect.hasAssertions();
    const world = await startedWorld();
    vi.spyOn(world.flags, "read").mockResolvedValue({ allocation: { control: Number.NaN, treatment: -1 }, revision: 9 });
    passMinute(world);
    const result = await world.autopilot.tick(ROLLOUT_ID, world.now);
    expect(result.problems).toStrictEqual(["The flag provider answered with shares that can't be right."]);
    expect(result.wrote).toBe(false);
  });
});

describe("a store that can't be reached", () => {
  it("is reported as a failed tick, not thrown, and the next tick carries on", async () => {
    expect.hasAssertions();
    const world = await startedWorld();
    vi.spyOn(world.store, "load").mockRejectedValueOnce(new Error("connection reset"));
    await expect(world.autopilot.tick(ROLLOUT_ID, world.now)).resolves.toMatchObject({ problems: ["The tick failed: connection reset"], status: "failed" });
    await runFor(world, 1);
    expect(treatmentShare(world)).toBe(FIRST_SHARE);
  });

  it("is reported for that rollout alone when every rollout is ticked", async () => {
    expect.hasAssertions();
    const world = await startedWorld();
    vi.spyOn(world.store, "load").mockRejectedValueOnce(new Error("connection reset"));
    await expect(world.autopilot.tickAll(world.now)).resolves.toMatchObject([{ problems: ["The tick failed: connection reset"], status: "failed" }]);
  });
});

describe("a start that is sent twice", () => {
  it("finds its own rollout the second time, and refuses when the flag can't be read", async () => {
    expect.hasAssertions();
    const world = await startedWorld(),
      again = await world.autopilot.start({ id: ROLLOUT_ID, now: world.now, plan: world.plan }),
      other = createWorld();
    expect(again.status).toBe("started");
    expect(eventTypes(world).filter((type) => type === "started")).toHaveLength(1);
    await expect(world.autopilot.start({ id: ROLLOUT_ID, now: world.now, plan: { ...world.plan, requiresApprovalToRelease: true } })).resolves.toMatchObject({ problems: ["A rollout with this id already exists, with a different plan."], status: "refused" });
    vi.spyOn(other.flags, "read").mockRejectedValue(new Error("provider is down"));
    await expect(other.autopilot.start({ id: ROLLOUT_ID, now: other.now, plan: other.plan })).resolves.toMatchObject({ problems: ["The flag couldn't be read: provider is down"], status: "refused" });
  });
});

describe("a flag provider that answers from behind", () => {
  it("says so, changes nothing, and carries on when the provider catches up", async () => {
    expect.hasAssertions();
    const world = await startedWorld();
    await runFor(world, 2);
    vi.spyOn(world.flags, "read").mockResolvedValueOnce({ allocation: { control: 0, treatment: 0 }, revision: 0 });
    passMinute(world);
    const behind = await world.autopilot.tick(ROLLOUT_ID, world.now);
    expect(behind.problems).toStrictEqual(["The flag provider answered at revision 0, behind 1 already seen. Ignoring that reading."]);
    expect(behind.record?.pause).toBeNull();
    await runFor(world, 1);
    expect(treatmentShare(world)).toBe(FIRST_SHARE);
  });
});
