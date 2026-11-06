// Runs the Python analyzer with the first Python 3.10+ it finds: $NOMOS_PYTHON, then python3, python and py from PATH.
// For the conformance harness and nomos.json of this repository, where the command is fixed text on every platform;
// the extension finds the interpreter itself through the runtime entry of its registry (D-057).
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "main.py");
const check = ["-I", "-c", "import sys; sys.exit(sys.version_info < (3, 10))"];
const candidates = [process.env.NOMOS_PYTHON, "python3", "python", "py"].filter(Boolean);
const python = candidates.find((program) => spawnSync(program, check, { stdio: "ignore" }).status === 0);
if (!python) {
  process.stderr.write(`error: no Python 3.10 or newer found (tried ${candidates.join(", ")}); set NOMOS_PYTHON to its path\n`);
  process.exit(1);
}
const result = spawnSync(python, ["-I", script, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(result.status ?? 1);
