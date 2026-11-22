import { defineConfig } from "vitest/config";

export default defineConfig({
  // The examples import "open-rollout" as a consumer would; tsconfig's `paths` sends that to src, not the build.
  resolve: { tsconfigPaths: true },
  test: {
    include: ["src/**/*.test.ts", "examples/**/*.test.ts"],
    // Stryker turns a mutant on through one worker's globals, so the tests that share it must run in that worker.
    ...(process.env["STRYKER_MUTATOR_WORKER"] === undefined ? {} : { maxWorkers: 1 }),
  },
});
