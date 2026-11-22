import { EVERYBODY, measuredStep } from "../allocation.js";
import { FIRST_SHARE, FLAG_KEY, ROLLOUT_ID, createBench, eventTypes, gatedWorker, idleFor, passMinute, recordOf, runFor, startedBench, treatmentShare } from "./bench.js";
import { describe, expect, it, vi } from "vitest";
import type { Bench } from "./bench.js";
import type { Gate } from "./gate.js";
import type { Phase } from "../record.js";
import { createGate } from "./gate.js";

vi.setConfig({ testTimeout: 10_000 });

const A_WHILE = 5,
  AN_HOUR = 60,
  STEP_AND_A_BIT = 13,
  SECOND_SHARE = 5000;

/** Ticks once a minute until the rollout is in a phase, or an hour has passed. */
async function runUntil(bench: Bench, phase: Phase, minutesLeft = AN_HOUR): Promise<void> {
  if (recordOf(bench).phase === phase || minutesLeft <= 0) {
    return;
  }
  passMinute(bench);
  await bench.autopilot.tick(ROLLOUT_ID, bench.now);
  await runUntil(bench, phase, minutesLeft - 1);
}

/** A rollout on a provider with no revision check, with a worker stalled inside its write of the first step. */
async function stalledOnFirstStep(): Promise<{ bench: Bench; gate: Gate; stalled: Promise<unknown> }> {
  const bench = createBench({ checksRevision: false }),
    gate = createGate();
  bench.provider.faults.writesDown = true;
  await bench.autopilot.start({ id: ROLLOUT_ID, now: bench.now, plan: bench.plan });
  bench.provider.faults.writesDown = false;
  idleFor(bench, 1);
  const stalled = gatedWorker(bench, gate, "zombie").tick(ROLLOUT_ID, bench.now);
  await gate.runUntil("zombie", "flags.write");
  return { bench, gate, stalled };
}

/**
 * The release itself changes the arms: everybody new goes to the new behaviour and nobody to the old, so
 * from the moment the release is written the arms stop being the same size, and people who were on the
 * old one are seen on both. None of that says the new code is worse.
 *
 * README claim 6: "Over a whole rollout of healthy code, the chance that any guardrail calls it worse is at
 * most limits.alpha" and the sample ratio check "has its own budget". Claim 7: a few clean ticks bring the
 * flag to `record.desired`.
 */
describe("claims 6 and 7: a healthy release is not undone by what releasing does to the arms", () => {
  it("has written the release once every step has passed", async () => {
    expect.hasAssertions();
    const bench = await startedBench();
    await runUntil(bench, "releasing");
    expect(recordOf(bench).phase).toBe("releasing");
    expect(bench.provider.serving(FLAG_KEY).allocation).toStrictEqual(EVERYBODY);
  });

  it("finishes the release when the next tick comes five minutes late", async () => {
    expect.hasAssertions();
    const bench = await startedBench();
    await runUntil(bench, "releasing");
    // The scheduler is busy for five minutes. Everybody is on the new behaviour, as the record wants.
    idleFor(bench, A_WHILE);
    await runFor(bench, 2);
    expect(recordOf(bench).outcome?.reason).toBe("completed");
    expect(recordOf(bench).phase).toBe("released");
    expect(bench.provider.serving(FLAG_KEY).allocation).toStrictEqual(EVERYBODY);
  });

  it("puts the release back when a stalled worker's old step lands over it, inside the settle window", async () => {
    expect.hasAssertions();
    const { bench, gate, stalled } = await stalledOnFirstStep();
    await runUntil(bench, "released");
    expect(recordOf(bench)).toMatchObject({ phase: "released", settled: false });
    await gate.finish("zombie");
    await stalled;
    expect(bench.provider.serving(FLAG_KEY)).toMatchObject({ allocation: measuredStep(FIRST_SHARE), by: "zombie" });
    await runFor(bench, A_WHILE);
    expect(recordOf(bench).outcome?.reason).toBe("completed");
    expect(bench.provider.serving(FLAG_KEY).allocation).toStrictEqual(EVERYBODY);
  });
});

/** README claim 4: "A person lowering the flag by hand pauses the rollout and is left alone". */
describe("claim 4: a person who turns a released flag down", () => {
  it("is left alone when they turn it down to nothing", async () => {
    expect.hasAssertions();
    const bench = await startedBench();
    await runUntil(bench, "released");
    bench.provider.setByHand(FLAG_KEY, measuredStep(0), "dana");
    await runFor(bench, A_WHILE);
    expect(treatmentShare(bench)).toBe(0);
  });

  it("is left alone when they turn it down to half, on a provider that would have refused a stalled write", async () => {
    expect.hasAssertions();
    const bench = await startedBench({ checksRevision: true });
    await runUntil(bench, "released");
    bench.provider.setByHand(FLAG_KEY, measuredStep(SECOND_SHARE), "dana");
    await runFor(bench, A_WHILE);
    expect(bench.provider.serving(FLAG_KEY)).toMatchObject({ allocation: measuredStep(SECOND_SHARE), by: "dana" });
    expect(eventTypes(bench)).not.toContain("rolling_back");
  });
});

describe("a release the provider won't take", () => {
  it("tells people it is releasing once, not once for every tick the write fails", async () => {
    expect.hasAssertions();
    const bench = await startedBench();
    await runFor(bench, STEP_AND_A_BIT * 2 - A_WHILE);
    bench.provider.faults.writesDown = true;
    await runFor(bench, AN_HOUR / 2);
    expect(bench.provider.serving(FLAG_KEY).allocation).toStrictEqual(measuredStep(SECOND_SHARE));
    expect(new Set(bench.notifier.calls.filter((event) => event.type === "releasing").map((event) => event.key)).size).toBeLessThanOrEqual(1);
  });
});
