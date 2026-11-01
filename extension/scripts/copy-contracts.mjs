// The extension ships the schemas it validates against; the source of truth stays in contracts/.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(here, "../../contracts");
const target = path.resolve(here, "../contracts");

fs.mkdirSync(target, { recursive: true });
for (const file of fs.readdirSync(source).filter((f) => f.endsWith(".schema.json"))) {
  fs.copyFileSync(path.join(source, file), path.join(target, file));
}
