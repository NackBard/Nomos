import { validateRepository } from "./validate.ts";
import { runConformance } from "./run.ts";
import type { Analyzer, Check } from "./run.ts";
import { sarifSchemaAvailable } from "./sarif-schema.ts";

const usage = `Usage:
  node src/cli.ts validate
  node src/cli.ts run --analyzer <language>=<command...> [--analyzer ...] [--case <id>]

The command is split on spaces, e.g. --analyzer "csharp=dotnet run --project analyzers/csharp --".`;

function report(checks: Check[]): number {
  let failed = 0;
  for (const check of checks) {
    console.log(`${check.errors.length ? "FAIL" : "PASS"}  ${check.name}`);
    for (const error of check.errors) console.log(`        ${error}`);
    if (check.errors.length) failed++;
  }
  console.log(`\n${checks.length - failed} passed, ${failed} failed`);
  if (!sarifSchemaAvailable()) console.log("note: the official SARIF 2.1.0 schema is not downloaded, only the profile rules were checked (npm run fetch-sarif-schema)");
  return failed ? 1 : 0;
}

const [command, ...args] = process.argv.slice(2);
if (command === "validate") {
  const errors = validateRepository();
  errors.forEach((e) => console.log(`FAIL  ${e}`));
  console.log(errors.length ? `\n${errors.length} problem(s)` : "contracts, spec/rules and conformance cases are valid");
  process.exit(errors.length ? 1 : 0);
} else if (command === "run") {
  const analyzers: Analyzer[] = [];
  let only: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--analyzer") {
      const [language, ...rest] = (args[++i] ?? "").split("=");
      const parts = rest.join("=").split(" ").filter(Boolean);
      if (!language || parts.length === 0) {
        console.error(usage);
        process.exit(2);
      }
      analyzers.push({ language, command: parts });
    } else if (args[i] === "--case") {
      only = args[++i];
    } else {
      console.error(usage);
      process.exit(2);
    }
  }
  if (analyzers.length === 0) {
    console.error(usage);
    process.exit(2);
  }
  process.exit(report(runConformance(analyzers, only)));
} else {
  console.error(usage);
  process.exit(2);
}
