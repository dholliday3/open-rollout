import { EVERYBODY, NOBODY, measuredStep } from "../allocation";
import { FIRST_SHARE, FLAG_KEY, ROLLOUT_ID, SECOND_SHARE, createBench, eventTypes, passTime, recordOf, runFor, send, startedBench, treatmentShare } from "./bench";
import { describe, expect, it, vi } from "vitest";
import type { Bench } from "./bench";
import type { Command } from "../commands";

vi.setConfig({ testTimeout: 10_000 });

const WHOLE_ROLLOUT = 45,
  A_WHILE = 5,
  BROKEN = 0.5,
  MANY = 25,
  STEP_AND_A_BIT = 13,
  FORTY_FIVE_SECONDS = 45_000,
  PAUSE_ON_REGRESSION = { direction: "lower_is_better", kind: "rate", metric: "errors", onRegression: "pause", tolerance: 0 } as const;

function pause(id: string): Command {
  return { by: "dana", id, type: "pause" };
}

function resume(id: string): Command {
  return { by: "dana", id, type: "resume" };
}

/** Pauses and resumes over and over, each with an id of its own, as a chatty agent might. */
async function pauseAndResume(bench: Bench, times: number): Promise<void> {
  if (times <= 0) {
    return;
  }
  await send(bench, pause(`pause-${times}`));
  await send(bench, resume(`resume-${times}`));
  await pauseAndResume(bench, times - 1);
}

/**
 * README claim 4, "A pause never raises exposure. A person lowering the flag by hand pauses the rollout and
 * is left alone; only an explicit resume puts the step back."
 */
describe("claim 4: a person's kill switch", () => {
  it("is left alone when it is pulled just after a step was written, before the next tick", async () => {
    expect.hasAssertions();
    const bench = await startedBench();
    expect(treatmentShare(bench)).toBe(FIRST_SHARE);
    bench.provider.setByHand(FLAG_KEY, NOBODY, "dana");
    await runFor(bench, 2);
    expect(treatmentShare(bench)).toBe(0);
    expect(bench.provider.changes(FLAG_KEY).at(-1)?.by).toBe("dana");
  });

  it("is left alone when it is pulled just after the release was written", async () => {
    expect.hasAssertions();
    const bench = createBench({ plan: { requiresApprovalToRelease: true } });
    await bench.autopilot.start({ id: ROLLOUT_ID, now: bench.now, plan: bench.plan });
    await runFor(bench, WHOLE_ROLLOUT);
    await send(bench, { by: "dana", gate: "release", id: "ok", type: "approve" });
    expect(bench.provider.serving(FLAG_KEY).allocation).toStrictEqual(EVERYBODY);
    bench.provider.setByHand(FLAG_KEY, NOBODY, "dana");
    await runFor(bench, 2);
    expect(treatmentShare(bench)).toBe(0);
  });

  it("is left alone once the step has been seen in force (the case the library handles)", async () => {
    expect.hasAssertions();
    const bench = await startedBench();
    await runFor(bench, 2);
    bench.provider.setByHand(FLAG_KEY, NOBODY, "dana");
    await runFor(bench, A_WHILE);
    expect(treatmentShare(bench)).toBe(0);
    expect(recordOf(bench).pause?.reason).toBe("external_change");
  });
});

/** README claim 5: "A command id is applied once however often it is sent." */
describe("claim 5: a command sent again", () => {
  it("is still a duplicate after fifty other commands", async () => {
    expect.hasAssertions();
    const bench = await startedBench();
    await send(bench, pause("first-pause"));
    await send(bench, resume("first-resume"));
    await pauseAndResume(bench, MANY);
    await expect(send(bench, pause("first-pause"))).resolves.toBe("duplicate");
    expect(recordOf(bench).phase).toBe("ramping");
  });

  it("is not applied later when it was refused the first time", async () => {
    expect.hasAssertions();
    const bench = await startedBench({ plan: { guardrails: [PAUSE_ON_REGRESSION] } });
    // An agent's resume arrives while nothing is paused, and is refused.
    await expect(send(bench, resume("stray-resume"))).resolves.toBe("refused");
    bench.errorRate = { control: 0, treatment: BROKEN };
    await runFor(bench, A_WHILE);
    expect(recordOf(bench).pause?.reason).toBe("regression");
    // The runtime delivers the same call again (at-least-once). Nobody decided to resume past the regression.
    await expect(send(bench, resume("stray-resume"))).resolves.not.toBe("applied");
    expect(eventTypes(bench)).not.toContain("resumed");
  });
});

/** README claim 4 again, at the tick spacing a real schedule has: not one tick a minute, but one every 45 seconds. */
describe("claim 4: a person's kill switch, pulled within a minute of a step", () => {
  it("is left alone when the next tick comes 45 seconds after the step was written", async () => {
    expect.hasAssertions();
    const bench = await startedBench();
    expect(treatmentShare(bench)).toBe(FIRST_SHARE);
    bench.provider.setByHand(FLAG_KEY, NOBODY, "dana");
    passTime(bench, FORTY_FIVE_SECONDS);
    await bench.autopilot.tick(ROLLOUT_ID, bench.now);
    expect(bench.provider.changes(FLAG_KEY).at(-1)?.by).toBe("dana");
    expect(treatmentShare(bench)).toBe(0);
  });

  it("is left alone when a step-up is turned back to the step before, 45 seconds after it was written", async () => {
    expect.hasAssertions();
    const bench = await startedBench();
    await runFor(bench, STEP_AND_A_BIT - 1);
    expect(treatmentShare(bench)).toBe(SECOND_SHARE);
    bench.provider.setByHand(FLAG_KEY, measuredStep(FIRST_SHARE), "dana");
    passTime(bench, FORTY_FIVE_SECONDS);
    await bench.autopilot.tick(ROLLOUT_ID, bench.now);
    expect(bench.provider.changes(FLAG_KEY).at(-1)?.by).toBe("dana");
    expect(treatmentShare(bench)).toBe(FIRST_SHARE);
  });
});
