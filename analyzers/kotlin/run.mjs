// Builds the Kotlin analyzer when its sources changed and runs it on the first Java 17+ it finds: $NOMOS_JAVA (a java
// executable), $JAVA_HOME, then java from PATH. The analyzer is written in Kotlin and compiled by the CLI compiler
// inside kotlin-compiler-embeddable — the same jar it parses with — so neither kotlinc nor Gradle is needed (D-059).
// The jars come from Maven Central at the versions and hashes of deps.json and live in lib/ (not in git).
//
//   node run.mjs --fetch                  download the jars of deps.json into lib/ and check their hashes
//   node run.mjs [manifest | analyze …]   run the analyzer
//   node run.mjs --build                  only build build/classes
//   node run.mjs --bundle <folder>        the analyzer jar and the jars it needs, for the extension package
//   node run.mjs --test                   build and run the tests
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const exe = process.platform === "win32" ? ".exe" : "";
const sources = path.join(here, "src");
const tests = path.join(here, "test");
const classes = path.join(here, "build", "classes");
const testClasses = path.join(here, "build", "test-classes");
const lib = path.join(here, "lib");
const deps = JSON.parse(fs.readFileSync(path.join(here, "deps.json"), "utf8"));

const jarName = (dep) => path.basename(dep.path);
const jarOf = (artifact) => {
  const dep = deps.jars.find((d) => d.path.split("/").at(-3) === artifact);
  return path.join(lib, jarName(dep));
};
/** What the compiler itself needs to run as a compiler; the analyzer at run time needs only `runtime`. */
const compilerClassPath = deps.jars.map((d) => path.join(lib, jarName(d)));
const runtime = ["kotlin-compiler-embeddable", "kotlin-stdlib", "kotlinx-coroutines-core-jvm"].map(jarOf);

function digest(file, algorithm) {
  return crypto.createHash(algorithm).update(fs.readFileSync(file)).digest("hex");
}

function verified(dep) {
  const file = path.join(lib, jarName(dep));
  if (!fs.existsSync(file)) return false;
  if (digest(file, "sha1") !== dep.sha1) return false;
  return !dep.sha256 || digest(file, "sha256") === dep.sha256;
}

async function fetchJars() {
  fs.mkdirSync(lib, { recursive: true });
  for (const dep of deps.jars) {
    if (verified(dep)) continue;
    const url = `${deps.repository}/${dep.path}`;
    process.stderr.write(`fetch ${url}\n`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    const file = path.join(lib, jarName(dep));
    fs.writeFileSync(file + ".part", Buffer.from(await response.arrayBuffer()));
    fs.renameSync(file + ".part", file);
    if (!verified(dep)) {
      fs.rmSync(file);
      throw new Error(`${jarName(dep)}: hash differs from deps.json`);
    }
  }
}

function requireJars() {
  const missing = deps.jars.filter((d) => !verified(d)).map(jarName);
  if (missing.length === 0) return;
  process.stderr.write(`error: missing or changed jars in ${lib}: ${missing.join(", ")}; run node analyzers/kotlin/run.mjs --fetch\n`);
  process.exit(1);
}

/** A Java 17+ runtime; the compiler module is not needed (D-059). `jar` is there only in a JDK. */
function findJava() {
  const candidates = [];
  if (process.env.NOMOS_JAVA) candidates.push(process.env.NOMOS_JAVA);
  if (process.env.JAVA_HOME) candidates.push(path.join(process.env.JAVA_HOME, "bin", "java" + exe));
  candidates.push("java");
  for (const java of candidates) {
    const probe = spawnSync(java, ["-XshowSettings:properties", "-version"], { encoding: "utf8" });
    if (probe.status !== 0) continue;
    const version = /java\.specification\.version = (\d+)/.exec(probe.stderr ?? "");
    const home = /java\.home = (.+)/.exec(probe.stderr ?? "");
    if (!version || Number(version[1]) < 17 || !home) continue;
    return { java, jar: path.join(home[1].trim(), "bin", "jar" + exe) };
  }
  process.stderr.write(`error: no Java 17 or newer found (tried ${candidates.join(", ")}); set NOMOS_JAVA or JAVA_HOME\n`);
  process.exit(1);
}

function files(folder, extension) {
  if (!fs.existsSync(folder)) return [];
  return fs.readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(extension))
    .map((e) => path.join(e.parentPath ?? e.path, e.name))
    .sort();
}

function newest(list) {
  return Math.max(0, ...list.map((f) => fs.statSync(f).mtimeMs));
}

function compile(jvm, from, to, classPath) {
  const list = files(from, ".kt");
  const stamp = path.join(to, ".stamp");
  const inputs = [...list, ...files(from, ".json"), ...files(sources, ".kt"), ...files(sources, ".json")];
  if (fs.existsSync(stamp) && fs.statSync(stamp).mtimeMs >= newest(inputs)) return;
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(to, { recursive: true });
  const args = [
    "-cp", compilerClassPath.join(path.delimiter), "org.jetbrains.kotlin.cli.jvm.K2JVMCompiler",
    "-jvm-target", "17", "-no-stdlib", "-no-reflect", "-Werror",
    "-classpath", [...runtime, jarOf("annotations"), ...classPath].join(path.delimiter), "-d", to, ...list,
  ];
  const result = spawnSync(jvm.java, args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
  for (const file of files(from, ".json")) {
    const target = path.join(to, path.relative(from, file));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(file, target);
  }
  fs.writeFileSync(stamp, "");
}

const args = process.argv.slice(2);
if (args[0] === "--fetch") {
  await fetchJars();
  process.exit(0);
}
requireJars();
const jvm = findJava();
compile(jvm, sources, classes, []);
if (args[0] === "--build") process.exit(0);
if (args[0] === "--bundle") {
  // nomos-kotlin.jar names the other jars in its Class-Path, so `java -jar nomos-kotlin.jar` finds them beside it.
  const out = path.resolve(args[1]);
  fs.mkdirSync(out, { recursive: true });
  for (const jar of runtime) fs.copyFileSync(jar, path.join(out, path.basename(jar)));
  const manifest = path.join(here, "build", "MANIFEST.MF");
  fs.writeFileSync(manifest, `Main-Class: nomos.kotlin.MainKt\nClass-Path: ${runtime.map((j) => path.basename(j)).join(" ")}\n`);
  if (!fs.existsSync(jvm.jar)) {
    process.stderr.write(`error: ${jvm.jar} not found; packaging needs a JDK\n`);
    process.exit(1);
  }
  const result = spawnSync(jvm.jar, ["--create", "--file", path.join(out, "nomos-kotlin.jar"), "--manifest", manifest, "-C", classes, "."], { stdio: "inherit" });
  process.exit(result.status ?? 1);
}
if (args[0] === "--test") {
  compile(jvm, tests, testClasses, [classes]);
  const result = spawnSync(jvm.java, ["-cp", [testClasses, classes, ...runtime].join(path.delimiter), "nomos.kotlin.TestsKt", here], { stdio: "inherit" });
  process.exit(result.status ?? 1);
}
const result = spawnSync(jvm.java, ["-cp", [classes, ...runtime].join(path.delimiter), "nomos.kotlin.MainKt", ...args], { stdio: "inherit" });
process.exit(result.status ?? 1);
