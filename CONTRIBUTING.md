# Contributing

Issues and pull requests are welcome.

## Setup

You need Node 22.12 or later and pnpm (the version is pinned in `package.json`; `corepack enable` picks it
up).

```sh
pnpm install
```

## Checks

CI runs the first three on Node 22 and 24. Run them before you push.

| Command | What it does |
|---|---|
| `pnpm type-check` | `tsc --noEmit` over `src`, `examples` and the vitest config |
| `pnpm lint` | oxlint with every rule category on, type-aware; see `.oxlintrc.json` for the few that are off |
| `pnpm test` | vitest: unit tests, the examples (including a check that the README's code samples match `examples/`), and a quick pass of the simulation |
| `pnpm quickstart` | Runs `examples/quickstart.ts` with tsx |
| `pnpm sim` | The simulation at full size (`SIM_RUNS=400 SIM_CHAOS_RUNS=1000`). Slow: run it when you change `decide`, the statistics or the controller |
| `pnpm mutate --mutate <file>` | Stryker mutation testing on one file, such as `pnpm mutate --mutate src/decide.ts`. A whole-package run is slow |

To replay one chaotic simulation run and print its story, take the seed from the failure and run
`SIM_CHAOS_SEED=<seed> pnpm exec vitest run src/sim/chaos`.

## Where things are

- `src/decide.ts` is the pure core: `decide(record, observation, now)` returns the next record and at most
  one flag write. `guard.ts`, `progress.ts`, `reconcile.ts` and `transitions.ts` are its parts.
- `src/controller.ts` runs ticks and commands over the four ports in `src/ports.ts`.
- `src/stats.ts` and `src/judge.ts` are the statistics; `src/plan.ts` the plans and their defaults.
- `src/adapters/` has the in-memory and PostHog adapters; `src/tools.ts` the agent tools; `src/release.ts`
  releases across environments.
- `src/sim/` is the simulated production that attacks the guarantees in `docs/guarantees.md`.
- `examples/` holds every code sample in the README, type-checked and tested.

## Changing behaviour

- A change to what the package promises goes in `docs/guarantees.md`, with a test that would fail without
  it. If it is a safety promise, the chaos oracle in `src/sim/chaos.invariants.ts` should check it.
- A change to the statistics needs the false-alarm and detection numbers rerun (`pnpm sim`), and
  `docs/evaluation.md` updated with them.
- A README code sample is a slice of a file in `examples/`. Change the file and the README together;
  `examples/quickstart.test.ts` fails when they differ.
- Public API is whatever `src/index.ts` exports. Deep imports into `src/` are not part of it.
