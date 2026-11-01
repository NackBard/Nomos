import fs from "node:fs";
import { goRulesPath, renderGoRules } from "./go-rules.ts";

fs.writeFileSync(goRulesPath, renderGoRules());
