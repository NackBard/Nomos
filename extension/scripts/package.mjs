// Builds the core .vsix and a .vsix per language pack into dist/ (D-046, D-056, D-062).
//   node scripts/package.mjs [--target win32-x64] [--only nomos,nomos-go] [--bundle-only]   (target: this machine)
// This is build tooling, not shipped code: it may name languages. The shipped core reads only the registry entries
// of the packs and packs.json, both written here from each analyzer's own manifest.
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

// Python: the sources run on the person's interpreter in isolated mode (-I), the one the Python extension selected for
// the folder or one from PATH; the same files serve every platform (D-057). __pycache__ and tests stay out.
{
  const source = path.join(repository, "analyzers", "python");
  const out = path.join(bundle, "python");
  fs.mkdirSync(path.join(out, "nomos_python"), { recursive: true });
  fs.copyFileSync(path.join(source, "main.py"), path.join(out, "main.py"));
  for (const file of fs.readdirSync(path.join(source, "nomos_python")).filter((f) => f.endsWith(".py") || f.endsWith(".json"))) {
    fs.copyFileSync(path.join(source, "nomos_python", file), path.join(out, "nomos_python", file));
  }
  const { language, files } = manifest(process.execPath, [path.join(source, "run.mjs")]);
  analyzers.push({
    language, files,
    command: ["${runtime}", "-I", "${bundle}/python/main.py"],
    runtime: {
      name: "Python 3.10 or newer",
      extension: "ms-python.python",
      command: "python.interpreterPath",
      argument: { workspaceFolder: "${folder}" },
      path: ["python3", "python", "py"],
      check: ["-I", "-c", "import sys; sys.exit(sys.version_info < (3, 10))"],
      installUrl: "https://www.python.org/downloads/",
    },
  });
}

// Java: one jar for every platform (class files of release 17) runs on the person's JDK 17+: the folder the Java
// extension's settings name, then JAVA_HOME, then java from PATH. The check also needs the compiler module, which a JRE
// lacks, and fails on a JDK older than the class files (D-058).
{
  const out = path.join(bundle, "java");
  fs.mkdirSync(out, { recursive: true });
  const runner = path.join(repository, "analyzers", "java", "run.mjs");
  run(process.execPath, [runner, "--jar", path.join(out, "nomos-java.jar")], { stdio: ["ignore", "inherit", "inherit"] });
  const { language, files } = manifest(process.execPath, [runner]);
  analyzers.push({
    language, files,
    command: ["${runtime}", "-jar", "${bundle}/java/nomos-java.jar"],
    runtime: {
      name: "a JDK 17 or newer",
      settings: ["java.jdt.ls.java.home", "java.home"],
      environment: ["JAVA_HOME"],
      home: "bin/java",
      path: ["java"],
      check: ["--add-modules", "jdk.compiler", "-jar", "${bundle}/java/nomos-java.jar", "manifest"],
      installUrl: "https://adoptium.net/",
    },
  });
}

// Kotlin: the analyzer jar and the jars of the Kotlin compiler it parses with (kotlin-compiler-embeddable, about
// 60 MB, the same for every platform) run on the person's Java 17+, found as for Java. A JRE is enough: the check runs
// the manifest without asking for the compiler module (D-059). nomos-kotlin.jar names the other jars in its Class-Path.
{
  const out = path.join(bundle, "kotlin");
  const runner = path.join(repository, "analyzers", "kotlin", "run.mjs");
  run(process.execPath, [runner, "--bundle", out], { stdio: ["ignore", "inherit", "inherit"] });
  const { language, files } = manifest(process.execPath, [runner]);
  analyzers.push({
    language, files,
    command: ["${runtime}", "-jar", "${bundle}/kotlin/nomos-kotlin.jar"],
    runtime: {
      name: "Java 17 or newer",
      settings: ["java.jdt.ls.java.home", "java.home"],
      environment: ["JAVA_HOME"],
      home: "bin/java",
      path: ["java"],
      check: ["-jar", "${bundle}/kotlin/nomos-kotlin.jar", "manifest"],
      installUrl: "https://adoptium.net/",
    },
  });
}

// Ruby: the sources run on the person's Ruby 3.3+ from PATH (RubyInstaller on Windows, the shims of rbenv, asdf or mise
// elsewhere) without gems; Prism comes with Ruby 3.3. The same files serve every platform, tests stay out. The check
// runs the manifest, so a Ruby older than 3.3 or one without Prism does not pass (D-061).
{
  const source = path.join(repository, "analyzers", "ruby");
  const out = path.join(bundle, "ruby");
  fs.mkdirSync(path.join(out, "lib", "nomos_ruby"), { recursive: true });
  fs.copyFileSync(path.join(source, "main.rb"), path.join(out, "main.rb"));
  for (const file of fs.readdirSync(path.join(source, "lib", "nomos_ruby")).filter((f) => f.endsWith(".rb") || f.endsWith(".json"))) {
    fs.copyFileSync(path.join(source, "lib", "nomos_ruby", file), path.join(out, "lib", "nomos_ruby", file));
  }
  const { language, files } = manifest(process.execPath, [path.join(source, "run.mjs")]);
  analyzers.push({
    language, files,
    command: ["${runtime}", "--disable-gems", "${bundle}/ruby/main.rb"],
    runtime: {
      name: "Ruby 3.3 or newer",
      path: ["ruby"],
      check: ["--disable-gems", "${bundle}/ruby/main.rb", "manifest"],
      installUrl: "https://www.ruby-lang.org/en/documentation/installation/",
    },
  });
}

fs.writeFileSync(path.join(bundle, "analyzers.json"), JSON.stringify({ analyzers }, null, 2) + "\n");
console.log(`bundle/analyzers.json: ${analyzers.map((a) => a.language).join(", ")}`);

// Language packs (D-056, D-062): one extension per analyzer folder of the bundle, without code, that depends on the
// core and holds its registry entries under "nomos" in package.json. Only a pack with a native program is per target.
const packInfo = {
  csharp: { title: "C#" }, go: { title: "Go", native: true }, typescript: { title: "TypeScript and JavaScript" },
  python: { title: "Python" }, java: { title: "Java" }, kotlin: { title: "Kotlin" }, ruby: { title: "Ruby" },
};
const folderOf = (analyzer) => analyzer.command.find((part) => part.startsWith("${bundle}/")).split("/")[1];
for (const analyzer of analyzers) if (!packInfo[folderOf(analyzer)]) throw new Error(`${analyzer.language}: no language pack for bundle/${folderOf(analyzer)}`);
const packs = Object.keys(packInfo).map((folder) => ({ folder, name: `nomos-${folder}`, ...packInfo[folder], analyzers: analyzers.filter((a) => folderOf(a) === folder) }));

// The core knows the packs it can offer by name and files (D-062); the list is the same on every target.
const known = packs.map((pack) => ({ name: pack.name, analyzers: pack.analyzers.map(({ language, files }) => ({ language, files })) }));
fs.writeFileSync(path.join(extension, "packs.json"), JSON.stringify(known, null, 2) + "\n");
console.log(`packs.json: ${packs.map((p) => p.name).join(", ")}`);

if (!process.argv.includes("--bundle-only")) {
  const core = JSON.parse(fs.readFileSync(path.join(extension, "package.json"), "utf8"));
  const vsce = path.join(extension, "node_modules", "@vscode", "vsce", "vsce");
  const legal = [];
  const out = path.join(extension, "dist");
  fs.mkdirSync(out, { recursive: true });
  const onlyIndex = process.argv.indexOf("--only");
  const only = onlyIndex > 0 ? process.argv[onlyIndex + 1].split(",") : undefined;

  // The license of the repository goes into the core as a copy that git ignores; each pack gets its own below.
  fs.copyFileSync(path.join(repository, "LICENSE"), path.join(extension, "LICENSE"));
  // The core is the same on every platform: it carries no analyzer.
  if (!only || only.includes(core.name)) {
    run(process.execPath, [vsce, "package", ...legal, "-o", path.join(out, `${core.name}-${core.version}.vsix`)], { cwd: extension, stdio: ["ignore", "inherit", "inherit"] });
  }
  for (const pack of packs.filter((p) => !only || only.includes(p.name))) {
    const folder = path.join(extension, "packs", pack.name);
    fs.rmSync(folder, { recursive: true, force: true });
    fs.mkdirSync(folder, { recursive: true });
    fs.cpSync(path.join(bundle, pack.folder), path.join(folder, "bundle", pack.folder), { recursive: true });
    const manifest = {
      name: pack.name,
      displayName: `Nomos: ${pack.title}`,
      description: `${pack.title} analyzer for Nomos: statistics and heuristic observations, without verdicts.`,
      version: core.version,
      publisher: core.publisher,
      ...(core.license ? { license: core.license } : {}),
      ...(core.repository ? { repository: core.repository } : {}),
      ...(core.private ? { private: true } : {}),
      engines: core.engines,
      categories: ["Linters"],
      extensionDependencies: [`${core.publisher}.${core.name}`],
      files: ["bundle/**", "README.md", "LICENSE"],
      nomos: { analyzers: pack.analyzers },
    };
    fs.writeFileSync(path.join(folder, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
    fs.writeFileSync(path.join(folder, "README.md"), `# Nomos: ${pack.title}\n\nThe ${pack.title} analyzer of Nomos. It has no code of its own in VS Code: the Nomos extension, installed with it, runs the analyzer and shows the result.\n`);
    fs.copyFileSync(path.join(extension, "..", "LICENSE"), path.join(folder, "LICENSE"));
    const file = `${pack.name}-${pack.native ? target + "-" : ""}${core.version}.vsix`;
    run(process.execPath, [vsce, "package", ...(pack.native ? ["--target", target] : []), ...legal, "--no-dependencies", "-o", path.join(out, file)],
      { cwd: folder, stdio: ["ignore", "inherit", "inherit"] });
  }
}
