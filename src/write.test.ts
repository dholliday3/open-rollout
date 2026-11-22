import { FIRST_SHARE, FLAG_KEY, SECOND_SHARE, START, createWorld, testPlan } from "./__tests__/world";
import { acknowledge, applyWrite } from "./write";
import { describe, expect, it, vi } from "vitest";
import type { Decision } from "./decide";
import type { World } from "./__tests__/world";
import { measuredStep } from "./allocation";
import { newRecord } from "./record";

vi.setConfig({ testTimeout: 5000 });

const DESCRIPTION_EDITS = 2,
  FAR_AHEAD = 40;

interface Sending {
  readonly world: World;
  readonly decision: Decision;
  readonly version: number;
}

/** A saved decision to move the flag from the first step to the second, read at the flag's current revision. */
async function sending(): Promise<Sending> {
  const world = createWorld(),
    record = newRecord("r1", testPlan(), START);
  world.flags.setByHand(FLAG_KEY, measuredStep(FIRST_SHARE));
  await world.store.create(record);
  const flag = world.flags.peek(FLAG_KEY);
  return { decision: { record, write: { allocation: measuredStep(SECOND_SHARE), expectedRevision: flag.revision, over: flag.allocation } }, version: 1, world };
}

describe("sending the write a tick decided", () => {
  it("returns the revision the write left the flag at", async () => {
    expect.hasAssertions();
    const { decision, version, world } = await sending(),
      revision = await applyWrite(world, decision, { problems: [], version });
    expect(world.flags.peek(FLAG_KEY)).toStrictEqual({ allocation: measuredStep(SECOND_SHARE), revision });
  });

  it("sends it once more when the flag's revision moved but its shares did not", async () => {
    expect.hasAssertions();
    const { decision, version, world } = await sending(),
      problems: string[] = [];
    world.flags.setByHand(FLAG_KEY, measuredStep(FIRST_SHARE));
    await expect(applyWrite(world, decision, { problems, version })).resolves.toBe(DESCRIPTION_EDITS + 1);
    expect(world.flags.peek(FLAG_KEY).allocation).toStrictEqual(measuredStep(SECOND_SHARE));
    expect(problems).toStrictEqual([]);
  });

});

describe("sending a write again after it failed", () => {
  it("does not send it again when the flag is two revisions on with the same shares: the write may have landed and been undone", async () => {
    expect.hasAssertions();
    const { decision, version, world } = await sending();
    world.flags.setByHand(FLAG_KEY, measuredStep(FIRST_SHARE));
    world.flags.setByHand(FLAG_KEY, measuredStep(FIRST_SHARE));
    await expect(applyWrite(world, decision, { problems: [], version })).resolves.toBeNull();
    expect(world.flags.peek(FLAG_KEY).allocation).toStrictEqual(measuredStep(FIRST_SHARE));
  });

  it("does not send it again over shares that someone changed, and says the write failed", async () => {
    expect.hasAssertions();
    const { decision, version, world } = await sending(),
      problems: string[] = [];
    world.flags.setByHand(FLAG_KEY, measuredStep(0));
    await expect(applyWrite(world, decision, { problems, version })).resolves.toBeNull();
    expect(world.flags.peek(FLAG_KEY).allocation).toStrictEqual(measuredStep(0));
    expect(problems).toStrictEqual(["Writing the flag failed: The flag changed since it was read."]);
  });

  it("stands down when the record has moved on since this worker saved it", async () => {
    expect.hasAssertions();
    const { decision, version, world } = await sending();
    await world.store.save(decision.record, version);
    await expect(applyWrite(world, decision, { problems: [], version })).resolves.toBeNull();
    expect(world.flags.peek(FLAG_KEY).allocation).toStrictEqual(measuredStep(FIRST_SHARE));
  });

  it("writes nothing when the decision owes nothing", async () => {
    expect.hasAssertions();
    const { decision, version, world } = await sending();
    await expect(applyWrite(world, { ...decision, write: null }, { problems: [], version })).resolves.toBeNull();
  });
});

describe("noting the revision a write left", () => {
  it("raises the highest revision seen, and never lowers it", async () => {
    expect.hasAssertions();
    const { decision, version, world } = await sending(),
      raised = await acknowledge(world, { record: decision.record, version }, DESCRIPTION_EDITS),
      ahead = await acknowledge(world, { record: { ...raised.record, seenRevision: FAR_AHEAD }, version: raised.version }, DESCRIPTION_EDITS);
    expect(raised).toMatchObject({ record: { seenRevision: DESCRIPTION_EDITS }, version: version + 1 });
    expect(ahead.record.seenRevision).toBe(FAR_AHEAD);
  });

  it("hands back what it was given when another worker saved first", async () => {
    expect.hasAssertions();
    const { decision, version, world } = await sending(),
      stale = { record: decision.record, version: version + 1 };
    await expect(acknowledge(world, stale, DESCRIPTION_EDITS)).resolves.toBe(stale);
  });
});
