// CommonJS: Node 22.12 and later can require() an ES module, which is the only way this package loads from CJS.
const { standardPlan } = require("open-rollout");
const { rolloutTools } = require("open-rollout/tools");

if (standardPlan({ flagKey: "f", risk: "low", guardrails: [] }).steps.length !== 2 || typeof rolloutTools !== "function") {
  throw new Error("The packed package did not load through require().");
}
console.log("require: loaded");
