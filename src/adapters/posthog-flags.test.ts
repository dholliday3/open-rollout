import { EVERYBODY, NOBODY, measuredStep } from "../allocation.js";
import type { PostHogCall, PostHogReply } from "./posthog-transport.js";
import { allocationOf, changesFor, createPostHogFlags } from "./posthog-flags.js";
import { describe, expect, it, vi } from "vitest";
import type { PostHogFlag } from "./posthog-flags.js";
import { z } from "zod";

vi.setConfig({ testTimeout: 5000 });

const FLAG_ID = 7,
  VERSION = 4,
  TEN_PERCENT = 1000,
  TWENTY = 20,
  HALF = 50,
  ALL = 100,
  OK = 200,
  CONFLICT = 409,
  changeSchema = z.object({ condition_index: z.number().optional(), rollout_percentage: z.number().optional(), version: z.number() });

function flag(overrides: { active?: boolean; rollouts?: (number | null)[]; split?: [number, number]; filtered?: boolean } = {}): PostHogFlag {
  const [control, treatment] = overrides.split ?? [HALF, HALF];
  return {
    active: overrides.active ?? true,
    filters: {
      groups: (overrides.rollouts ?? [0]).map((rollout) => ({ properties: overrides.filtered === true ? [{ key: "email" }] : [], rollout_percentage: rollout })),
      multivariate: { variants: [{ key: "control", rollout_percentage: control }, { key: "treatment", rollout_percentage: treatment }] },
    },
    id: FLAG_ID,
    key: "new-checkout",
    version: VERSION,
  };
}

/** A PostHog that holds one flag and applies the two version-checked calls the adapter makes. */
function fakePostHog(initial: PostHogFlag): { calls: PostHogCall[]; transport: (call: PostHogCall) => Promise<PostHogReply> } {
  let current = initial;
  const calls: PostHogCall[] = [],
    change = (call: PostHogCall): PostHogReply => {
      const body = changeSchema.parse(call.body);
      if (body.version !== current.version) {
        return { body: {}, status: CONFLICT };
      }
      const groups = call.path.includes("roll_out_to_everyone") ? [{ properties: [], rollout_percentage: ALL }, ...current.filters.groups] : current.filters.groups.map((group, index) => (index === body.condition_index ? { ...group, rollout_percentage: body.rollout_percentage } : group)),
        variants = call.path.includes("roll_out_to_everyone") ? flag({ split: [0, ALL] }).filters.multivariate : current.filters.multivariate;
      current = { ...current, filters: { groups, multivariate: variants }, version: (current.version ?? 0) + 1 };
      return { body: current, status: OK };
    };
  return {
    calls,
    transport: async (call) => {
      await Promise.resolve();
      calls.push(call);
      if (call.method === "POST") {
        return change(call);
      }
      return { body: call.path.includes("?search=") ? { results: [current] } : current, status: OK };
    },
  };
}

describe("reading a PostHog flag as an allocation", () => {
  it("reads a 20% rollout split evenly as 10% on each arm", () => {
    expect.hasAssertions();
    expect(allocationOf(flag({ rollouts: [TWENTY] }))).toStrictEqual(measuredStep(TEN_PERCENT));
  });

  it("reads a disabled flag, and one at 0%, as nobody", () => {
    expect.hasAssertions();
    expect(allocationOf(flag({ active: false, rollouts: [TWENTY] }))).toStrictEqual(NOBODY);
    expect(allocationOf(flag())).toStrictEqual(NOBODY);
  });

  it("reads a flag rolled out to the treatment variant as everybody", () => {
    expect.hasAssertions();
    expect(allocationOf(flag({ rollouts: [null, TWENTY], split: [0, ALL] }))).toStrictEqual(EVERYBODY);
  });

  it("refuses a flag that targets people by a filter, or sends a condition's people to one variant", () => {
    expect.hasAssertions();
    const overridden = flag({ rollouts: [TWENTY] });
    expect(() => allocationOf(flag({ filtered: true }))).toThrow("release condition with filters");
    expect(() => allocationOf({ ...overridden, filters: { ...overridden.filters, groups: [{ properties: [], rollout_percentage: TWENTY, variant: "treatment" }] } })).toThrow("variant override");
  });
});

describe("the changes that set a PostHog flag", () => {
  it("moves a step by the one release condition's percentage", () => {
    expect.hasAssertions();
    expect(changesFor(flag(), measuredStep(TEN_PERCENT))).toStrictEqual([{ action: "set_release_condition_rollout", body: { condition_index: 0, rollout_percentage: TWENTY } }]);
  });

  it("releases through PostHog's roll-out-to-everyone, naming the treatment variant", () => {
    expect.hasAssertions();
    expect(changesFor(flag({ rollouts: [ALL] }), EVERYBODY)).toStrictEqual([{ action: "roll_out_to_everyone", body: { variant_key: "treatment" } }]);
  });

  it("turns every condition down to serve nobody, even after a release half-landed", () => {
    expect.hasAssertions();
    expect(changesFor(flag({ rollouts: [ALL, TWENTY], split: [0, ALL] }), NOBODY)).toHaveLength(2);
  });

  it("changes nothing when the flag already serves the step", () => {
    expect.hasAssertions();
    expect(changesFor(flag({ rollouts: [TWENTY] }), measuredStep(TEN_PERCENT))).toStrictEqual([]);
  });

  it("refuses a step on a flag that is disabled or not split evenly", () => {
    expect.hasAssertions();
    expect(() => changesFor(flag({ active: false }), measuredStep(TEN_PERCENT))).toThrow("disabled");
    expect(() => changesFor(flag({ split: [TWENTY, ALL - TWENTY] }), measuredStep(TEN_PERCENT))).toThrow("50/50");
  });
});

describe("the PostHog flag adapter", () => {
  it("writes a step with the version it read, and reads it back", async () => {
    expect.hasAssertions();
    const posthog = fakePostHog(flag()),
      flags = createPostHogFlags({ projectId: 1, transport: posthog.transport }),
      before = await flags.read("new-checkout");
    await expect(flags.write("new-checkout", measuredStep(TEN_PERCENT), before.revision)).resolves.toBe(VERSION + 1);
    await expect(flags.read("new-checkout")).resolves.toStrictEqual({ allocation: measuredStep(TEN_PERCENT), revision: VERSION + 1 });
  });

  it("is refused by PostHog when the flag changed since the revision it was given", async () => {
    expect.hasAssertions();
    const posthog = fakePostHog(flag()),
      flags = createPostHogFlags({ projectId: 1, transport: posthog.transport });
    await expect(flags.write("new-checkout", measuredStep(TEN_PERCENT), VERSION - 1)).rejects.toThrow("changed since it was read");
    await expect(flags.read("new-checkout")).resolves.toMatchObject({ allocation: NOBODY });
  });

  it("serves nobody in two steps after a release, each carrying the version before it", async () => {
    expect.hasAssertions();
    const posthog = fakePostHog(flag({ rollouts: [TWENTY] })),
      flags = createPostHogFlags({ projectId: 1, transport: posthog.transport });
    await flags.write("new-checkout", EVERYBODY);
    await expect(flags.read("new-checkout")).resolves.toMatchObject({ allocation: EVERYBODY });
    await flags.write("new-checkout", NOBODY);
    await expect(flags.read("new-checkout")).resolves.toMatchObject({ allocation: NOBODY });
  });
});
