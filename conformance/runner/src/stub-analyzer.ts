// Empty analyzer used to check the harness itself: valid manifest and valid, empty facts.
// It implements no rules and reports nothing, so every non-trivial case must fail with a clear message.
const [command] = process.argv.slice(2);
if (command === "manifest") {
  console.log(JSON.stringify({
    name: "nomos-stub", language: "csharp", version: "0.0.0", schemaVersion: "1.0.0", paradigms: [],
    capabilities: { semantic: false, supportedRules: [] }, rules: [],
  }));
} else if (command === "analyze") {
  console.log(JSON.stringify({
    schemaVersion: "1.0.0", analyzer: { name: "nomos-stub", version: "0.0.0", language: "csharp" },
    files: [], modules: [], types: [], functions: [], dependencies: [], skippedRules: [], diagnostics: [],
  }));
} else {
  console.error(`unknown command: ${command}`);
  process.exit(2);
}
