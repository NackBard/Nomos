// Builds the Java analyzer when its sources changed and runs it on the first JDK 17+ with jdk.compiler it finds:
// $NOMOS_JAVA (a java executable), $JAVA_HOME, then java from PATH. For the conformance harness, nomos.json and CI of
// this repository, where the command is fixed text on every platform; the extension finds the JDK itself through the
// runtime entry of its registry (D-058).
//
//   node run.mjs [manifest | analyze …]   run the analyzer
//   node run.mjs --build                  only build build/classes
//   node run.mjs --jar <file>             build a jar for the extension package
//   node run.mjs --test                   build and run the tests
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const exe = process.platform === "win32" ? ".exe" : "";
const sources = path.join(here, "src");
const tests = path.join(here, "test");
const classes = path.join(here, "build", "classes");
const testClasses = path.join(here, "build", "test-classes");

/** A JDK whose java has the compiler module and runs the analyzer's class files (release 17). */
function findJdk() {
  const candidates = [];
  if (process.env.NOMOS_JAVA) candidates.push(process.env.NOMOS_JAVA);
  if (process.env.JAVA_HOME) candidates.push(path.join(process.env.JAVA_HOME, "bin", "java" + exe));
  candidates.push("java");
  for (const java of candidates) {
    const probe = spawnSync(java, ["--add-modules", "jdk.compiler", "-XshowSettings:properties", "-version"], { encoding: "utf8" });
    if (probe.status !== 0) continue;
    const version = /java\.specification\.version = (\d+)/.exec(probe.stderr ?? "");
    const home = /java\.home = (.+)/.exec(probe.stderr ?? "");
    if (!version || Number(version[1]) < 17 || !home) continue;
    const javac = path.join(home[1].trim(), "bin", "javac" + exe);
    if (!fs.existsSync(javac)) continue;
    return { java, javac, jar: path.join(home[1].trim(), "bin", "jar" + exe) };
  }
  process.stderr.write(`error: no JDK 17 or newer found (tried ${candidates.join(", ")}); set NOMOS_JAVA or JAVA_HOME\n`);
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

function compile(jdk, from, to, classPath) {
  const list = files(from, ".java");
  const stamp = path.join(to, ".stamp");
  const inputs = [...list, ...files(from, ".json"), ...files(sources, ".java"), ...files(sources, ".json")];
  if (fs.existsSync(stamp) && fs.statSync(stamp).mtimeMs >= newest(inputs)) return;
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(to, { recursive: true });
  const args = ["--release", "17", "-encoding", "UTF-8", "-Xlint:all", "-Werror", "-d", to, ...(classPath ? ["-cp", classPath] : []), ...list];
  const result = spawnSync(jdk.javac, args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
  for (const file of files(from, ".json")) {
    const target = path.join(to, path.relative(from, file));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(file, target);
  }
  fs.writeFileSync(stamp, "");
}

const args = process.argv.slice(2);
const jdk = findJdk();
compile(jdk, sources, classes);
if (args[0] === "--build") process.exit(0);
if (args[0] === "--jar") {
  const result = spawnSync(jdk.jar, ["--create", "--file", args[1], "--main-class", "nomos.java.Main", "-C", classes, "."], { stdio: "inherit" });
  process.exit(result.status ?? 1);
}
if (args[0] === "--test") {
  compile(jdk, tests, testClasses, classes);
  const result = spawnSync(jdk.java, ["-cp", [testClasses, classes].join(path.delimiter), "nomos.java.Tests", here], { stdio: "inherit" });
  process.exit(result.status ?? 1);
}
const result = spawnSync(jdk.java, ["-cp", classes, "nomos.java.Main", ...args], { stdio: "inherit" });
process.exit(result.status ?? 1);
