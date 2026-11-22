import { EVERYBODY, NOBODY, measuredStep } from "./allocation";
import { FIRST_SHARE, MINUTE, SECOND_SHARE, START, testPlan } from "./__tests__/world";
import { describe, expect, it, vi } from "vitest";
import type { MetricSnapshot } from "./ports";
import type { RolloutRecord } from "./record";
import { decide } from "./decide";
import { newRecord } from "./record";
import { proceedTo } from "./transitions";

vi.setConfig({ testTimeout: 5000 });

const UNITS = 500,
  HEALTHY = 10,
  LATER = START + MINUTE,
  TWENTY = 20,
  MUCH_LATER = START + TWENTY * MINUTE,
  STALE_BY = 6,
  MORE = 3000,
  LESS = 100,
  /** The flag's revision when a write was sent, and one it has moved on to since. */
  SENT_AT = 9,
  MOVED_ON = 11,
  /** Longer than this reading below a revision already seen, and the flag has started over. */
  BEHIND_LIMIT = 300_000,
  FIRST_BEHIND = LATER + MINUTE,
  LAST_TWO = -2,
  /** How long a write that didn't go through is left before it is sent again. */
  RETRY_MS = 30_000;

/** A rollout that has just asked for its first step. */
function entering(): RolloutRecord {
  return proceedTo(newRecord("r1", testPlan(), START), 0, START);
}

function flag(share: number, revision = 1): { allocation: ReturnType<typeof measuredStep>; revision: number } {
  return { allocation: measuredStep(share), revision };
}

function healthy(watermark: number, units = UNITS): MetricSnapshot {
  const arm = { sum: Math.min(HEALTHY, units), units };
  return { asOf: watermark, contaminated: 0, exposed: { control: units, treatment: units }, metrics: { errors: { control: arm, treatment: arm } }, watermark };
}

/** The first step, seen in force at `LATER` by a metric source that is up and has counted nobody yet. */
function watching(): RolloutRecord {
  return decide(entering(), { flag: flag(FIRST_SHARE), metrics: healthy(LATER, 0), staleWritesRefused: true }, LATER).record;
}

/** The first step in force, with the flag since read at `revision`. */
function seenAt(revision: number): RolloutRecord {
  return decide(watching(), { flag: flag(FIRST_SHARE, revision), metrics: healthy(LATER, 0), staleWritesRefused: true }, LATER).record;
}

/** A tick at `now` that reads the flag off, at the revision a flag has when it is first made. */
function behindAt(now: number, record: RolloutRecord): ReturnType<typeof decide> {
  return decide(record, { flag: flag(0, 1), metrics: healthy(now, 0), staleWritesRefused: true }, now);
}

describe("deciding", () => {
  it("is pure: the same record and observation give the same decision, and the record is untouched", () => {
    expect.hasAssertions();
    const record = entering(),
      before = structuredClone(record),
      observation = { flag: flag(0), metrics: null, staleWritesRefused: true };
    expect(decide(record, observation, LATER)).toStrictEqual(decide(record, observation, LATER));
    expect(record).toStrictEqual(before);
  });

  it("owes the flag the first step until it is seen in force, carrying the revision it read", () => {
    expect.hasAssertions();
    expect(decide(entering(), { flag: flag(0, SENT_AT), metrics: healthy(LATER, 0), staleWritesRefused: true }, LATER).write).toStrictEqual({ allocation: measuredStep(FIRST_SHARE), expectedRevision: SENT_AT, over: NOBODY });
    expect(decide(entering(), { flag: flag(FIRST_SHARE), metrics: healthy(LATER, 0), staleWritesRefused: true }, LATER).write).toBeNull();
  });

  it("starts the step's watch only when the flag is seen serving it", () => {
    expect.hasAssertions();
    expect(decide(entering(), { flag: flag(0), metrics: null, staleWritesRefused: true }, LATER).record.confirmedAt).toBeNull();
    expect(watching()).toMatchObject({ confirmedAt: LATER, exposedSince: LATER, freshBaseline: { control: 0, treatment: 0, asOf: LATER } });
    expect(decide(entering(), { flag: flag(FIRST_SHARE), metrics: null, staleWritesRefused: true }, LATER).record).toMatchObject({ blindSince: LATER, freshBaseline: null });
  });

  it("writes nothing and decides nothing forward when the flag can't be read", () => {
    expect.hasAssertions();
    const decision = decide(entering(), { flag: null, metrics: null, staleWritesRefused: true }, LATER);
    expect(decision.write).toBeNull();
    expect(decision.record.confirmedAt).toBeNull();
  });

  it("returns the same record when nothing changed, so an idle tick saves nothing", () => {
    expect.hasAssertions();
    const record = watching();
    expect(decide(record, { flag: flag(FIRST_SHARE), metrics: healthy(LATER + MINUTE), staleWritesRefused: true }, LATER + MINUTE).record).toBe(record);
  });
});

describe("deciding when to write", () => {
  it("does not start a step while the metrics can't be read, and says a write was sent when it is", () => {
    expect.hasAssertions();
    expect(decide(entering(), { flag: flag(0), metrics: null, staleWritesRefused: true }, LATER).write).toBeNull();
    expect(decide(entering(), { flag: flag(0, SENT_AT), metrics: healthy(LATER, 0), staleWritesRefused: true }, LATER).record).toMatchObject({ attempt: { at: LATER, base: SENT_AT, epoch: 1 }, exposedSince: LATER });
  });

  it("gives a write it just sent time to land, unless the flag has changed since", () => {
    expect.hasAssertions();
    const observation = { flag: flag(0, SENT_AT), metrics: healthy(LATER, 0), staleWritesRefused: true },
      sent = decide(entering(), observation, LATER).record;
    expect(decide(sent, observation, LATER + 1).write).toBeNull();
    expect(decide(sent, observation, LATER + RETRY_MS - 1).write).toBeNull();
    expect(decide(sent, observation, LATER + RETRY_MS).write?.allocation).toStrictEqual(measuredStep(FIRST_SHARE));
  });

  it("sends the write again when the flag is still at the revision it had when the write was sent", () => {
    expect.hasAssertions();
    const observation = { flag: flag(0, SENT_AT), metrics: healthy(LATER, 0), staleWritesRefused: true },
      sent = decide(entering(), observation, LATER).record,
      again = decide(sent, observation, LATER + MINUTE);
    expect(again.record.pause).toBeNull();
    expect(again.write).toStrictEqual({ allocation: measuredStep(FIRST_SHARE), expectedRevision: SENT_AT, over: NOBODY });
  });

  it("pauses and writes nothing when the flag has moved on since the write was sent and still isn't the step", () => {
    expect.hasAssertions();
    const sent = decide(entering(), { flag: flag(0, SENT_AT), metrics: healthy(LATER, 0), staleWritesRefused: true }, LATER).record,
      pulled = decide(sent, { flag: flag(0, MOVED_ON), metrics: healthy(LATER, 0), staleWritesRefused: true }, LATER + 1),
      lowered = decide(sent, { flag: flag(LESS, MOVED_ON), metrics: healthy(LATER, 0), staleWritesRefused: true }, LATER + MINUTE);
    expect(pulled).toMatchObject({ record: { pause: { reason: "external_change" } }, write: null });
    expect(lowered.record.pause?.reason).toBe("external_change");
  });
});

describe("deciding on evidence", () => {
  it("does not move on while the metrics' watermark is behind the step's watch, whatever the wall clock says", () => {
    expect.hasAssertions();
    const record = watching(),
      onTime = MUCH_LATER - MINUTE,
      decision = decide(record, { flag: flag(FIRST_SHARE), metrics: healthy(LATER + MINUTE), staleWritesRefused: true }, LATER + 2 * MINUTE);
    expect(decision.record.stepIndex).toBe(0);
    expect(decide(record, { flag: flag(FIRST_SHARE), metrics: healthy(onTime), staleWritesRefused: true }, onTime).record.stepIndex).toBe(1);
  });
});

describe("deciding on clocks and counts that disagree", () => {
  it("does not use a snapshot whose watermark is after the time it was taken", () => {
    expect.hasAssertions();
    const soon = LATER + 2 * MINUTE,
      impossible = { ...healthy(MUCH_LATER), asOf: soon };
    expect(decide(watching(), { flag: flag(FIRST_SHARE), metrics: impossible, staleWritesRefused: true }, soon).record).toMatchObject({ blindSince: soon, stepIndex: 0 });
  });

  it("does not start counting a step's new units from a snapshot that shows fewer than the last step ended with", () => {
    expect.hasAssertions();
    const second: RolloutRecord = { ...watching(), freshBaseline: null, unitsFloor: { control: UNITS, treatment: UNITS } },
      emptied = decide(second, { flag: flag(FIRST_SHARE), metrics: healthy(LATER + MINUTE, 0), staleWritesRefused: true }, LATER + MINUTE).record;
    expect(emptied.freshBaseline).toBeNull();
    expect(decide(emptied, { flag: flag(FIRST_SHARE), metrics: healthy(LATER + MINUTE), staleWritesRefused: true }, LATER + MINUTE).record.freshBaseline).toStrictEqual({ asOf: LATER + MINUTE, control: UNITS, treatment: UNITS });
  });
});

describe("deciding from readings that are behind", () => {
  it("starts a step's watch at the source's own time, so neither a worker's clock nor the source's lag can shorten it", () => {
    expect.hasAssertions();
    const behind = { ...healthy(LATER - STALE_BY * MINUTE + MINUTE, 0), asOf: LATER + MINUTE },
      started = decide(entering(), { flag: flag(FIRST_SHARE), metrics: behind, staleWritesRefused: true }, LATER).record,
      caughtUp = { ...healthy(LATER + MINUTE + TWENTY * MINUTE / 2), asOf: MUCH_LATER };
    expect(started.freshBaseline).toStrictEqual({ asOf: LATER + MINUTE, control: 0, treatment: 0 });
    expect(decide(started, { flag: flag(FIRST_SHARE), metrics: caughtUp, staleWritesRefused: true }, MUCH_LATER - MINUTE).record.stepIndex).toBe(0);
  });

  it("takes a reading below a revision it has already seen as no reading", () => {
    expect.hasAssertions();
    const metrics = healthy(LATER, 0),
      newer = decide(watching(), { flag: flag(FIRST_SHARE, 2), metrics, staleWritesRefused: true }, LATER).record,
      behind = decide(newer, { flag: flag(0, 1), metrics, staleWritesRefused: true }, LATER + MINUTE);
    expect(newer.seenRevision).toBe(2);
    expect(behind).toMatchObject({ record: { pause: null, seenRevision: 2 }, write: null });
  });

});

describe("deciding about a flag whose revision came back down", () => {
  it("notes when the flag first read behind, and forgets it once the flag reads level again", () => {
    expect.hasAssertions();
    const first = behindAt(FIRST_BEHIND, seenAt(MOVED_ON)).record,
      level = decide(first, { flag: flag(FIRST_SHARE, MOVED_ON), metrics: healthy(FIRST_BEHIND, 0), staleWritesRefused: true }, FIRST_BEHIND).record;
    expect(first).toMatchObject({ behindSince: FIRST_BEHIND, seenRevision: MOVED_ON });
    expect(behindAt(FIRST_BEHIND + MINUTE, first).record).toBe(first);
    expect(level).toMatchObject({ behindSince: null, seenRevision: MOVED_ON });
  });

  it("takes a flag that has read behind for longer than a replica could be as started over, and what it serves as someone else's doing", () => {
    expect.hasAssertions();
    const first = behindAt(FIRST_BEHIND, seenAt(MOVED_ON)).record,
      past = behindAt(FIRST_BEHIND + BEHIND_LIMIT + 1, first);
    expect(behindAt(FIRST_BEHIND + BEHIND_LIMIT, first)).toMatchObject({ record: { pause: null, seenRevision: MOVED_ON }, write: null });
    expect(past).toMatchObject({ record: { behindSince: null, pause: { reason: "external_change" }, seenRevision: 1 }, write: null });
    expect(past.record.outbox.slice(LAST_TWO).map((event) => event.type)).toStrictEqual(["external_change", "paused"]);
  });

  it("does not send a write again over a flag that has started over, though the old numbers say it never landed", () => {
    expect.hasAssertions();
    const sent = decide(entering(), { flag: flag(0, SENT_AT), metrics: healthy(LATER, 0), staleWritesRefused: true }, LATER).record,
      past = behindAt(FIRST_BEHIND + BEHIND_LIMIT + 1, behindAt(FIRST_BEHIND, sent).record);
    expect(sent.attempt).toStrictEqual({ at: LATER, base: SENT_AT, epoch: 1, over: NOBODY });
    expect(past).toMatchObject({ record: { attempt: { base: 0, over: null }, pause: { reason: "external_change" } }, write: null });
  });

});

describe("deciding from metrics that are late or thin", () => {
  it("judges freshness on the worker's own clock, so one worker's fast clock doesn't blind the next", () => {
    expect.hasAssertions();
    const ahead: RolloutRecord = { ...watching(), clock: MUCH_LATER };
    expect(decide(ahead, { flag: flag(FIRST_SHARE), metrics: healthy(LATER + MINUTE), staleWritesRefused: true }, LATER + MINUTE).record.blindSince).toBeNull();
  });

  it("treats metrics older than the staleness limit as no metrics", () => {
    expect.hasAssertions();
    const now = MUCH_LATER - MINUTE,
      decision = decide(watching(), { flag: flag(FIRST_SHARE), metrics: healthy(now - STALE_BY * MINUTE), staleWritesRefused: true }, now);
    expect(decision.record).toMatchObject({ blindSince: now, stepIndex: 0 });
  });

  it("does not move on with fewer new units than the step asks for", () => {
    expect.hasAssertions();
    const now = MUCH_LATER - MINUTE;
    expect(decide(watching(), { flag: flag(FIRST_SHARE), metrics: healthy(now, HEALTHY), staleWritesRefused: true }, now).record.stepIndex).toBe(0);
  });

  it("does not move on in the same tick that finds the flag drifted", () => {
    expect.hasAssertions();
    const now = MUCH_LATER - MINUTE,
      decision = decide(watching(), { flag: flag(MORE), metrics: healthy(now), staleWritesRefused: true }, now);
    expect(decision.record).toMatchObject({ correctingDrift: true, stepIndex: 0 });
    expect(decision.write?.allocation).toStrictEqual(measuredStep(FIRST_SHARE));
  });
});

describe("deciding after someone else's change was put right", () => {
  it("starts the step's watch again, because the step was not being served in between", () => {
    expect.hasAssertions();
    const later = LATER + STALE_BY * MINUTE,
      raised = decide(watching(), { flag: flag(MORE, 2), metrics: healthy(LATER + MINUTE), staleWritesRefused: true }, LATER + MINUTE).record,
      back = decide(raised, { flag: flag(FIRST_SHARE, MOVED_ON), metrics: healthy(later), staleWritesRefused: true }, later).record;
    expect(raised.correctingDrift).toBe(true);
    expect(back).toMatchObject({ confirmedAt: later, correctingDrift: false, freshBaseline: { asOf: later } });
  });
});

describe("the one write a tick owes", () => {
  it("turns the flag off blind during a rollback when it can't be read", () => {
    expect.hasAssertions();
    const undoing: RolloutRecord = { ...watching(), desired: NOBODY, epoch: 2, phase: "rolling_back" };
    expect(decide(undoing, { flag: null, metrics: null, staleWritesRefused: true }, LATER).write).toStrictEqual({ allocation: NOBODY, expectedRevision: undefined, over: null });
  });

  it("never raises exposure while paused, but still brings it down", () => {
    expect.hasAssertions();
    const paused: RolloutRecord = { ...watching(), pause: { detail: "", reason: "manual", since: LATER }, phase: "paused" };
    expect(decide({ ...paused, confirmedEpoch: 0 }, { flag: flag(LESS), metrics: null, staleWritesRefused: true }, LATER).write).toBeNull();
    expect(decide(paused, { flag: flag(MORE), metrics: null, staleWritesRefused: true }, LATER).write?.allocation).toStrictEqual(measuredStep(FIRST_SHARE));
  });

  it("does not take a paused rollout's earlier step for a late write to put right, where a late write can land", () => {
    expect.hasAssertions();
    const paused: RolloutRecord = { ...watching(), confirmedEpoch: 2, desired: measuredStep(SECOND_SHARE), epoch: 2, pause: { detail: "", reason: "manual", since: LATER }, phase: "paused", stepIndex: 1 };
    expect(decide(paused, { flag: flag(FIRST_SHARE), metrics: healthy(LATER), staleWritesRefused: false }, LATER).write).toBeNull();
  });

  it("writes the release again over a late step write, but only where a late write can land", () => {
    expect.hasAssertions();
    const released: RolloutRecord = { ...watching(), desired: EVERYBODY, phase: "released" },
      lateWrite = { flag: flag(FIRST_SHARE), metrics: null };
    expect(decide(released, { ...lateWrite, staleWritesRefused: false }, LATER).write?.allocation).toStrictEqual(EVERYBODY);
    expect(decide(released, { ...lateWrite, staleWritesRefused: false }, LATER).record.outbox.at(-1)?.type).toBe("drift_corrected");
    expect(decide(released, { ...lateWrite, staleWritesRefused: true }, LATER).write).toBeNull();
    expect(decide(released, { ...lateWrite, staleWritesRefused: true }, LATER).record.outbox.at(-1)?.type).toBe("external_change");
  });

  it("leaves a released flag to its owners, and a settled rollout alone", () => {
    expect.hasAssertions();
    const released: RolloutRecord = { ...watching(), desired: EVERYBODY, phase: "released" };
    expect(decide(released, { flag: flag(LESS), metrics: null, staleWritesRefused: true }, LATER).write).toBeNull();
    expect(decide(released, { flag: flag(LESS), metrics: healthy(LATER), staleWritesRefused: true }, LATER).write).toBeNull();
    expect(decide({ ...released, settled: true }, { flag: flag(LESS), metrics: null, staleWritesRefused: true }, MUCH_LATER)).toStrictEqual({ record: { ...released, settled: true }, write: null });
  });

  it("never reads a time earlier than the record's own clock", () => {
    expect.hasAssertions();
    const record = watching();
    expect(decide(record, { flag: flag(FIRST_SHARE), metrics: null, staleWritesRefused: true }, START - MUCH_LATER).record.clock).toBe(record.clock);
  });
});
