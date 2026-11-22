import type { Autopilot, CommandOutcome } from "./controller";
import type { Command } from "./commands";
import type { RolloutSummary } from "./summary";
import { standardPlan } from "./plan";
import { summarize } from "./summary";
import { z } from "zod";

/**
 * The rollout tools an agent gets, with no runtime in them. Each is a description, a zod input schema and
 * a `run`; a durable runtime's tool definition, an AI SDK `tool` or an MCP server wraps one in a few lines.
 *
 * A durable runtime may run one tool call twice (a step retried after a crash). `callKey` is the same on
 * both runs, so the command it carries is applied once.
 */
interface ToolCall {
  /** The runtime's clock, read inside the step that runs the tool. */
  readonly now: number;
  /** Who the agent is acting for. Recorded on every command. */
  readonly actor: string;
  /** Unique to this tool call and the same when the call is retried, such as `${sessionId}:${callId}`. */
  readonly callKey: string;
}

interface ToolAnswer {
  readonly ok: boolean;
  /** One sentence for the agent to pass on. */
  readonly message: string;
  readonly rollout: RolloutSummary | null;
}

/** One tool: what the model reads, what it must send, and what happens. */
interface RolloutTool<Input> {
  readonly description: string;
  readonly inputSchema: z.ZodType<Input>;
  readonly run: (input: Input, call: ToolCall) => Promise<ToolAnswer>;
}

const idShape = z.string().min(1).describe("The rollout's id."),
  noteShape = z.string().optional().describe("Why, in a sentence. It goes on the record."),
  guardrailShape = z.object({
    metric: z.string().min(1).describe("The metric's name, as the metric source knows it."),
    kind: z.enum(["rate", "mean", "ratio"]).describe("rate: share of people with the event. mean: average per person. ratio: one total over another, such as errors per request."),
    direction: z.enum(["lower_is_better", "higher_is_better"]),
    tolerance: z.number().min(0).default(0).describe("How much worse is still fine, in the metric's own units."),
    onRegression: z.enum(["rollback", "pause"]).default("rollback"),
    mustRuleOut: z.number().positive().optional().describe("How large a regression must be ruled out before a step may pass, in the metric's own units. Leave out to pass a step when nothing was detected."),
  }),
  startShape = z.object({
    id: idShape,
    flagKey: z.string().min(1).describe("The feature flag to roll out."),
    risk: z.enum(["low", "medium", "high"]).describe("How much could go wrong. Higher risk means smaller first steps, longer watches, and approval before the release."),
    guardrails: z.array(guardrailShape).describe("The metrics the rollout must not make worse. With none, it is a timed ramp with no automatic rollback."),
  }),
  targetShape = z.object({ id: idShape }),
  notedShape = z.object({ id: idShape, note: noteShape }),
  approveShape = z.object({ id: idShape, gate: z.union([z.literal("release"), z.number().int().min(0)]).describe("What to approve: a step's index, counting from 0, or \"release\" for the release to everybody.") }),
  REFUSALS: Record<CommandOutcome["status"], string> = {
    applied: "Done.",
    busy: "The rollout was busy. Try again.",
    duplicate: "That was already done.",
    not_found: "There is no rollout with that id.",
    refused: "That can't be done right now.",
  };

async function answer(autopilot: Autopilot, id: string, said: { ok: boolean; message: string }): Promise<ToolAnswer> {
  const inspection = await autopilot.inspect(id);
  return { ...said, rollout: inspection === null ? null : summarize(inspection) };
}

async function tell(autopilot: Autopilot, id: string, issued: { command: Command; now: number }): Promise<ToolAnswer> {
  const outcome = await autopilot.command(id, issued.command, issued.now),
    ok = outcome.status === "applied" || outcome.status === "duplicate",
    said = await answer(autopilot, id, { message: outcome.refusal ?? REFUSALS[outcome.status], ok });
  return said;
}

async function begin(autopilot: Autopilot, input: z.infer<typeof startShape>, call: ToolCall): Promise<ToolAnswer> {
  const plan = standardPlan({ flagKey: input.flagKey, guardrails: input.guardrails, risk: input.risk }),
    result = await autopilot.start({ id: input.id, now: call.now, plan }),
    said = await answer(autopilot, input.id, { message: result.status === "started" ? "The rollout has started." : result.problems.join(" "), ok: result.status === "started" });
  return said;
}

type StartInput = z.infer<typeof startShape>;
type TargetInput = z.infer<typeof targetShape>;
type NotedInput = z.infer<typeof notedShape>;
type ApproveInput = z.infer<typeof approveShape>;

interface RolloutTools {
  readonly rollout_approve: RolloutTool<ApproveInput>;
  readonly rollout_pause: RolloutTool<NotedInput>;
  readonly rollout_release: RolloutTool<TargetInput>;
  readonly rollout_resume: RolloutTool<TargetInput>;
  readonly rollout_rollback: RolloutTool<NotedInput>;
  readonly rollout_start: RolloutTool<StartInput>;
  readonly rollout_status: RolloutTool<TargetInput>;
}

interface CommandTool<Input> {
  readonly description: string;
  readonly inputSchema: z.ZodType<Input>;
  /** The command this input asks for, signed with who asked and the call's key. */
  readonly command: (input: Input, signed: { by: string; id: string }) => Command;
}

/** A tool that sends one command, named after the tool call so a retried call applies once. */
function commandTool<Input extends { id: string }>(autopilot: Autopilot, spec: CommandTool<Input>): RolloutTool<Input> {
  return {
    description: spec.description,
    inputSchema: spec.inputSchema,
    run: async (input, call) => {
      const command = spec.command(input, { by: call.actor, id: call.callKey }),
        said = await tell(autopilot, input.id, { command, now: call.now });
      return said;
    },
  };
}

function controlTools(autopilot: Autopilot): Pick<RolloutTools, "rollout_approve" | "rollout_pause" | "rollout_release" | "rollout_resume" | "rollout_rollback"> {
  return {
    rollout_approve: commandTool(autopilot, {
      command: (input, signed) => ({ ...signed, gate: input.gate, type: "approve" }),
      description: "Approve the next step of a rollout, or its release to everybody, when it is waiting for approval. Only do this when the person has said yes to that exact step.",
      inputSchema: approveShape,
    }),
    rollout_pause: commandTool(autopilot, {
      command: (input, signed) => ({ ...signed, note: input.note, type: "pause" }),
      description: "Hold a rollout at its current step. Guardrails keep watching and can still roll it back.",
      inputSchema: notedShape,
    }),
    rollout_release: commandTool(autopilot, {
      command: (_input, signed) => ({ ...signed, type: "release" }),
      description: "Release a rollout to everybody now, skipping the steps and checks that are left. Only do this when the person has asked for exactly that.",
      inputSchema: targetShape,
    }),
    rollout_resume: commandTool(autopilot, {
      command: (_input, signed) => ({ ...signed, type: "resume" }),
      description: "Carry on a paused rollout. After a pause for a regression this accepts the reading that caused it and starts the evidence again.",
      inputSchema: targetShape,
    }),
    rollout_rollback: commandTool(autopilot, {
      command: (input, signed) => ({ ...signed, note: input.note, type: "rollback" }),
      description: "Undo a rollout now: nobody gets the new behaviour. Safe to use whenever something looks wrong.",
      inputSchema: notedShape,
    }),
  };
}

/** The tools, keyed by name. Wrap each for the runtime at hand; the README has an example. */
function rolloutTools(autopilot: Autopilot): RolloutTools {
  return {
    ...controlTools(autopilot),
    rollout_start: {
      description: "Start rolling a feature flag out in steps, watched by guardrail metrics. The flag must be off for everybody when it starts.",
      inputSchema: startShape,
      run: async (input, call) => {
        const said = await begin(autopilot, input, call);
        return said;
      },
    },
    rollout_status: {
      description: "Where a rollout is, what its guardrails read, and what it is waiting on.",
      inputSchema: targetShape,
      run: async (input) => {
        const said = await answer(autopilot, input.id, { message: "Here is the rollout.", ok: true });
        return said;
      },
    },
  };
}

export type { RolloutTool, RolloutTools, ToolAnswer, ToolCall };
export { rolloutTools };
