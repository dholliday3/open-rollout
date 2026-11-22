import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "examples/**/*.test.ts"],
    // Stryker turns a mutant on through one worker's globals, so the tests that share it must run in that worker.
    ...(process.env.STRYKER_MUTATOR_WORKER === undefined ? {} : { maxWorkers: 1 }),
  },
});
