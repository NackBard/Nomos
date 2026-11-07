import fs from "node:fs";
import { extensionRulesPath, generatedFiles, keysWithChangedArguments } from "./go-rules.ts";

// A key whose arguments changed would be filled into the old template by a core with an older catalog (D-062).
const generated = generatedFiles();
if (fs.existsSync(extensionRulesPath)) {
  const next = generated.find((g) => g.file === extensionRulesPath)!.content;
  const problems = keysWithChangedArguments(JSON.parse(fs.readFileSync(extensionRulesPath, "utf8")), JSON.parse(next));
  if (problems.length) {
    for (const problem of problems) console.error(problem);
    console.error("A template whose arguments change needs a new key in messages (D-062); nothing was written.");
    process.exit(1);
  }
}
for (const { file, content } of generated) fs.writeFileSync(file, content);
