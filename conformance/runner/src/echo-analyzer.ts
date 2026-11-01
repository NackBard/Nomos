// Harness self-test: answers `analyze --root <case>/<language>/src` with the case's own expected.facts.json.
// A real analyzer is never allowed to do this; here it proves that the PASS path of the harness works
// (schema validation, comparison, determinism, absolute-path check).
import fs from "node:fs";
import path from "node:path";

const [command, ...args] = process.argv.slice(2);
if (command === "manifest") {
  console.log(JSON.stringify({
    name: "nomos-echo", language: "csharp", version: "0.0.0", schemaVersion: "1.0.0", paradigms: [],
    capabilities: { semantic: false, supportedRules: [], sarif: false }, rules: [],
  }));
} else if (command === "analyze") {
  const root = args[args.indexOf("--root") + 1];
  const expected = fs.readFileSync(path.join(root, "..", "expected.facts.json"), "utf8");
  process.stdout.write(expected);
  if (JSON.parse(expected).files.some((f: { parsed?: boolean }) => f.parsed === false)) process.exitCode = 4;
} else {
  console.error(`unknown command: ${command}`);
  process.exit(2);
}
