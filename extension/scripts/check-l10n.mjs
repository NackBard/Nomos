// Every text Nomos shows has a translation (D-052, docs/TRANSLATING.md): strings of the interface (calls of t),
// package.nls, rule and practice texts of spec, finding templates, and the reports of ci. Usage: npm run check-l10n.
// Russian must be complete. Any other language with files (bundle.l10n.<lang>.json, package.nls.<lang>.json) is checked
// too: a broken template or a key nobody uses fails, a missing string only warns, since VS Code shows English for it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const extension = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.resolve(extension, "..");
const problems = [];
const warnings = [];
const Required = "ru";
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

/** Checks one translation; true when it is missing in a language that may be partial (the caller counts those). */
function checkTemplate(where, english, translated, locale = Required) {
  if (typeof translated !== "string" || !translated.trim()) {
    if (locale === Required) problems.push(`${where}: no Russian text`);
    return locale !== Required;
  }
  if (holes(english) !== holes(translated)) problems.push(`${where}: the translation uses {${holes(translated)}}, the original {${holes(english)}}`);
  for (const m of translated.matchAll(HOLE)) if (m[2] !== undefined && m[2].split("|").length !== 3) problems.push(`${where}: ${m[0]} needs three forms`);
}

const packages = [extension, path.join(repo, "ci"), path.join(repo, "agents"), path.join(repo, "score")];
const NAMED = /^(?:bundle\.l10n|package\.nls)\.([A-Za-z]{2,3}(?:-[A-Za-z0-9]+)?)\.json$/;
/** Russian, then every other language some package has files for, in Ordinal order. */
const locales = [Required, ...[...new Set(packages.flatMap((dir) => [dir, path.join(dir, "l10n")])
  .filter((dir) => fs.existsSync(dir))
  .flatMap((dir) => fs.readdirSync(dir).map((file) => NAMED.exec(file)?.[1]).filter(Boolean)))]
  .filter((locale) => locale !== Required).sort()];

/** Every looked-up string is in the bundle of each language, and a bundle has nothing else. */
function checkBundle(dir, l10nDir) {
  const used = lookups(dir);
  for (const locale of locales) {
    const bundleFile = path.join(l10nDir, `bundle.l10n.${locale}.json`);
    if (locale !== Required && !fs.existsSync(bundleFile)) {
      if (used.size) warnings.push(`${relative(bundleFile)}: missing, ${used.size} strings are shown in English`);
      continue;
    }
    const bundle = fs.existsSync(bundleFile) ? read(bundleFile) : {};
    let missing = 0;
    for (const [text, where] of [...used].sort()) {
      const entry = bundle[text];
      if (checkTemplate(`${where} "${text}" (${locale})`, text, typeof entry === "object" ? entry?.message : entry, locale)) missing++;
    }
    if (missing) warnings.push(`${relative(bundleFile)}: ${missing} of ${used.size} strings are not translated, English is shown`);
    for (const key of Object.keys(bundle).sort()) if (!used.has(key)) problems.push(`${relative(bundleFile)}: "${key}" is not used any more`);
  }
  return used.size;
}

const strings = checkBundle(path.join(extension, "src"), path.join(extension, "l10n"));
const ciStrings = checkBundle(path.join(repo, "ci", "src"), path.join(repo, "ci", "l10n"));
const agents = path.join(repo, "agents");
const agentStrings = checkBundle(path.join(agents, "src"), path.join(agents, "l10n"));
const score = path.join(repo, "score");
const scoreStrings = checkBundle(path.join(score, "src"), path.join(score, "l10n"));

/** package.json of an extension: every text of the contributions is a %key% with English and translated values. */
function checkManifest(dir) {
  const name = relative(path.join(dir, "package.json"));
  const manifest = fs.readFileSync(path.join(dir, "package.json"), "utf8");
  const nls = read(path.join(dir, "package.nls.json"));
  const keys = [...new Set([...manifest.matchAll(/"%([^"%]+)%"/g)].map((m) => m[1]))];
  for (const key of keys) if (!nls[key]) problems.push(`${name}: %${key}% is not in package.nls.json`);
  for (const locale of locales) {
    const file = path.join(dir, `package.nls.${locale}.json`);
    if (locale !== Required && !fs.existsSync(file)) {
      warnings.push(`${relative(file)}: missing, menus and settings are shown in English`);
      continue;
    }
    const translated = read(file);
    const missing = keys.filter((key) => checkTemplate(`${relative(file)} "${key}"`, nls[key] ?? "", translated[key], locale)).length;
    if (missing) warnings.push(`${relative(file)}: ${missing} of ${keys.length} texts are not translated, English is shown`);
    for (const key of Object.keys(translated)) if (!keys.includes(key)) problems.push(`${relative(file)}: "${key}" is not used`);
  }
  for (const key of Object.keys(nls)) if (!keys.includes(key)) problems.push(`${relative(path.join(dir, "package.nls.json"))}: "${key}" is not used`);
  const contributed = read(path.join(dir, "package.json")).contributes;
  const plain = [
    ...(contributed.commands ?? []).map((c) => c.title),
    ...Object.values(contributed.views ?? {}).flat().map((v) => v.name),
    ...(contributed.viewsContainers?.activitybar ?? []).map((v) => v.title),
    ...(contributed.chatParticipants ?? []).flatMap((p) => [p.description, ...(p.commands ?? []).map((c) => c.description)]),
    ...Object.values(contributed.configuration?.properties ?? {}).flatMap((p) => [p.description ?? p.markdownDescription, ...(p.enumDescriptions ?? [])]),
  ].filter((text) => typeof text === "string" && text !== "Nomos" && !/^%[^%]+%$/.test(text));
  for (const text of plain) problems.push(`${name}: "${text}" is shown but not a %key% of package.nls.json`);
  return keys.length;
}
const keyCount = checkManifest(extension) + checkManifest(agents) + checkManifest(score);

// Rule and practice texts, and finding templates, from spec (npm run spec-json writes these files).
for (const rule of read(path.join(extension, "rules.json"))) {
  const ru = rule.l10n?.ru;
  for (const field of ["title", "description", "rationale"]) checkTemplate(`spec/rules ${rule.id}.${field}`, rule[field], ru?.[field]);
  for (const [key, message] of Object.entries(rule.messages ?? {})) checkTemplate(`spec/rules ${rule.id}.messages.${key}`, message.text, message.ru);
}
for (const practice of read(path.join(extension, "practices.json"))) {
  for (const field of ["title", "description"]) checkTemplate(`spec/practices.yaml ${practice.id}.${field}`, practice[field], practice.l10n?.ru?.[field]);
}

for (const warning of warnings) console.warn(`WARN  ${warning}`);
if (problems.length) {
  for (const problem of problems) console.error(`FAIL  ${problem}`);
  console.error(`\n${problems.length} problem(s)`);
  process.exit(1);
}
const others = locales.filter((locale) => locale !== Required);
console.log(`Russian texts are complete: ${strings} strings of the extension, ${ciStrings} of ci, ${agentStrings} of agents, ${scoreStrings} of score, ${keyCount} of package.json, spec rules and practices`
  + (others.length ? `; also checked: ${others.join(", ")}, ${warnings.length} file(s) not complete` : ""));
