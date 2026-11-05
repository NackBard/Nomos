// Builds a platform-specific .vsix with the analyzers inside (D-046).
//   node scripts/package.mjs [--target win32-x64]   (default: this machine)
// This is build tooling, not shipped code: it may name languages. The shipped extension only reads
// bundle/analyzers.json, which is written here from each analyzer's own manifest.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const extension = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repository = path.resolve(extension, "..");
const bundle = path.join(extension, "bundle");

// VS Code targets and the matching Go platform.
const goPlatforms = {
  "win32-x64": ["windows", "amd64"], "win32-arm64": ["windows", "arm64"],
  "linux-x64": ["linux", "amd64"], "linux-arm64": ["linux", "arm64"], "alpine-x64": ["linux", "amd64"],
  "darwin-x64": ["darwin", "amd64"], "darwin-arm64": ["darwin", "arm64"],
};

const argumentIndex = process.argv.indexOf("--target");
const target = argumentIndex > 0 ? process.argv[argumentIndex + 1] : `${process.platform}-${process.arch}`;
if (!goPlatforms[target]) {
  console.error(`unknown target "${target}"; known: ${Object.keys(goPlatforms).join(", ")}`);
  process.exit(2);
}

function run(command, args, options = {}) {
  console.log(`> ${command} ${args.join(" ")}`);
  return execFileSync(command, args, { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", ...options });
}

function manifest(command, args, options) {
  const parsed = JSON.parse(run(command, [...args, "manifest"], options));
  if (!parsed.files?.length) throw new Error(`${parsed.name}: the manifest has no "files" (contract manifest 1.2.0)`);
  return parsed;
}

fs.rmSync(bundle, { recursive: true, force: true });
fs.mkdirSync(bundle, { recursive: true });
const analyzers = [];

// C#: a framework-dependent build runs on every platform; the runtime comes from the .NET Install Tool extension.
{
  const out = path.join(bundle, "csharp");
  run("dotnet", ["publish", "src/Nomos.Analyzer.CSharp", "-c", "Release", "--self-contained", "false",
    "-p:UseAppHost=false", "-p:SatelliteResourceLanguages=en", "-p:GenerateDocumentationFile=false", "-o", out, "-v", "q", "--nologo"],
  { cwd: path.join(repository, "analyzers", "csharp"), stdio: ["ignore", "inherit", "inherit"] });
  for (const file of fs.readdirSync(out).filter((f) => f.endsWith(".pdb") || f.endsWith(".xml"))) fs.rmSync(path.join(out, file));
  const config = JSON.parse(fs.readFileSync(path.join(out, "nomos-csharp.runtimeconfig.json"), "utf8"));
  const framework = config.runtimeOptions.framework ?? config.runtimeOptions.frameworks[0];
  const version = framework.version.split(".").slice(0, 2).join(".");
  const { language, files } = manifest("dotnet", [path.join(out, "nomos-csharp.dll")]);
  analyzers.push({
    language, files,
    command: ["${runtime}", "${bundle}/csharp/nomos-csharp.dll"],
    runtime: {
      name: `the .NET ${version} runtime`,
      extension: "ms-dotnettools.vscode-dotnet-runtime",
      command: "dotnet.acquire",
      argument: { version, mode: "runtime" },
      resultField: "dotnetPath",
    },
  });
}

// Go: a static binary for the target platform.
{
  const [goos, goarch] = goPlatforms[target];
  const name = goos === "windows" ? "nomos-go.exe" : "nomos-go";
  const cwd = path.join(repository, "analyzers", "go");
  run("go", ["build", "-trimpath", "-ldflags", "-s -w", "-o", path.join(bundle, "go", name), "./cmd/nomos-go"],
    { cwd, env: { ...process.env, GOOS: goos, GOARCH: goarch, CGO_ENABLED: "0" } });
  // The manifest comes from a build for this machine: the target binary may not run here.
  const { language, files } = manifest("go", ["run", "./cmd/nomos-go"], { cwd });
  analyzers.push({ language, files, command: [`\${bundle}/go/${name}`] });
}

// TypeScript and JavaScript: one program on the Node of VS Code (D-055). The compiler goes next to it rather than into
// node_modules, which vsce does not pack outside the extension's own dependencies; its lib.*.d.ts files must sit beside
// typescript.js, where the compiler looks for them.
{
  const source = path.join(repository, "analyzers", "typescript");
  const out = path.join(bundle, "typescript");
  const compiler = path.join(source, "node_modules", "typescript");
  fs.rmSync(path.join(source, "dist"), { recursive: true, force: true });
  run(process.execPath, [path.join(compiler, "bin", "tsc"), "-p", "tsconfig.build.json"], { cwd: source, stdio: ["ignore", "inherit", "inherit"] });
  fs.mkdirSync(path.join(out, "lib"), { recursive: true });
  for (const file of fs.readdirSync(path.join(source, "dist"))) {
    const text = fs.readFileSync(path.join(source, "dist", file), "utf8").replaceAll('from "typescript"', 'from "./lib/typescript.js"');
    fs.writeFileSync(path.join(out, file), text);
  }
  for (const file of ["rules.json", "practices.json"]) fs.copyFileSync(path.join(source, "src", file), path.join(out, file));
  fs.writeFileSync(path.join(out, "package.json"), JSON.stringify({ type: "module", private: true }) + "\n");
  fs.writeFileSync(path.join(out, "lib", "package.json"), JSON.stringify({ type: "commonjs", private: true }) + "\n");
  for (const file of fs.readdirSync(path.join(compiler, "lib")).filter((f) => f === "typescript.js" || /^lib\..*\.d\.ts$/.test(f))) {
    fs.copyFileSync(path.join(compiler, "lib", file), path.join(out, "lib", file));
  }
  fs.copyFileSync(path.join(compiler, "LICENSE.txt"), path.join(out, "lib", "LICENSE.txt"));
  for (const extra of [[], ["--language", "javascript"]]) {
    const { language, files } = manifest(process.execPath, [path.join(out, "main.js"), ...extra]);
    analyzers.push({ language, files, command: ["${node}", "${bundle}/typescript/main.js", ...extra] });
  }
}

fs.writeFileSync(path.join(bundle, "analyzers.json"), JSON.stringify({ analyzers }, null, 2) + "\n");
console.log(`bundle/analyzers.json: ${analyzers.map((a) => a.language).join(", ")}`);

if (!process.argv.includes("--bundle-only")) {
  run(process.execPath, [path.join(extension, "node_modules", "@vscode", "vsce", "vsce"), "package", "--target", target, "--allow-missing-repository", "--skip-license", "-o", `nomos-${target}.vsix`],
    { cwd: extension, stdio: ["ignore", "inherit", "inherit"] });
}
