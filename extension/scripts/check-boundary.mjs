// ROADMAP stage 3: the extension holds no language-specific code. Fails on names of languages,
// parsers or source extensions anywhere in the code it ships.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const forbidden = /\b(csharp|c#|roslyn|dotnet|python|typescript|golang|kotlin|ruby|prism|tree-?sitter)\b|\.(cs|py|tsx?|go|java|kts?|rb)["'`]/i;
const problems = [];

function scan(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "test") scan(full);
    } else {
      fs.readFileSync(full, "utf8").split("\n").forEach((line, i) => {
        if (forbidden.test(line)) problems.push(`${path.relative(root, full)}:${i + 1}: ${line.trim()}`);
      });
    }
  }
}

scan(path.join(root, "src"));
scan(path.join(root, "media"));
problems.forEach((p) => console.log(p));
console.log(problems.length ? `${problems.length} language-specific line(s)` : "no language-specific code in the extension");
process.exit(problems.length ? 1 : 0);
