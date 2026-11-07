// Runs the Ruby analyzer with the first Ruby 3.3+ it finds: $NOMOS_RUBY, then ruby from PATH.
// For the conformance harness and nomos.json of this repository, where the command is fixed text on every platform;
// the extension finds the interpreter itself through the runtime entry of its registry (D-061).
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "main.rb");
const check = ["--disable-gems", "-e", "exit((RUBY_VERSION.split('.').map(&:to_i) <=> [3, 3]) >= 0)"];
const candidates = [process.env.NOMOS_RUBY, "ruby"].filter(Boolean);
const ruby = candidates.find((program) => spawnSync(program, check, { stdio: "ignore" }).status === 0);
if (!ruby) {
  process.stderr.write(`error: no Ruby 3.3 or newer found (tried ${candidates.join(", ")}); set NOMOS_RUBY to its path\n`);
  process.exit(1);
}
// --test runs the tests of the analyzer with the same Ruby.
const args = process.argv[2] === "--test" ? [path.join(path.dirname(script), "test", "tests.rb")] : [script, ...process.argv.slice(2)];
const result = spawnSync(ruby, ["--disable-gems", ...args], { stdio: "inherit" });
process.exit(result.status ?? 1);
