import { fileURLToPath } from "node:url";
import path from "node:path";

/** Repository root: conformance/runner/src -> three levels up. */
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const contractsDir = path.join(repoRoot, "contracts");
export const rulesDir = path.join(repoRoot, "spec", "rules");
export const practicesFile = path.join(repoRoot, "spec", "practices.yaml");
export const casesDir = path.join(repoRoot, "conformance", "cases");
