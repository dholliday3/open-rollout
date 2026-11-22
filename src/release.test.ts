import type { ReleaseStage, Releaser } from "./release";
import { createMemoryReleaseStore, createReleaser, newRelease, nextToStart, observed, resumed, rolloutId, signalled } from "./release";
import { createWorld, passMinute, testPlan } from "./__tests__/world";
import { describe, expect, it, vi } from "vitest";
import type { World } from "./__tests__/world";

vi.setConfig({ testTimeout: 10_000 });

const WHOLE_ROLLOUT = 40,
  A_WHILE = 5,
  BROKEN = 0.5,
  STAGES: ReleaseStage[] = [
    { environment: "staging", plan: testPlan(), trigger: "deploy_signal" },
    { environment: "production", plan: testPlan(), trigger: "promotion" },
  ];

interface Setup {
  readonly releaser: Releaser;
  readonly worlds: Record<string, World>;
}

function setup(): Setup {
  const worlds: Record<string, World> = { production: createWorld(), staging: createWorld() },
    autopilotFor = (environment: string) => (environment === "staging" ? worlds.staging : worlds.production).autopilot;
  return { releaser: createReleaser({ autopilotFor, store: createMemoryReleaseStore() }), worlds };
}

/** A minute everywhere: traffic, every rollout's tick, then the release's own tick. */
async function runFor(made: Setup, minutes: number): Promise<void> {
  if (minutes <= 0) {
    return;
  }
  const ticking: Promise<unknown>[] = [];
  for (const world of Object.values(made.worlds)) {
    passMinute(world);
    ticking.push(world.autopilot.tickAll(world.now));
  }
  await Promise.all(ticking);
  await made.releaser.tick("release-1", made.worlds.staging.now);
  await runFor(made, minutes - 1);
}

function share(world: World): number {
  return world.flags.peek(testPlan().flagKey).allocation.treatment;
}

describe("the order environments start in", () => {
  it("starts nothing until the first environment's signal arrives", () => {
    expect.hasAssertions();
    const release = newRelease("release-1", STAGES);
    expect(nextToStart(release)).toBe(-1);
    expect(nextToStart(signalled(release, "staging"))).toBe(0);
  });

  it("keeps a signal that arrives early, and ignores one for an environment it doesn't have", () => {
    expect.hasAssertions();
    const release = newRelease("release-1", [STAGES[0], { ...STAGES[1], trigger: "manual" }]),
      early = signalled(release, "production");
    expect(early.states[1].triggered).toBe(true);
    expect(nextToStart(early)).toBe(-1);
    expect(signalled(release, "moon")).toBe(release);
  });

  it("pauses the rest when an environment rolls back, and asks for its signal again on resume", () => {
    expect.hasAssertions();
    const running = { ...newRelease("release-1", STAGES), states: [{ attempt: 0, status: "running" as const, triggered: true }, { attempt: 0, status: "waiting" as const, triggered: false }] },
      paused = observed(running, 0, "rolled_back");
    expect(paused.pausedBecause).toBe("The rollout in staging was rolled back.");
    expect(nextToStart(paused)).toBe(-1);
    expect(resumed(paused).states[0]).toStrictEqual({ attempt: 1, status: "waiting", triggered: false });
    expect(rolloutId(resumed(paused), 0)).toBe("release-1/staging/1");
  });
});

describe("a release across environments", () => {
  it("rolls out staging on its deploy signal, then production by itself", async () => {
    expect.hasAssertions();
    const made = setup();
    await made.releaser.start("release-1", STAGES);
    await runFor(made, A_WHILE);
    expect(share(made.worlds.staging)).toBe(0);
    await made.releaser.signal("release-1", "staging");
    await runFor(made, WHOLE_ROLLOUT);
    expect(share(made.worlds.staging)).toBeGreaterThan(0);
    await runFor(made, WHOLE_ROLLOUT);
    expect(share(made.worlds.production)).toBeGreaterThan(share(made.worlds.staging) - 1);
  });

  it("never starts production when staging rolls back", async () => {
    expect.hasAssertions();
    const made = setup();
    made.worlds.staging.errorRate = { control: 0, treatment: BROKEN };
    await made.releaser.start("release-1", STAGES);
    await made.releaser.signal("release-1", "staging");
    await runFor(made, WHOLE_ROLLOUT);
    expect(share(made.worlds.staging)).toBe(0);
    expect(share(made.worlds.production)).toBe(0);
    await expect(made.releaser.tick("release-1", made.worlds.staging.now)).resolves.toMatchObject({ pausedBecause: "The rollout in staging was rolled back." });
  });

  it("starts an environment's rollout once, however often it ticks", async () => {
    expect.hasAssertions();
    const made = setup();
    await made.releaser.start("release-1", STAGES);
    await made.releaser.signal("release-1", "staging");
    await made.releaser.signal("release-1", "staging");
    await runFor(made, A_WHILE);
    expect(made.worlds.staging.notifier.events.filter((event) => event.type === "started")).toHaveLength(1);
  });
});
