import fs from "node:fs";
import { generatedFiles } from "./go-rules.ts";

for (const { file, content } of generatedFiles()) fs.writeFileSync(file, content);
