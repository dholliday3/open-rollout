import type { Autopilot, ToolAnswer } from "open-rollout";
import { rolloutTools } from "open-rollout";

async function tickRollouts(autopilot: Autopilot): Promise<void> {
  const results = await autopilot.tickAll(Date.now());
  const problems = results.filter((result) => result.status === "failed").flatMap((result) => result.problems);
  if (problems.length > 0) {
    throw new Error(problems.join(" "));
  }
}

async function rollBackCheckout(autopilot: Autopilot): Promise<ToolAnswer> {
  const tools = rolloutTools(autopilot);
  const answer = await tools.rollout_rollback.run(
    { id: "checkout-1", note: "Support is seeing failed payments." },
    { actor: "alice", callKey: "session-42:call-7", now: Date.now() },
  );
  return answer;
}

export { rollBackCheckout, tickRollouts };
