// Checks the language packs of dist/ on this machine (stage 18): unpacks each .vsix, reads the registry entries of the
// pack as the core does, finds the runtime as the core does without VS Code (environment variables and PATH, no other
// extension), and analyzes the conformance sample of the language with the core's runner, which checks the facts and
// SARIF against the contracts.
//   node scripts/check-packs.mjs [--target win32-x64] [--require go,typescript] [--dist dist] [--case <conformance case>]
// --target: packs built for another target are left out (default: this machine). --require: languages that must run;
// an analyzer whose runtime is missing is otherwise reported and skipped. Needs `npm run compile` for out/core.
// This is build tooling, not shipped code: it may name targets, but it reads languages only from the packs.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const extension = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repository = path.resolve(extension, "..");
const require = createRequire(import.meta.url);
const { findRuntime, implicitWorkspace, launchConfig, PackageKey } = require(path.join(extension, "out", "core", "bundle.js"));
const { analyze } = require(path.join(extension, "out", "core", "runner.js"));

const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : fallback;
};
const targets = ["win32-x64", "win32-arm64", "linux-x64", "linux-arm64", "alpine-x64", "darwin-x64", "darwin-arm64"];
const target = option("--target", `${process.platform}-${process.arch}`);
if (!targets.includes(target)) {
  console.error(`unknown target "${target}"; known: ${targets.join(", ")}`);
  process.exit(2);
}
const required = new Set(option("--require", "").split(",").filter(Boolean));
const dist = path.resolve(extension, option("--dist", "dist"));
const sample = path.resolve(repository, "conformance", "cases", option("--case", "metrics-basic"));

// A .vsix is a zip: the bsdtar of Windows reads it (not the GNU tar of Git Bash, which may come first in PATH), unzip
// elsewhere (busybox has it on Alpine).
function unpack(file, folder) {
  fs.mkdirSync(folder, { recursive: true });
  const windowsTar = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  const [command, args] = process.platform === "win32" ? [windowsTar, ["-xf", file, "-C", folder]] : ["unzip", ["-q", "-o", file, "-d", folder]];
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`could not unpack ${file} with ${command}`);
}

// The core's runtime search without VS Code: no extension answers and no settings are set.
const host = {
  hasExtension: () => false,
  execute: async () => undefined,
  setting: () => undefined,
  environment: (name) => process.env[name],
  usable: async (program, args) => spawnSync(program, args, { stdio: "ignore", timeout: 60000 }).status === 0,
};

const otherTarget = (file) => targets.some((t) => t !== target && file.includes(`-${t}-`));
const files = fs.existsSync(dist) ? fs.readdirSync(dist).filter((f) => f.endsWith(".vsix") && !otherTarget(f)).sort() : [];
if (!files.length) {
  console.error(`${dist} has no .vsix for ${target}; run: npm run package`);
  process.exit(2);
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "nomos-packs-"));
const results = [];
try {
  for (const file of files) {
    const folder = path.join(temporary, path.basename(file, ".vsix"));
    unpack(path.join(dist, file), folder);
    const root = path.join(folder, "extension");
    const analyzers = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))[PackageKey]?.analyzers;
    if (!Array.isArray(analyzers)) continue; // the core, not a pack
    for (const entry of analyzers) {
      const analyzer = { ...entry, folder: path.join(root, "bundle") };
      const source = path.join(sample, analyzer.language, "src");
      const result = { pack: file, language: analyzer.language };
      results.push(result);
      try {
        if (!fs.existsSync(source)) throw new Error(`no sample ${path.relative(repository, source)}`);
        const runtime = analyzer.runtime ? await findRuntime(analyzer.runtime, source, host, analyzer.folder) : undefined;
        if (analyzer.runtime && !runtime) {
          result.status = "skipped";
          result.detail = `${analyzer.runtime.name} not found`;
          continue;
        }
        const storage = path.join(temporary, "storage", analyzer.language);
        const config = launchConfig(analyzer, analyzer.folder, storage, runtime);
        const run = await analyze(config, source, implicitWorkspace(config), undefined, path.join(storage, "no-nomos.json"));
        result.status = "ok";
        result.detail = `${run.facts.modules.length} modules, ${run.facts.types.length} types, ${run.facts.functions.length} functions, ${run.findings.length} findings${run.partial ? ", partial" : ""}${runtime ? `, ${runtime}` : ""}`;
      } catch (error) {
        result.status = "failed";
        result.detail = error instanceof Error ? error.message : String(error);
      }
    }
  }
} finally {
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 3 });
}

for (const r of results) console.log(`${r.status.padEnd(7)} ${r.language.padEnd(11)} ${r.pack}: ${r.detail}`);
const languages = new Set(results.map((r) => r.language));
const problems = [
  ...results.filter((r) => r.status === "failed").map((r) => `${r.language} failed`),
  ...results.filter((r) => r.status === "skipped" && required.has(r.language)).map((r) => `${r.language} is required but was skipped`),
  ...[...required].filter((language) => !languages.has(language)).map((language) => `${language} is required but no pack has it`),
];
for (const problem of problems) console.error(problem);
console.log(`${target}: ${results.filter((r) => r.status === "ok").length} ran, ${results.filter((r) => r.status === "skipped").length} skipped, ${problems.length} problems`);
process.exit(problems.length ? 1 : 0);
