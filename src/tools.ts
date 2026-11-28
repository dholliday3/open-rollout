import type { Autopilot, CommandOutcome } from "./controller.js";
import type { Guardrail, RolloutPlan } from "./plan.js";
import { approveShape, forecastShape, notedShape, startShape, targetShape } from "./tool-shapes.js";
import { duration, forecast } from "./traffic.js";
import type { Command } from "./commands.js";
import type { Forecast } from "./traffic.js";
import type { RolloutSummary } from "./summary.js";
import type { guardrailShape } from "./tool-shapes.js";
import { planProblems } from "./plan.js";
import { standardPlan } from "./standard-plan.js";
import { summarize } from "./summary.js";
import type { z } from "zod";

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
  /** How long the plan takes on the flag's traffic, when that is known. */
  readonly forecast?: Forecast;
}

/** A tool's zod 4 input schema, named here so code that infers one needn't reach zod through this package. */
type ToolSchema<Input> = z.ZodType<Input>;

/** One tool: what the model reads, what it must send, and what happens. */
interface RolloutTool<Input> {
  readonly description: string;
  readonly inputSchema: ToolSchema<Input>;
  readonly run: (input: Input, call: ToolCall) => Promise<ToolAnswer>;
}

const REFUSALS: Record<CommandOutcome["status"], string> = {
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

/** A guardrail as the plan holds it: an option the agent left out is not there at all, so the plan compares equal after a trip through JSON. */
function guardrailOf({ mustImproveBy, mustRuleOut, ...guardrail }: z.infer<typeof guardrailShape>): Guardrail {
  return { ...guardrail, ...(mustRuleOut === undefined ? {} : { mustRuleOut }), ...(mustImproveBy === undefined ? {} : { mustImproveBy }) };
}

/** The standard plan the input asks for, sized to the traffic the agent gave or the source measured, and how long it takes on it. */
async function planned(autopilot: Autopilot, input: z.infer<typeof forecastShape>): Promise<{ plan: RolloutPlan; outlook: Forecast | null }> {
  const guardrails = input.guardrails.map((guardrail) => guardrailOf(guardrail)),
    unitsPerHour = input.unitsPerHour ?? (guardrails.length === 0 ? null : await autopilot.traffic(input.flagKey)),
    plan = standardPlan({ flagKey: input.flagKey, guardrails, overrides: input.overrides, risk: input.risk, sourceLagMs: input.sourceLagMs, unitsPerHour: unitsPerHour ?? undefined });
  return { outlook: unitsPerHour === null ? null : forecast(plan, unitsPerHour), plan };
}

function outlookOf(outlook: Forecast): string {
  return `At about ${Math.round(outlook.unitsPerHour)} new units an hour, it should take about ${duration(outlook.expectedMs)}.`;
}

async function begin(autopilot: Autopilot, input: z.infer<typeof startShape>, call: ToolCall): Promise<ToolAnswer> {
  const { outlook, plan } = await planned(autopilot, input);
  if (outlook !== null && outlook.problems.length > 0) {
    return { forecast: outlook, message: outlook.problems.join(" "), ok: false, rollout: null };
  }
  const result = await autopilot.start({ id: input.id, now: call.now, plan }),
    started = result.status === "started",
    message = started ? ["The rollout has started.", ...(outlook === null ? [] : [outlookOf(outlook)])].join(" ") : result.problems.join(" "),
    said = await answer(autopilot, input.id, { message, ok: started });
  return outlook === null ? said : { ...said, forecast: outlook };
}

async function foresee(autopilot: Autopilot, input: z.infer<typeof forecastShape>): Promise<ToolAnswer> {
  const { outlook, plan } = await planned(autopilot, input),
    problems = [...planProblems(plan), ...(outlook?.problems ?? [])];
  if (outlook === null) {
    return { message: "The metric source can't say how much traffic this flag gets. Give unitsPerHour.", ok: false, rollout: null };
  }
  return { forecast: outlook, message: problems.length === 0 ? outlookOf(outlook) : problems.join(" "), ok: problems.length === 0, rollout: null };
}

type StartInput = z.infer<typeof startShape>;
type ForecastInput = z.infer<typeof forecastShape>;
type TargetInput = z.infer<typeof targetShape>;
type NotedInput = z.infer<typeof notedShape>;
type ApproveInput = z.infer<typeof approveShape>;

interface RolloutTools {
  readonly rollout_approve: RolloutTool<ApproveInput>;
  readonly rollout_forecast: RolloutTool<ForecastInput>;
  readonly rollout_pause: RolloutTool<NotedInput>;
  readonly rollout_release: RolloutTool<TargetInput>;
  readonly rollout_resume: RolloutTool<TargetInput>;
  readonly rollout_rollback: RolloutTool<NotedInput>;
  readonly rollout_start: RolloutTool<StartInput>;
  readonly rollout_status: RolloutTool<TargetInput>;
}

type ToolInput<Name extends keyof RolloutTools> = Parameters<RolloutTools[Name]["run"]>[0];

/** One tool call as `authorize` sees it, before it runs: which tool, its input, and who it is for. */
type ToolRequest = { readonly [Name in keyof RolloutTools]: ToolCall & { readonly tool: Name; readonly input: ToolInput<Name> } }[keyof RolloutTools];

/** What `authorize` says: go ahead, or refuse with a reason the agent is told. */
type Authorization = { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

type Authorize = (request: ToolRequest) => Authorization | Promise<Authorization>;

interface RolloutToolsOptions {
  /**
   * Asked before every call, `rollout_status` included. A refused call changes nothing and answers `ok: false`
   * with the reason; a hook that throws stops the call too. Without it any actor may call any tool, including
   * `rollout_release`, which skips every check that is left.
   */
  readonly authorize?: Authorize | undefined;
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

function everyTool(autopilot: Autopilot): RolloutTools {
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
    rollout_forecast: {
      description: "How long a rollout would take on the traffic the flag gets, step by step, without starting it. A fix on a path few people reach can take days; when a plan can't get through on its traffic, ship the change without a flag instead.",
      inputSchema: forecastShape,
      run: async (input) => {
        const said = await foresee(autopilot, input);
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

/** The tool, asking first. A refused call shows no rollout either: whoever was refused may not be allowed to see it. */
function asking<Input>(tool: RolloutTool<Input>, authorize: Authorize, requestOf: (input: Input, call: ToolCall) => ToolRequest): RolloutTool<Input> {
  return {
    ...tool,
    run: async (input, call) => {
      const verdict = await authorize(requestOf(input, call));
      if (!verdict.allowed) {
        return { message: `Not allowed: ${verdict.reason}`, ok: false, rollout: null };
      }
      const said = await tool.run(input, call);
      return said;
    },
  };
}

/** The tools, keyed by name. Wrap each for the runtime at hand; the README has an example. */
function rolloutTools(autopilot: Autopilot, options: RolloutToolsOptions = {}): RolloutTools {
  const tools = everyTool(autopilot),
    { authorize } = options;
  if (authorize === undefined) {
    return tools;
  }
  return {
    rollout_approve: asking(tools.rollout_approve, authorize, (input, call) => ({ ...call, input, tool: "rollout_approve" })),
    rollout_forecast: asking(tools.rollout_forecast, authorize, (input, call) => ({ ...call, input, tool: "rollout_forecast" })),
    rollout_pause: asking(tools.rollout_pause, authorize, (input, call) => ({ ...call, input, tool: "rollout_pause" })),
    rollout_release: asking(tools.rollout_release, authorize, (input, call) => ({ ...call, input, tool: "rollout_release" })),
    rollout_resume: asking(tools.rollout_resume, authorize, (input, call) => ({ ...call, input, tool: "rollout_resume" })),
    rollout_rollback: asking(tools.rollout_rollback, authorize, (input, call) => ({ ...call, input, tool: "rollout_rollback" })),
    rollout_start: asking(tools.rollout_start, authorize, (input, call) => ({ ...call, input, tool: "rollout_start" })),
    rollout_status: asking(tools.rollout_status, authorize, (input, call) => ({ ...call, input, tool: "rollout_status" })),
  };
}

export type { Authorization, RolloutTool, RolloutTools, RolloutToolsOptions, ToolAnswer, ToolCall, ToolRequest, ToolSchema };
export { rolloutTools };
