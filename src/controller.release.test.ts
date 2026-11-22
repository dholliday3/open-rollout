import { EVERYBODY, FULL_SHARE } from "./allocation";
import { FLAG_KEY, ROLLOUT_ID, SECOND_SHARE, createWorld, eventTypes, passMinute, recordOf, runFor, startRollout, startedWorld, treatmentShare } from "./__tests__/world";
import { describe, expect, it, vi } from "vitest";
import type { Allocation } from "./allocation";
import type { World } from "./__tests__/world";

vi.setConfig({ testTimeout: 10_000 });

const WHOLE_ROLLOUT = 40,
  A_WHILE = 5,
  HALF_AN_HOUR = 30;

/** Makes the provider refuse the write that releases to everybody, and only that one, until the returned function is called. */
function refuseTheRelease(world: World): () => void {
  const write = world.flags.write.bind(world.flags),
    spy = vi.spyOn(world.flags, "write").mockImplementation(async (flagKey: string, allocation: Allocation, expectedRevision?: number) => {
      if (allocation.treatment === FULL_SHARE) {
        throw new Error("the provider is refusing writes");
      }
      const revision = await write(flagKey, allocation, expectedRevision);
      return revision;
    });
  return () => {
    spy.mockRestore();
  };
}

function idle(world: World, minutes: number): void {
  for (let minute = 0; minute < minutes; minute += 1) {
    passMinute(world);
  }
}

async function waitingForApproval(): Promise<World> {
  const world = createWorld({ requiresApprovalToRelease: true });
  await startRollout(world);
  await runFor(world, WHOLE_ROLLOUT);
  return world;
}

describe("a release whose write never goes through", () => {
  it("keeps the last step, goes back to its gate, and tells people once", async () => {
    expect.hasAssertions();
    const world = await startedWorld();
    refuseTheRelease(world);
    await runFor(world, WHOLE_ROLLOUT + HALF_AN_HOUR);
    expect(treatmentShare(world)).toBe(SECOND_SHARE);
    expect(eventTypes(world).filter((type) => type === "releasing")).toHaveLength(1);
    expect(eventTypes(world)).not.toContain("released");
  });

  it("is still watched: a regression that shows up while the provider refuses the release rolls it back", async () => {
    expect.hasAssertions();
    const world = await startedWorld();
    refuseTheRelease(world);
    await runFor(world, WHOLE_ROLLOUT);
    world.errorRate = { control: 0, treatment: 1 };
    await runFor(world, A_WHILE);
    expect((await recordOf(world)).outcome?.reason).toBe("regression");
    expect(treatmentShare(world)).toBe(0);
  });

  it("lands as soon as the provider takes it", async () => {
    expect.hasAssertions();
    const world = await startedWorld(),
      allow = refuseTheRelease(world);
    await runFor(world, WHOLE_ROLLOUT);
    allow();
    await runFor(world, A_WHILE);
    expect(world.flags.peek(FLAG_KEY).allocation).toStrictEqual(EVERYBODY);
  });

  it("does not go back to its gate when a person forced it: it just keeps trying", async () => {
    expect.hasAssertions();
    const world = await startedWorld();
    refuseTheRelease(world);
    await world.autopilot.command(ROLLOUT_ID, { by: "dana", id: "c1", type: "release" }, world.now);
    await runFor(world, HALF_AN_HOUR);
    expect((await recordOf(world)).phase).toBe("releasing");
  });
});

describe("an approval and the evidence", () => {
  it("does not release on a yes while the metrics are down, and does once they are back", async () => {
    expect.hasAssertions();
    const world = await waitingForApproval();
    world.metricsDown = true;
    await runFor(world, A_WHILE);
    await world.autopilot.command(ROLLOUT_ID, { by: "dana", gate: "release", id: "c1", type: "approve" }, world.now);
    await runFor(world, A_WHILE);
    expect(treatmentShare(world)).toBe(SECOND_SHARE);
    world.metricsDown = false;
    await runFor(world, 2);
    expect(world.flags.peek(FLAG_KEY).allocation).toStrictEqual(EVERYBODY);
  });

  it("rolls back, not releases, on a yes when the new arm is already failing", async () => {
    expect.hasAssertions();
    const world = await waitingForApproval();
    world.errorRate = { control: 0, treatment: 1 };
    // Nobody ticks for a while: the world goes on, and the metrics are there to read when the yes arrives.
    idle(world, A_WHILE);
    await world.autopilot.command(ROLLOUT_ID, { by: "dana", gate: "release", id: "c1", type: "approve" }, world.now);
    await runFor(world, 2);
    expect((await recordOf(world)).outcome?.reason).toBe("regression");
    expect(treatmentShare(world)).toBe(0);
  });

  it("lets a person force a release while the metrics are down, and nothing else raise exposure then", async () => {
    expect.hasAssertions();
    const world = await startedWorld();
    world.metricsDown = true;
    await runFor(world, A_WHILE);
    await world.autopilot.command(ROLLOUT_ID, { by: "dana", id: "c1", type: "release" }, world.now);
    expect(world.flags.peek(FLAG_KEY).allocation).toStrictEqual(EVERYBODY);
  });
});

describe("a plan with no guardrails", () => {
  it("is a timed ramp: each step waits out its time, and the metrics are never asked", async () => {
    expect.hasAssertions();
    const world = createWorld({ guardrails: [] }),
      snapshot = vi.spyOn(world.metrics, "snapshot");
    world.metricsDown = true;
    await startRollout(world);
    await runFor(world, A_WHILE);
    expect(treatmentShare(world)).toBeLessThan(SECOND_SHARE);
    await runFor(world, WHOLE_ROLLOUT);
    expect(world.flags.peek(FLAG_KEY).allocation).toStrictEqual(EVERYBODY);
    expect(snapshot).not.toHaveBeenCalled();
  });
});
