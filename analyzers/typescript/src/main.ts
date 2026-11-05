// The TypeScript and JavaScript analyzer of Nomos. It speaks the protocol of docs/ARCHITECTURE.md: facts go to stdout,
// SARIF to the file named by --sarif, messages for people to stderr. One program serves two registry entries; the
// language comes first: `main.js [--language javascript] manifest | analyze …` (D-055).
import fs from "node:fs";
import { ConfigError, loadConfig } from "./config.ts";
import { analyze, analyzerName, manifest } from "./facts.ts";
import { Project, extensions } from "./project.ts";
import { supported } from "./rules.ts";

const success = 0;
const unexpected = 1;
const usageError = 2;
const badInput = 3;
const partial = 4;

function usage(message: string): number {
  process.stderr.write(`${message}\nUsage: ${analyzerName} [--language typescript|javascript] manifest | analyze --root <path> [--sarif <file>] [--config <nomos.json>] [--rules <ids>]\n`);
  return usageError;
}

function runAnalyze(language: string, args: string[]): number {
  const values: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    if (i + 1 >= args.length) return usage(`Missing value for ${args[i]}`);
    if (!["--root", "--sarif", "--config", "--rules", "--files"].includes(args[i])) return usage(`Unknown option: ${args[i]}`);
    values[args[i]] = args[i + 1]; // --files is ignored: this analyzer always reads the whole root (partialAnalysis = false)
  }
  const root = values["--root"];
  if (!root) return usage("--root is required");
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    process.stderr.write(`error: root does not exist: ${root}\n`);
    return badInput;
  }
  let config;
  try {
    config = loadConfig(values["--config"], language);
  } catch (e) {
    process.stderr.write(`error: ${(e as Error).message}\n`);
    return e instanceof ConfigError ? badInput : unexpected;
  }
  let selected: Set<string> | undefined;
  if (values["--rules"]) {
    selected = new Set();
    for (const raw of values["--rules"].split(",")) {
      const id = raw.trim();
      if (!supported.includes(id)) return usage(`Unknown rule: ${id}`);
      selected.add(id);
    }
  }
  const { include, exclude } = config.scope();
  const project = new Project(root, language);
  project.load(include, exclude);
  // A folder without files of this language is an empty analysis, not an error: the extension picks analyzers by a
  // glob that also matches files in node_modules and build output (D-055).
  const result = analyze(project, { root, sarif: values["--sarif"], selected, config });
  process.stdout.write(result.facts);
  return result.partial ? partial : success; // findings never change the exit code, only an incomplete result does
}

function main(argv: string[]): number {
  let language = "typescript";
  let args = argv;
  if (args[0] === "--language") {
    language = args[1] ?? "";
    args = args.slice(2);
    if (!extensions[language]) return usage(`Unknown language: ${language}`);
  }
  if (args.length === 1 && args[0] === "manifest") {
    process.stdout.write(JSON.stringify(manifest(language), null, 2) + "\n");
    return success;
  }
  if (args[0] === "analyze") return runAnalyze(language, args.slice(1));
  return usage(`Unknown command or option: ${args.join(" ")}`);
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  process.stderr.write(`error: ${(e as Error).stack ?? e}\n`);
  process.exitCode = unexpected;
}
