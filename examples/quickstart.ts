import {
  createAutopilot,
  createMemoryFlags,
  createMemoryNotifier,
  createMemoryStore,
  standardPlan,
} from "open-rollout";
import { simulatedTraffic } from "./simulated-traffic";

const flags = createMemoryFlags();
const notifier = createMemoryNotifier();
const traffic = simulatedTraffic({
  flags,
  flagKey: "new-checkout",
  metric: "errors",
  errorRate: { control: 0.02, treatment: 0.02 },
});
const autopilot = createAutopilot({
  flags,
  metrics: traffic,
  notifier,
  store: createMemoryStore(),
});

const plan = standardPlan({
  flagKey: "new-checkout",
  risk: "low",
  guardrails: [
    {
      metric: "errors",
      kind: "rate",
      direction: "lower_is_better",
      tolerance: 0,
      onRegression: "rollback",
    },
  ],
});
await autopilot.start({ id: "checkout-1", plan, now: traffic.now() });

for (let minute = 0; minute < 60; minute += 1) {
  traffic.passMinute();
  await autopilot.tickAll(traffic.now());
}

for (const event of notifier.events) {
  console.log(`${event.type}: ${event.detail}`);
}
