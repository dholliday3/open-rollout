/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  testRunner: "vitest",
  // Pnpm keeps the runner out of core's node_modules, where Stryker's default plugin glob looks.
  plugins: ["@stryker-mutator/vitest-runner"],
  mutate: ["src/**/*.ts", "!src/**/*.test.ts", "!src/__tests__/**", "!src/sim/**"],
  ignorePatterns: ["dist", "coverage", "reports"],
  // Vitest strips types without checking them, so mutants need no `// @ts-nocheck`.
  disableTypeChecks: false,
  clearTextReporter: { reportTests: false },
};

export default config;
