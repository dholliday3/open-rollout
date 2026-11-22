import type { ReleaseStage, Releaser } from "../release";
import { createMemoryFlags, createMemoryMetrics, createMemoryNotifier, createMemoryStore } from "../adapters/memory";
import { createMemoryReleaseStore, createReleaser } from "../release";
import { describe, expect, it, vi } from "vitest";
import { EVERYBODY } from "../allocation";
import type { MemoryFlags } from "../adapters/memory";
import { benchPlan } from "./bench";
import { createAutopilot } from "../controller";

vi.setConfig({ testTimeout: 10_000 });

/**
 * `release.ts` takes one change through environments. Its README line: "the next environment starts only
 * after the one before it has released, and a rollback anywhere pauses everything that hasn't started".
 * A stage marked running whose rollout was refused (the flag is already on there, the plan can't run) is
 * neither: nothing is running, nothing is paused, and nobody is told.
 */

const START = 1_700_000_000_000,
  MINUTE = 60_000,
  A_FEW = 5,
  PLAN = benchPlan(),
  PRODUCTION: ReleaseStage = { environment: "production", plan: PLAN, trigger: "promotion" };

interface Stage {
  readonly flags: MemoryFlags;
  readonly releaser: Releaser;
}

function setUp(): Stage {
  const flags = createMemoryFlags(),
    autopilot = createAutopilot({ flags, metrics: createMemoryMetrics(), notifier: createMemoryNotifier(), store: createMemoryStore() });
  return { flags, releaser: createReleaser({ autopilotFor: () => autopilot, store: createMemoryReleaseStore() }) };
}

async function tickFor(releaser: Releaser, minutes: number): Promise<void> {
  if (minutes <= 0) {
    return;
  }
  await releaser.tick("release-1", START + minutes * MINUTE);
  await tickFor(releaser, minutes - 1);
}

describe("a release across environments", () => {
  it("refuses to start with a stage whose plan can't run, instead of finding out when that stage's turn comes", async () => {
    expect.hasAssertions();
    const { releaser } = setUp(),
      broken: ReleaseStage = { ...PRODUCTION, plan: { ...PLAN, steps: [] } };
    await expect(releaser.start("release-1", [{ ...PRODUCTION, environment: "staging" }, broken])).resolves.toBe(false);
  });

  it("says why a stage can't begin when its flag is already on, instead of calling it running for ever", async () => {
    expect.hasAssertions();
    const { flags, releaser } = setUp();
    flags.setByHand(PLAN.flagKey, EVERYBODY);
    await releaser.start("release-1", [PRODUCTION]);
    await tickFor(releaser, A_FEW);
    const release = await releaser.tick("release-1", START);
    expect({ paused: release?.pausedBecause, status: release?.states.at(0)?.status }).not.toStrictEqual({ paused: null, status: "running" });
  });
});
