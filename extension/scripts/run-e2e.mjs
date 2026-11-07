// Starts the installed VS Code with this extension on a folder (default: the repository, which holds nomos.json).
// Usage: npm run e2e [-- <folder> [--packs]]. VSCODE_EXE overrides the executable. With --packs the core and the language
// packs of dist/ (npm run package) are installed into the test profile and the analyzers must run from the packs (D-062).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const extension = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packs = process.argv.includes("--packs");
const folder = path.resolve(process.argv.slice(2).find((a) => !a.startsWith("--")) ?? path.join(extension, ".."));

function findCode() {
  if (process.env.VSCODE_EXE) return process.env.VSCODE_EXE;
  const lookup = spawnSync(process.platform === "win32" ? "where" : "which", ["code"], { encoding: "utf8" });
  const script = lookup.stdout.split(/\r?\n/).find(Boolean);
  if (!script) throw new Error("VS Code was not found; set VSCODE_EXE");
  const beside = path.resolve(path.dirname(script), "..", "Code.exe");
  return fs.existsSync(beside) ? beside : script;
}

const env = { ...process.env, ...(packs ? { NOMOS_E2E_PACKS: "1" } : {}) };
delete env.ELECTRON_RUN_AS_NODE;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "nomos-e2e-"));

// A folder without nomos.json runs the bundled analyzers (npm run package -- --bundle-only builds them, D-046).
// Those may need a runtime from another extension, so it is installed into the test profile instead of disabling extensions.
const bundled = !fs.existsSync(path.join(folder, "nomos.json"));
const extensionsDir = path.join(profile, "extensions");
const isolation = [`--extensions-dir=${extensionsDir}`];
if (bundled) {
  const registry = path.join(extension, "bundle", "analyzers.json");
  if (!fs.existsSync(registry)) throw new Error(`${folder} has no nomos.json and the extension has no bundle; run: npm run package -- --bundle-only`);
  // Only analyzers with files in the folder start, so only their runtimes are installed (globs of the form **/*.ext).
  const extensions = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && !entry.name.startsWith(".")) walk(path.join(dir, entry.name));
      } else extensions.add(path.extname(entry.name));
    }
  };
  walk(folder);
  const present = (analyzer) => analyzer.files.some((glob) => !/^\*\*\/\*\.[^/*]+$/.test(glob) || extensions.has(glob.slice(3)));
  // A runtime with PATH programs (`path`) works without its extension, which is then not installed (D-057).
  const runtimes = [...new Set(JSON.parse(fs.readFileSync(registry, "utf8")).analyzers.filter(present).flatMap((a) => (a.runtime && !a.runtime.path ? [a.runtime.extension] : [])))];
  const cli = spawnSync(process.platform === "win32" ? "where" : "which", ["code"], { encoding: "utf8" }).stdout.split(/\r?\n/).find(Boolean);
  // The core goes first: the packs depend on it, and it is not in the Marketplace yet. The development copy of the core
  // then replaces the installed one, while the packs stay.
  const dist = path.join(extension, "dist");
  const vsix = packs ? fs.readdirSync(dist).filter((f) => f.endsWith(".vsix")).sort((a, b) => Number(b.startsWith("nomos-0")) - Number(a.startsWith("nomos-0")) || (a < b ? -1 : 1)).map((f) => path.join(dist, f)) : [];
  if (packs && !vsix.length) throw new Error("dist/ has no .vsix; run: npm run package");
  // Only the Windows shell needs the quotes; without a shell they would become part of the argument.
  const quote = (text) => (process.platform === "win32" ? `"${text}"` : text);
  for (const id of [...runtimes, ...vsix]) {
    // The CLI script is a .cmd on Windows, which only starts through a shell; the arguments are fixed here.
    const install = spawnSync(process.platform === "win32" ? `"${cli}"` : cli, [`--extensions-dir=${quote(extensionsDir)}`, "--install-extension", quote(id)], { env, stdio: "inherit", shell: process.platform === "win32" });
    if (install.status !== 0) throw new Error(`could not install ${id} into the test profile`);
  }
} else {
  isolation.push("--disable-extensions");
}

const result = spawnSync(findCode(), [
  folder,
  `--extensionDevelopmentPath=${extension}`,
  `--extensionTestsPath=${path.join(extension, "out", "e2e", "index.js")}`,
  `--user-data-dir=${profile}`,
  ...isolation,
  "--disable-workspace-trust",
  "--skip-welcome",
  "--skip-release-notes",
], { env, stdio: "inherit", timeout: 240000 });
fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
console.log(`VS Code exited with ${result.status}`);
process.exit(result.status ?? 1);
