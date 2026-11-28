import { EVERYBODY, measuredStep } from "./allocation.js";
import { FIRST_SHARE, FLAG_KEY, ROLLOUT_ID, SECOND_SHARE, createWorld, eventTypes, recordOf, runFor, treatmentShare } from "./__tests__/world.js";
import type { FlagControl, Incident } from "./ports.js";
import { describe, expect, it, vi } from "vitest";
import type { World } from "./__tests__/world.js";
import { createAutopilot } from "./controller.js";
import { summarize } from "./summary.js";

vi.setConfig({ testTimeout: 10_000 });

/**
 * An incident across the product hits both arms alike, so no guardrail sees it. While the feed reports one,
 * a rollout raises no exposure and goes through no gate; its guardrails still act.
 */

const OUTAGE: Incident = { id: "monitor-1", title: "Checkout API 5xx above 2%" },
  INTO_THE_FIRST_STEP = 5,
  WELL_PAST_A_STEP = 30,
  BROKEN = 0.5;

/** The test world's rollout, driven by an autopilot that also reads an incident feed this test controls. */
function withFeed(world: World, flags: FlagControl = world.flags): { feed: { incidents: readonly Incident[] | Error }; world: World } {
  const feed: { incidents: readonly Incident[] | Error } = { incidents: [] },
    incidents = {
      open: async (): Promise<readonly Incident[]> => {
        await Promise.resolve();
        if (feed.incidents instanceof Error) {
          throw feed.incidents;
        }
        return feed.incidents;
      },
    };
  return { feed, world: { ...world, autopilot: createAutopilot({ flags, incidents, metrics: world.metrics, notifier: world.notifier, store: world.store }) } };
}

async function headlineOf(world: World): Promise<string> {
  const inspection = await world.autopilot.inspect(ROLLOUT_ID);
  if (inspection === null) {
    throw new Error("The rollout was never started.");
  }
  return summarize(inspection).headline;
}

async function started(): Promise<ReturnType<typeof withFeed>> {
  const fed = withFeed(createWorld());
  await fed.world.autopilot.start({ id: ROLLOUT_ID, now: fed.world.now, plan: fed.world.plan });
  return fed;
}

describe("a rollout during an incident", () => {
  it("holds at its step while the incident is open, and says why", async () => {
    expect.hasAssertions();
    const { feed, world } = await started();
    await runFor(world, INTO_THE_FIRST_STEP);
    feed.incidents = [OUTAGE];
    await runFor(world, WELL_PAST_A_STEP);
    expect(treatmentShare(world)).toBe(FIRST_SHARE);
    await expect(headlineOf(world)).resolves.toBe("Held: Checkout API 5xx above 2%: an incident is open. Nothing moves forward until it clears.");
  });

  it("goes on as soon as the incident clears, the watch it kept during the hold counted, and says so once each way", async () => {
    expect.hasAssertions();
    const { feed, world } = await started();
    feed.incidents = [OUTAGE];
    await runFor(world, WELL_PAST_A_STEP);
    feed.incidents = [];
    await runFor(world, 1);
    expect(treatmentShare(world)).toBe(SECOND_SHARE);
    expect(eventTypes(world).filter((type) => type.startsWith("incident_"))).toStrictEqual(["incident_hold", "incident_cleared"]);
  });

  it("exposes nobody when it starts during an incident, until the incident clears", async () => {
    expect.hasAssertions();
    const { feed, world } = withFeed(createWorld());
    feed.incidents = [OUTAGE];
    await world.autopilot.start({ id: ROLLOUT_ID, now: world.now, plan: world.plan });
    await runFor(world, INTO_THE_FIRST_STEP);
    expect(treatmentShare(world)).toBe(0);
    feed.incidents = [];
    await runFor(world, 1);
    expect(treatmentShare(world)).toBe(FIRST_SHARE);
  });

  it("is still rolled back by its guardrails while held", async () => {
    expect.hasAssertions();
    const { feed, world } = await started();
    feed.incidents = [OUTAGE];
    world.errorRate = { ...world.errorRate, treatment: BROKEN };
    await runFor(world, WELL_PAST_A_STEP);
    await expect(recordOf(world)).resolves.toMatchObject({ outcome: { reason: "regression" }, phase: "rolled_back" });
    expect(treatmentShare(world)).toBe(0);
  });
});

describe("a rollout whose incident feed fails", () => {
  it("holds, as it would for an open incident, and says what failed", async () => {
    expect.hasAssertions();
    const { feed, world } = await started();
    feed.incidents = new Error("Datadog answered 503.");
    await runFor(world, WELL_PAST_A_STEP);
    expect(treatmentShare(world)).toBe(FIRST_SHARE);
    await expect(world.autopilot.tick(ROLLOUT_ID, world.now)).resolves.toMatchObject({ problems: ["Reading the incidents failed: Datadog answered 503."] });
  });

  it("still releases when a person forces it", async () => {
    expect.hasAssertions();
    const { feed, world } = await started();
    feed.incidents = [OUTAGE];
    await world.autopilot.command(ROLLOUT_ID, { by: "dana", id: "c1", type: "release" }, world.now);
    await runFor(world, 1);
    expect(world.flags.peek(FLAG_KEY).allocation).toStrictEqual(EVERYBODY);
  });
});

/** A rollout released on a provider that can't refuse a stale write, still being watched before it settles. */
async function releasedOnLooseProvider(): Promise<ReturnType<typeof withFeed> & { plain: World }> {
  const plain = createWorld(),
    fed = withFeed(plain, { ...plain.flags, refusesStaleWrites: false });
  await fed.world.autopilot.start({ id: ROLLOUT_ID, now: fed.world.now, plan: fed.world.plan });
  await runFor(fed.world, WELL_PAST_A_STEP);
  return { ...fed, plain };
}

describe("a released rollout during an incident", () => {
  it("doesn't put back a release a stalled worker wrote over until the incident clears", async () => {
    expect.hasAssertions();
    const { feed, plain, world } = await releasedOnLooseProvider();
    feed.incidents = [OUTAGE];
    plain.flags.setByHand(FLAG_KEY, measuredStep(SECOND_SHARE));
    await runFor(world, 1);
    expect(treatmentShare(world)).toBe(SECOND_SHARE);
    feed.incidents = [];
    await runFor(world, 1);
    await expect(recordOf(world)).resolves.toMatchObject({ phase: "released", settled: false });
    expect(treatmentShare(world)).toBe(EVERYBODY.treatment);
  });
});
