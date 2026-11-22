/**
 * Packs open-rollout the way it would be published, installs the tarball into a fresh project, and uses it
 * as a consumer would: with plain `node` (ESM and `require`), and from TypeScript compiled under `nodenext`
 * and under `bundler` with the strictest options, by the TypeScript most consumers run and by this repo's.
 */
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { tmpdir } from "node:os";

const ROOT = fileURLToPath(new URL("..", import.meta.url)),
  FIXTURE = path.join(ROOT, "scripts", "package-consumer"),
  REPO_TSC = path.join(ROOT, "node_modules", ".bin", "tsc"),
  /** What a consumer's TypeScript most likely is, next to this repo's own. */
  CONSUMER_TYPESCRIPT = "~5.9.0",
  SHIPPED = /^(?:package\.json|README\.md|LICENSE|dist\/.+\.(?:js|d\.ts))$/,
  CORE_ENTRY = "dist/index.js",
  IMPORT = /(?:from|import)\s*"(?<specifier>[^"]+)"/g;

/** Runs a command and returns what it printed; when it fails, what it printed is in the error. tsc prints its errors there. */
function run(command: string, args: readonly string[], cwd: string): string {
  try {
    return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  } catch (error) {
    const printed = error instanceof Error && "stdout" in error ? String(error.stdout) : "";
    throw new Error(`${command} ${args.join(" ")} failed in ${cwd}\n${printed}`, { cause: error });
  }
}

function fail(message: string): never {
  throw new Error(message);
}

/** Every file the tarball ships, without npm's `package/` prefix. */
function packedFiles(tarball: string): string[] {
  return run("tar", ["-tzf", tarball], ROOT)
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.replace(/^package\//, ""));
}

/** The packages a built module loads, following its relative imports through the build. */
function packagesLoadedBy(entry: string, seen: Set<string>): string[] {
  if (seen.has(entry)) {
    return [];
  }
  seen.add(entry);
  return [...readFileSync(path.join(ROOT, entry), "utf8").matchAll(IMPORT)].flatMap((match) => {
    const specifier = match.groups?.["specifier"] ?? "";
    return specifier.startsWith(".") ? packagesLoadedBy(path.join(path.dirname(entry), specifier), seen) : [specifier];
  });
}

function checkTarball(tarball: string): void {
  const files = packedFiles(tarball),
    stray = files.filter((file) => !SHIPPED.test(file) || file.includes(".test.") || file.startsWith("dist/sim/"));
  if (stray.length > 0) {
    fail(`The tarball ships files a consumer doesn't need: ${stray.join(", ")}`);
  }
  console.log(`tarball: ${files.length} files, all of them dist, README, LICENSE or package.json`);
  const loaded = [...new Set(packagesLoadedBy(CORE_ENTRY, new Set()))];
  if (loaded.length > 0) {
    fail(`The core entry loads ${loaded.join(", ")}; it should load nothing outside the package.`);
  }
  console.log("core entry: loads no other package");
}

function installConsumer(tarball: string): string {
  const consumer = mkdtempSync(path.join(tmpdir(), "open-rollout-consumer-"));
  cpSync(FIXTURE, consumer, { recursive: true });
  const manifest = {
    dependencies: { "@types/node": "^22.20.5", "open-rollout": `file:${tarball}`, typescript: CONSUMER_TYPESCRIPT },
    name: "open-rollout-consumer",
    private: true,
    type: "module",
  };
  writeFileSync(path.join(consumer, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  run("pnpm", ["install", "--ignore-workspace"], consumer);
  return consumer;
}

function useAsConsumer(consumer: string): void {
  const consumerTsc = path.join(consumer, "node_modules", ".bin", "tsc");
  process.stdout.write(run("node", ["smoke.mjs"], consumer));
  process.stdout.write(run("node", ["smoke.cjs"], consumer));
  for (const { name, tsc } of [
    { name: "TypeScript 5.9", tsc: consumerTsc },
    { name: "this repo's TypeScript", tsc: REPO_TSC },
  ]) {
    run(tsc, ["-p", "tsconfig.bundler.json"], consumer);
    run(tsc, ["-p", "tsconfig.nodenext.json"], consumer);
    console.log(`type-check (${name}): nodenext and bundler pass`);
    process.stdout.write(run("node", [path.join("out", "consumer.js")], consumer));
  }
}

const packDirectory = mkdtempSync(path.join(tmpdir(), "open-rollout-pack-"));
let consumerDirectory: string | null = null;
try {
  run("node", ["--run", "build"], ROOT);
  run("pnpm", ["pack", "--pack-destination", packDirectory], ROOT);
  const tarball = path.join(packDirectory, readdirSync(packDirectory).find((name) => name.endsWith(".tgz")) ?? fail("pnpm pack made no tarball."));
  checkTarball(tarball);
  consumerDirectory = installConsumer(tarball);
  useAsConsumer(consumerDirectory);
} finally {
  rmSync(packDirectory, { force: true, recursive: true });
  if (consumerDirectory !== null) {
    rmSync(consumerDirectory, { force: true, recursive: true });
  }
}
