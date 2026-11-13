import fs from "node:fs";
import { renderRulesDocs } from "./rules-doc.ts";

for (const { file, content } of renderRulesDocs()) fs.writeFileSync(file, content);
