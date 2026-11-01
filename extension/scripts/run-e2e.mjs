// Starts the installed VS Code with this extension on a folder holding nomos.json (default: the repository).
// Usage: npm run e2e [-- <folder>]. VSCODE_EXE overrides the executable.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const extension = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const folder = path.resolve(process.argv[2] ?? path.join(extension, ".."));

function findCode() {
  if (process.env.VSCODE_EXE) return process.env.VSCODE_EXE;
  const lookup = spawnSync(process.platform === "win32" ? "where" : "which", ["code"], { encoding: "utf8" });
  const script = lookup.stdout.split(/\r?\n/).find(Boolean);
  if (!script) throw new Error("VS Code was not found; set VSCODE_EXE");
  const beside = path.resolve(path.dirname(script), "..", "Code.exe");
  return fs.existsSync(beside) ? beside : script;
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "nomos-e2e-"));
const result = spawnSync(findCode(), [
  folder,
  `--extensionDevelopmentPath=${extension}`,
  `--extensionTestsPath=${path.join(extension, "out", "e2e", "index.js")}`,
  `--user-data-dir=${profile}`,
  "--disable-extensions",
  "--disable-workspace-trust",
  "--skip-welcome",
  "--skip-release-notes",
], { env, stdio: "inherit", timeout: 240000 });
fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
console.log(`VS Code exited with ${result.status}`);
process.exit(result.status ?? 1);
