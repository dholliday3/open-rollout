import { FIRST_SHARE, FLAG_KEY, MINUTE, ROLLOUT_ID, SECOND_SHARE, createBench, gatedWorker, idleFor, recordOf, runFor, startedBench } from "./bench";
import { describe, expect, it, vi } from "vitest";
import type { Bench } from "./bench";
import type { Gate } from "./gate";
import type { MetricSnapshot } from "../ports";
import { createGate } from "./gate";

vi.setConfig({ testTimeout: 10_000 });

/**
 * README, Lifecycle: a step moves on only when "the flag has been seen serving the step" and the metrics'
 * watermark "covers propagationMs + minDurationMs since then". Claim 2: no step-up without that evidence.
 *
 * `confirmedAt` is stamped with the `now` a tick was called with. A tick that was called, stalled, and only
 * then read the flag stamps the moment it was called, which can be minutes before the flag began to serve
 * the step. The chaotic runs found this three times in two thousand seeds (1399, 1796, 1809 of
 * `chaos.test.ts`, 3 to 44 seconds short); this is the same thing with the stall made long enough to see.
 */

const STEP_MINUTES = 10,
  PROPAGATION_MINUTES = 1,
  STALLED_FOR = 5,
  LONG_ENOUGH = 20,
  FOUR_MINUTES = 240_000,
  EVERYBODY_SHARE = 10_000,
  A_FEW = 3,
  /** How long the caching source keeps a snapshot, in milliseconds: from a minute and a half to four and a half. */
  CACHE_AGES = Object.values({ briefly: 90_000, longer: 150_000, longest: 270_000, mostOfFour: 210_000, fourMinutes: 240_000 });

/** When the flag really began to serve a share, from the provider's own list of changes. */
function beganServing(bench: Bench, share: number): number {
  return bench.provider.changes(FLAG_KEY).find((change) => change.allocation.treatment === share)?.at ?? Number.NaN;
}

/** The writer's call goes through, and the worker is gone before its next one. */
async function landThenDie(gate: Gate): Promise<void> {
  const write = gate.parked().find((call) => call.worker === "writer");
  if (write !== undefined) {
    await gate.pass(write);
  }
  gate.crash("writer");
}

/** The stalled reader finishes its tick while the metric source is this far behind; the source catches up straight after. */
async function finishWhileBehind(bench: Bench, gate: Gate, lagMs: number): Promise<void> {
  bench.lagMs = lagMs;
  await gate.finish("reader");
  bench.lagMs = 0;
}

/** A rollout whose first write failed a minute ago, so the next tick will send it again. */
async function owingItsFirstWrite(): Promise<Bench> {
  const bench = createBench();
  bench.provider.faults.writesDown = true;
  await bench.autopilot.start({ id: ROLLOUT_ID, now: bench.now, plan: bench.plan });
  bench.provider.faults.writesDown = false;
  idleFor(bench, 1);
  return bench;
}

/**
 * Two workers, both slow. The first saves its decision to write the first step and stalls inside the write.
 * The second is called at the same instant and stalls before it has read the flag. Five minutes later the
 * first one's write lands and that worker dies before it can note so; then the second one reads the flag,
 * sees the step in force, and saves that with the time it was called at.
 */
async function confirmedByAStalledTick(lagThenMs = 0): Promise<Bench> {
  const bench = await owingItsFirstWrite(),
    gate = createGate(),
    writing = gatedWorker(bench, gate, "writer").tick(ROLLOUT_ID, bench.now);
  await gate.runUntil("writer", "flags.write");
  const reading = gatedWorker(bench, gate, "reader").tick(ROLLOUT_ID, bench.now);
  await gate.runUntil("reader", "flags.read");
  idleFor(bench, STALLED_FOR);
  await landThenDie(gate);
  await finishWhileBehind(bench, gate, lagThenMs);
  await Promise.race([writing, reading]);
  return bench;
}

/** A source that answers from its cache while the cached snapshot is under four minutes old, and says honestly when it was taken. */
function cachedFor(ttlMs: number): (snapshot: MetricSnapshot) => MetricSnapshot {
  let kept: MetricSnapshot | null = null;
  return (fresh) => {
    kept = kept !== null && fresh.asOf - kept.asOf < ttlMs ? kept : fresh;
    return kept;
  };
}

/**
 * README, Lifecycle 2: the watch runs "from `asOf` of the first snapshot taken after the flag was seen
 * serving the step". The controller asks for that snapshot after it reads the flag, but a source with a
 * query cache answers with one it took earlier, and its honest `asOf` is then before the flag changed.
 */
describe("claim 2: a metric source that answers from a cache a few minutes old", () => {
  it.each(CACHE_AGES)("still watches the second step for its whole time (cache kept for %i ms)", async (ttlMs) => {
    expect.hasAssertions();
    const bench = await startedBench();
    bench.distort = cachedFor(ttlMs);
    await runFor(bench, LONG_ENOUGH * 2);
    expect(beganServing(bench, EVERYBODY_SHARE) - beganServing(bench, SECOND_SHARE)).toBeGreaterThanOrEqual((STEP_MINUTES + PROPAGATION_MINUTES) * MINUTE);
  });
});

/** Everything the source says about time, this far behind the truth: its clock is slow. */
function slowBy(ms: number): (snapshot: MetricSnapshot) => MetricSnapshot {
  return (snapshot) => ({ ...snapshot, asOf: snapshot.asOf - ms, watermark: snapshot.watermark - ms });
}

/**
 * The watch now runs on the metric source's clock alone. That clock can be wrong too: one node of the source
 * four minutes slow when the watch begins, a right one answering later. No worker clock is consulted any
 * more, so nothing notices that the step was only really served for seven of its eleven minutes.
 */
describe("claim 2: a metric source whose clock is put right during a step", () => {
  it("still watches the step for its whole time", async () => {
    expect.hasAssertions();
    const bench = await startedBench();
    bench.distort = slowBy(FOUR_MINUTES);
    await runFor(bench, A_FEW);
    bench.distort = (snapshot) => snapshot;
    await runFor(bench, LONG_ENOUGH);
    expect(beganServing(bench, SECOND_SHARE) - beganServing(bench, FIRST_SHARE)).toBeGreaterThanOrEqual((STEP_MINUTES + PROPAGATION_MINUTES) * MINUTE);
  });
});

describe("claim 2: a step is watched from when the flag really served it", () => {
  it("does not move on early when the metric source was four minutes behind as the stalled tick confirmed the step, and then caught up", async () => {
    expect.hasAssertions();
    // The watch starts at the watermark of the first snapshot after the step was seen in force. That watermark
    // Was four minutes before the flag changed; once the source catches up, those four minutes count as watched.
    const bench = await confirmedByAStalledTick(FOUR_MINUTES);
    await runFor(bench, LONG_ENOUGH);
    expect(beganServing(bench, SECOND_SHARE) - beganServing(bench, FIRST_SHARE)).toBeGreaterThanOrEqual((STEP_MINUTES + PROPAGATION_MINUTES) * MINUTE);
  });

  it("sets up a step that was confirmed by a tick called five minutes before the flag changed", async () => {
    expect.hasAssertions();
    const bench = await confirmedByAStalledTick();
    expect(bench.provider.serving(FLAG_KEY)).toMatchObject({ allocation: { treatment: FIRST_SHARE }, by: "writer" });
    expect(recordOf(bench)).toMatchObject({ confirmedEpoch: recordOf(bench).epoch, stepIndex: 0 });
  });

  it("does not move on until the step has really been served for its watch", async () => {
    expect.hasAssertions();
    const bench = await confirmedByAStalledTick();
    await runFor(bench, LONG_ENOUGH);
    expect(beganServing(bench, SECOND_SHARE) - beganServing(bench, FIRST_SHARE)).toBeGreaterThanOrEqual((STEP_MINUTES + PROPAGATION_MINUTES) * MINUTE);
  });
});
