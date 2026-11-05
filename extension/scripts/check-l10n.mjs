// Every text Nomos shows has a Russian translation (D-052): strings of the interface (calls of t), package.nls,
// rule and practice texts of spec, finding templates, and the reports of ci. Usage: npm run check-l10n.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const extension = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.resolve(extension, "..");
const problems = [];
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const relative = (file) => path.relative(repo, file).replaceAll("\\", "/");

// Calls that look up the interface strings: t("…"), t.template("…"), translate("…"), interfaceTranslator()("…").
const Lookups = new Set(["t", "t.template", "translate", "interfaceTranslator()"]);

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return ["test", "e2e", "node_modules"].includes(entry.name) ? [] : sourceFiles(file);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [file] : [];
  });
}

/** The strings a package looks up, with where they are; a lookup of something other than a literal is a problem. */
function lookups(dir) {
  const found = new Map();
  for (const file of sourceFiles(dir)) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      if (ts.isCallExpression(node) && Lookups.has(node.expression.getText(source)) && node.arguments.length > 0) {
        const where = `${relative(file)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
        const first = node.arguments[0];
        if (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) {
          if (!found.has(first.text)) found.set(first.text, where);
        } else problems.push(`${where}: the text to translate must be a literal, not ${first.getText(source)}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

const HOLE = /\{\{|\}\}|\{(\d+)(?:\|([^{}]*))?\}/g;
const holes = (text) => [...new Set([...text.matchAll(HOLE)].filter((m) => m[1] !== undefined).map((m) => Number(m[1])))].sort().join(",");

function checkTemplate(where, english, russian) {
  if (typeof russian !== "string" || !russian.trim()) return problems.push(`${where}: no Russian text`);
  if (holes(english) !== holes(russian)) problems.push(`${where}: the translation uses {${holes(russian)}}, the original {${holes(english)}}`);
  for (const m of russian.matchAll(HOLE)) if (m[2] !== undefined && m[2].split("|").length !== 3) problems.push(`${where}: ${m[0]} needs three forms`);
}

/** Every looked-up string is in the bundle, and the bundle has nothing else. */
function checkBundle(dir, bundleFile) {
  const used = lookups(dir);
  const bundle = fs.existsSync(bundleFile) ? read(bundleFile) : {};
  for (const [text, where] of [...used].sort()) {
    const entry = bundle[text];
    checkTemplate(`${where} "${text}"`, text, typeof entry === "object" ? entry?.message : entry);
  }
  for (const key of Object.keys(bundle).sort()) if (!used.has(key)) problems.push(`${relative(bundleFile)}: "${key}" is not used any more`);
  return used.size;
}

const strings = checkBundle(path.join(extension, "src"), path.join(extension, "l10n", "bundle.l10n.ru.json"));
const ciStrings = checkBundle(path.join(repo, "ci", "src"), path.join(repo, "ci", "l10n", "bundle.l10n.ru.json"));

// package.json: every text of the contributions is a %key% with English and Russian values.
const manifest = fs.readFileSync(path.join(extension, "package.json"), "utf8");
const nls = read(path.join(extension, "package.nls.json"));
const nlsRu = read(path.join(extension, "package.nls.ru.json"));
const keys = [...manifest.matchAll(/"%([^"%]+)%"/g)].map((m) => m[1]);
for (const key of keys) {
  if (!nls[key]) problems.push(`package.json: %${key}% is not in package.nls.json`);
  checkTemplate(`package.nls.ru.json "${key}"`, nls[key] ?? "", nlsRu[key]);
}
for (const key of Object.keys(nls)) if (!keys.includes(key)) problems.push(`package.nls.json: "${key}" is not used`);
const contributed = read(path.join(extension, "package.json")).contributes;
const plain = [
  ...contributed.commands.map((c) => c.title),
  ...Object.values(contributed.views).flat().map((v) => v.name),
  ...contributed.viewsContainers.activitybar.map((v) => v.title),
  ...Object.values(contributed.configuration.properties).map((p) => p.description ?? p.markdownDescription),
].filter((text) => typeof text === "string" && text !== "Nomos" && !/^%[^%]+%$/.test(text));
for (const text of plain) problems.push(`package.json: "${text}" is shown but not a %key% of package.nls.json`);

// Rule and practice texts, and finding templates, from spec (npm run spec-json writes these files).
for (const rule of read(path.join(extension, "rules.json"))) {
  const ru = rule.l10n?.ru;
  for (const field of ["title", "description", "rationale"]) checkTemplate(`spec/rules ${rule.id}.${field}`, rule[field], ru?.[field]);
  for (const [key, message] of Object.entries(rule.messages ?? {})) checkTemplate(`spec/rules ${rule.id}.messages.${key}`, message.text, message.ru);
}
for (const practice of read(path.join(extension, "practices.json"))) {
  for (const field of ["title", "description"]) checkTemplate(`spec/practices.yaml ${practice.id}.${field}`, practice[field], practice.l10n?.ru?.[field]);
}

if (problems.length) {
  for (const problem of problems) console.error(`FAIL  ${problem}`);
  console.error(`\n${problems.length} problem(s)`);
  process.exit(1);
}
console.log(`Russian texts are complete: ${strings} strings of the extension, ${ciStrings} of ci, ${keys.length} of package.json, spec rules and practices`);
