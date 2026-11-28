import { EVERYBODY, FULL_SHARE, NOBODY, measuredStep, sameAllocation } from "../allocation.js";
import type { FlagControl, FlagReading } from "../ports.js";
import type { PostHogCall, PostHogTransport } from "./posthog-transport.js";
import type { Allocation } from "../allocation.js";
import { bodyOf } from "./posthog-transport.js";
import { z } from "zod";

/**
 * A rollout's flag in PostHog is a multivariate flag kept for the rollout alone: two variants, `control`
 * and `treatment`, split 50/50, and one release condition with no filters whose rollout percentage is the
 * share of everybody who gets either. PostHog hashes "is this person in" and "which variant" separately,
 * so raising the percentage keeps everyone who was in and never moves anyone between variants.
 *
 * Every write goes through PostHog's own version-checked calls, so a late write from a stalled worker is
 * refused by PostHog itself (409) and not just put right afterwards.
 */
interface PostHogFlagsOptions {
  readonly projectId: number | string;
  readonly transport: PostHogTransport;
  /** The variant keys the app's code checks for. */
  readonly variants?: { readonly control: string; readonly treatment: string };
}

const anything = z.unknown(),
  conditionSchema = z.object({ properties: z.array(anything).nullish(), rollout_percentage: z.number().nullish(), variant: z.string().nullish() }),
  variantSchema = z.object({ key: z.string(), rollout_percentage: z.number() }),
  variantsSchema = z.object({ variants: z.array(variantSchema) }),
  filtersSchema = z.object({ groups: z.array(conditionSchema).default([]), multivariate: variantsSchema.nullish() }),
  flagSchema = z.object({ active: z.boolean(), filters: filtersSchema, id: z.number(), key: z.string(), version: z.number().nullish() }),
  listSchema = z.object({ results: z.array(flagSchema) }),
  DEFAULT_VARIANTS = { control: "control", treatment: "treatment" },
  PERCENT = 100,
  EVEN_SPLIT = 50;

type PostHogFlag = z.infer<typeof flagSchema>;

interface Setup {
  readonly options: PostHogFlagsOptions;
  readonly ids: Map<string, number>;
}

/** One version-checked change to a flag, without the version, which is filled in as each call returns the next. */
interface Change {
  readonly action: "set_release_condition_rollout" | "roll_out_to_everyone";
  readonly body: Record<string, number | string>;
}

function variantShare(flag: PostHogFlag, key: string): number {
  return flag.filters.multivariate?.variants.find((variant) => variant.key === key)?.rollout_percentage ?? 0;
}

/** The share of everybody that gets any variant: PostHog serves a person who is inside any condition. */
function servedPercent(flag: PostHogFlag): number {
  // A condition with filters serves some people whatever the percentage says, and one with a variant override serves them one arm.
  if (flag.filters.groups.some((group) => (group.properties ?? []).length > 0 || (group.variant ?? null) !== null)) {
    throw new Error(`The flag ${flag.key} has a release condition with filters or a variant override. A rollout's flag targets everybody by percentage only.`);
  }
  // PostHog reads a missing percentage as 100.
  return Math.max(0, ...flag.filters.groups.map((group) => group.rollout_percentage ?? PERCENT));
}

/** What a flag definition serves, as an allocation. A disabled flag serves nobody. */
function allocationOf(flag: PostHogFlag, variants = DEFAULT_VARIANTS): Allocation {
  if (!flag.active) {
    return NOBODY;
  }
  const served = servedPercent(flag);
  return { control: Math.round(served * variantShare(flag, variants.control)), treatment: Math.round(served * variantShare(flag, variants.treatment)) };
}

function stepProblem(flag: PostHogFlag, allocation: Allocation, variants = DEFAULT_VARIANTS): string | null {
  if (allocation.control !== allocation.treatment) {
    return "A PostHog rollout step needs equal control and treatment shares.";
  }
  if (!flag.active) {
    return `The flag ${flag.key} is disabled in PostHog. Enable it before rolling out.`;
  }
  if (flag.filters.groups.length !== 1 || variantShare(flag, variants.control) !== EVEN_SPLIT || variantShare(flag, variants.treatment) !== EVEN_SPLIT) {
    // A release to everybody adds a condition and rewrites the split to 0/100, so a released flag needs setting up again.
    return `The flag ${flag.key} must have one release condition and a 50/50 split between ${variants.control} and ${variants.treatment}. A flag that was released to everybody before has neither until they are put back.`;
  }
  return null;
}

/** The changes that take a flag from what it serves to an allocation, or an error when the flag isn't set up for it. */
function changesFor(flag: PostHogFlag, allocation: Allocation, variants = DEFAULT_VARIANTS): Change[] {
  if (sameAllocation(allocation, EVERYBODY)) {
    return [{ action: "roll_out_to_everyone", body: { variant_key: variants.treatment } }];
  }
  const target = ((allocation.control + allocation.treatment) * PERCENT) / FULL_SHARE,
    problem = target === 0 ? null : stepProblem(flag, allocation, variants);
  if (problem !== null) {
    throw new Error(problem);
  }
  // Serving nobody turns every condition down, including the one a release that half-landed left behind.
  return flag.filters.groups.flatMap((group, index): Change[] => ((group.rollout_percentage ?? PERCENT) === target ? [] : [{ action: "set_release_condition_rollout", body: { condition_index: index, rollout_percentage: target } }]));
}

async function send(setup: Setup, call: PostHogCall): Promise<unknown> {
  const reply = await setup.options.transport(call);
  return bodyOf(reply, call);
}

async function flagId(setup: Setup, flagKey: string): Promise<number> {
  const known = setup.ids.get(flagKey);
  if (known !== undefined) {
    return known;
  }
  const found = listSchema.parse(await send(setup, { method: "GET", path: `/api/projects/${setup.options.projectId}/feature_flags/?search=${encodeURIComponent(flagKey)}` })).results.find((flag) => flag.key === flagKey);
  if (found === undefined) {
    throw new Error(`PostHog has no flag with the key ${flagKey}.`);
  }
  setup.ids.set(flagKey, found.id);
  return found.id;
}

async function fetchFlag(setup: Setup, flagKey: string): Promise<PostHogFlag> {
  const id = await flagId(setup, flagKey);
  return flagSchema.parse(await send(setup, { method: "GET", path: `/api/projects/${setup.options.projectId}/feature_flags/${id}/` }));
}

/** Makes the changes one after another, each carrying the version the one before returned, and returns the version the last one left. */
async function apply(setup: Setup, flag: { id: number; version: number }, changes: readonly Change[]): Promise<number> {
  const change = changes.at(0);
  if (change === undefined) {
    return flag.version;
  }
  const path = `/api/projects/${setup.options.projectId}/feature_flags/${flag.id}/${change.action}/`,
    after = flagSchema.parse(await send(setup, { body: { ...change.body, version: flag.version }, method: "POST", path })),
    last = await apply(setup, { id: flag.id, version: after.version ?? 0 }, changes.slice(1));
  return last;
}

/** A `FlagControl` over PostHog feature flags. */
function createPostHogFlags(options: PostHogFlagsOptions): FlagControl {
  const setup: Setup = { ids: new Map<string, number>(), options };
  return {
    read: async (flagKey): Promise<FlagReading> => {
      const flag = await fetchFlag(setup, flagKey);
      // PostHog's version goes up by one on every saved edit; a flag from before versioning reads as 0.
      return { allocation: allocationOf(flag, options.variants), revision: flag.version ?? 0 };
    },
    // Both calls the adapter makes carry the flag's version, and PostHog answers 409 to a stale one.
    refusesStaleWrites: true,
    setupProblem: async (flagKey) => {
      const flag = await fetchFlag(setup, flagKey);
      return stepProblem(flag, measuredStep(1), options.variants);
    },
    write: async (flagKey, allocation, expectedRevision) => {
      const flag = await fetchFlag(setup, flagKey),
        version = expectedRevision ?? flag.version ?? 0,
        after = await apply(setup, { id: flag.id, version }, changesFor(flag, allocation, options.variants));
      return after;
    },
  };
}

export type { Change, PostHogFlag, PostHogFlagsOptions };
export { allocationOf, changesFor, createPostHogFlags };
