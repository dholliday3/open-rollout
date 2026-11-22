import { ROLLOUT_ID, createBench, recordOf, runFor, send, startedBench, treatmentShare } from "./bench.js";
import { describe, expect, it, vi } from "vitest";
import type { RolloutRecord } from "../record.js";
import type { RolloutStore } from "../ports.js";
import { createAutopilot } from "../controller.js";

vi.setConfig({ testTimeout: 10_000 });

const LONG_ENOUGH_TO_SETTLE = 15;

/**
 * Sorts an object's keys the way Postgres `jsonb` stores them (shorter first, then by letter), all the way down,
 * and drops the keys set to undefined, which never reach the database as JSON.
 */
function asJsonbKeeps(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item: unknown) => asJsonbKeeps(item));
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const entries = Object.entries(value)
    .filter(([, inner]) => inner !== undefined)
    .map(([key, inner]): [string, unknown] => [key, asJsonbKeeps(inner)]);
  entries.sort(([left], [right]) => left.length - right.length || left.localeCompare(right));
  return Object.fromEntries(entries);
}

/** A store that hands records back as a `jsonb` column would: the same record, its keys in the database's order. */
function jsonbStore(store: RolloutStore): RolloutStore {
  return {
    ...store,
    load: async (id) => {
      const stored = await store.load(id);
      // eslint-disable-next-line typescript/no-unsafe-type-assertion -- the same record with its keys reordered is still a record
      return stored === null ? null : { record: asJsonbKeeps(stored.record) as RolloutRecord, version: stored.version };
    },
  };
}

/**
 * README, on `start`: a start sent again with the same plan (a retried step) "finds its own rollout and says
 * so". The plans are compared as JSON text, which depends on the order of their keys, and a record that has
 * been through a `jsonb` column comes back with its keys in another order.
 */
describe("a replayed start, against a store that keeps records as jsonb", () => {
  it("finds its own rollout", async () => {
    expect.hasAssertions();
    const bench = createBench(),
      autopilot = createAutopilot({ flags: bench.flags, metrics: bench.metrics, notifier: bench.notifier, store: jsonbStore(bench.store) }),
      request = { id: ROLLOUT_ID, now: bench.now, plan: bench.plan };
    await expect(autopilot.start(request)).resolves.toMatchObject({ status: "started" });
    await expect(autopilot.start(request)).resolves.toMatchObject({ problems: [], status: "started" });
  });

  it("finds its own rollout when the plan set an optional field to undefined, which JSON doesn't keep", async () => {
    expect.hasAssertions();
    const bench = createBench(),
      autopilot = createAutopilot({ flags: bench.flags, metrics: bench.metrics, notifier: bench.notifier, store: jsonbStore(bench.store) }),
      unset: Record<string, undefined> = { mustRuleOut: undefined },
      plan = { ...bench.plan, guardrails: bench.plan.guardrails.map((guardrail) => ({ ...guardrail, ...unset })) },
      request = { id: ROLLOUT_ID, now: bench.now, plan };
    await expect(autopilot.start(request)).resolves.toMatchObject({ status: "started" });
    await expect(autopilot.start(request)).resolves.toMatchObject({ problems: [], status: "started" });
  });
});

/**
 * The same idempotence, a week later. A rollout was rolled back and has settled. Someone fixes the bug and
 * starts it again under the same id with the same plan, which is what an agent asked to "try that rollout
 * again" will send. The answer is "started" (the tools say "The rollout has started."), and nothing starts:
 * the record it found is finished for good.
 */
describe("a start under the id of a rollout that is over", () => {
  it("is not answered as started", async () => {
    expect.hasAssertions();
    const bench = await startedBench();
    await send(bench, { by: "dana", id: "undo", type: "rollback" });
    await runFor(bench, LONG_ENOUGH_TO_SETTLE);
    expect(recordOf(bench)).toMatchObject({ phase: "rolled_back", settled: true });
    const again = await bench.autopilot.start({ id: ROLLOUT_ID, now: bench.now, plan: bench.plan });
    expect({ settled: again.record?.settled, status: again.status }).not.toStrictEqual({ settled: true, status: "started" });
  });
});

/**
 * README claim 5: "A command is answered the way it was the first time, however often and however much
 * later it is sent again." Only the id is remembered, not what the command was. A rollback that arrives
 * under an id a pause once used is answered "already done" (the tools tell the agent `ok: true`), and the
 * flag stays on.
 */
describe("claim 5: one id, two different commands", () => {
  it("does not answer a rollback as done because a pause once had its id", async () => {
    expect.hasAssertions();
    const bench = await startedBench();
    await expect(send(bench, { by: "agent", id: "call-7", type: "pause" })).resolves.toBe("applied");
    await expect(send(bench, { by: "agent", id: "call-7", type: "rollback" })).resolves.not.toBe("duplicate");
    expect(recordOf(bench).phase).not.toBe("paused");
    expect(treatmentShare(bench)).toBe(0);
  });
});
