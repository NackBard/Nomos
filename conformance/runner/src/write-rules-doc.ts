import fs from "node:fs";
import { renderRulesDoc, rulesDocPath } from "./rules-doc.ts";

fs.writeFileSync(rulesDocPath, renderRulesDoc());
