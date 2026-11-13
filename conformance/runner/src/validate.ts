import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { casesDir, contractsDir, practicesFile, repoRoot, rulesDir } from "./paths.ts";
import { generatedFiles } from "./go-rules.ts";
import { renderRulesDocs } from "./rules-doc.ts";
import { createAjv, formatErrors, loadValidators, readJson, schemaFiles } from "./schemas.ts";
import { placeholders, templateProblems } from "./l10n.ts";

/** Validates contracts, spec/rules and conformance cases. Returns error messages; empty means success. */
export function validateRepository(): string[] {
  const errors: string[] = [];

  // 1. Metavalidation: each contract is a valid JSON Schema 2020-12 and compiles on its own.
  const ajv = createAjv();
  for (const file of schemaFiles()) {
    const schema = readJson(path.join(contractsDir, file));
    try {
      ajv.compile(schema);
    } catch (e) {
      errors.push(`contracts/${file}: ${(e as Error).message}`);
      continue;
    }
    if (!/^1\.\d+\.\d+$/.test(schema["x-contractVersion"]) || !String(schema.$id).includes(`:${schema["x-contractVersion"]}:`)) {
      errors.push(`contracts/${file}: $id and x-contractVersion must carry the same version`);
    }
  }
  if (errors.length) return errors;
  const validators = loadValidators();

  // 2. spec/rules/*.yaml against rule.schema.json, plus cross-file rules.
  const seen = new Map<string, string>();
  for (const file of fs.readdirSync(rulesDir).filter((f) => f.endsWith(".yaml")).sort()) {
    const document = YAML.parse(fs.readFileSync(path.join(rulesDir, file), "utf8"));
    const validate = validators.get("rule")!;
    if (!validate(document)) {
      for (const message of formatErrors(validate)) errors.push(`spec/rules/${file}: ${message}`);
      continue;
    }
    for (const rule of document.rules) {
      if (seen.has(rule.id)) errors.push(`spec/rules/${file}: rule ${rule.id} is also defined in ${seen.get(rule.id)}`);
      seen.set(rule.id, file);
      const prefixed = rule.id.includes(".");
      if (document.language && !prefixed) {
        errors.push(`spec/rules/${file}: rule ${rule.id} of language "${document.language}" must carry a language prefix`);
      }
      if (!document.language && prefixed) errors.push(`spec/rules/${file}: ${rule.id} has a language prefix but the file sets no language`);
      errors.push(...messageProblems(rule).map((m) => `spec/rules/${file}: ${rule.id}: ${m}`));
    }
  }

  // 2a. spec/practices.yaml: valid, every id known, every rule in at least one practice (D-051).
  const practices = YAML.parse(fs.readFileSync(practicesFile, "utf8"));
  const validatePractices = validators.get("practice")!;
  if (!validatePractices(practices)) {
    for (const message of formatErrors(validatePractices)) errors.push(`spec/practices.yaml: ${message}`);
  } else {
    const ids = new Set<string>();
    const covered = new Set<string>();
    for (const practice of practices.practices) {
      if (ids.has(practice.id)) errors.push(`spec/practices.yaml: practice ${practice.id} is defined twice`);
      ids.add(practice.id);
      for (const rule of practice.rules) {
        if (!seen.has(rule)) errors.push(`spec/practices.yaml: practice ${practice.id} names rule ${rule}, which spec/rules does not define`);
        covered.add(rule);
      }
    }
    for (const rule of [...seen.keys()].sort()) {
      if (!covered.has(rule)) errors.push(`spec/practices.yaml: rule ${rule} belongs to no practice`);
    }
  }

  // 3. Conformance cases: case.json, expected files, required layout.
  if (fs.existsSync(casesDir)) {
    for (const id of fs.readdirSync(casesDir).sort()) {
      const dir = path.join(casesDir, id);
      if (!fs.statSync(dir).isDirectory()) continue;
      const caseFile = path.join(dir, "case.json");
      if (!fs.existsSync(caseFile)) {
        errors.push(`cases/${id}: case.json is missing`);
        continue;
      }
      const spec = readJson(caseFile);
      const validateCase = validators.get("conformance-case")!;
      if (!validateCase(spec)) {
        for (const message of formatErrors(validateCase)) errors.push(`cases/${id}/case.json: ${message}`);
        continue;
      }
      if (spec.id !== id) errors.push(`cases/${id}/case.json: id "${spec.id}" differs from the folder name`);
      for (const language of spec.languages as string[]) {
        const expected = path.join(dir, language, "expected.facts.json");
        if (!fs.existsSync(path.join(dir, language, "src"))) errors.push(`cases/${id}/${language}: src/ is missing`);
        if (!fs.existsSync(expected)) {
          errors.push(`cases/${id}/${language}: expected.facts.json is missing`);
          continue;
        }
        const validateFacts = validators.get("facts")!;
        if (!validateFacts(readJson(expected))) {
          for (const message of formatErrors(validateFacts)) errors.push(`cases/${id}/${language}/expected.facts.json: ${message}`);
        }
        if (spec.expectSarif && !fs.existsSync(path.join(dir, language, "expected.sarif.json"))) {
          errors.push(`cases/${id}/${language}: expectSarif is true but expected.sarif.json is missing`);
        }
      }
      for (const language of spec.config ? (spec.languages as string[]) : []) {
        const config = path.join(dir, language, "nomos.json");
        if (!fs.existsSync(config)) {
          errors.push(`cases/${id}/${language}: config is true but nomos.json is missing`);
          continue;
        }
        const validateConfig = validators.get("nomos")!;
        if (!validateConfig(readJson(config))) {
          for (const message of formatErrors(validateConfig)) errors.push(`cases/${id}/${language}/nomos.json: ${message}`);
        }
      }
      for (const parity of (spec.parity ?? []) as { metric: string; entities: Record<string, string> }[]) {
        for (const language of Object.keys(parity.entities)) {
          if (!spec.languages.includes(language)) errors.push(`cases/${id}/case.json: parity for "${parity.metric}" names language "${language}" that is not in languages`);
        }
      }
    }
  }

  // 4. The workspace file of this repository and the generated rule catalog.
  const workspace = path.join(repoRoot, "nomos.json");
  const validateWorkspace = validators.get("nomos")!;
  if (!validateWorkspace(readJson(workspace))) {
    for (const message of formatErrors(validateWorkspace)) errors.push(`nomos.json: ${message}`);
  }
  for (const { file, content } of renderRulesDocs()) {
    const documented = fs.existsSync(file) ? fs.readFileSync(file, "utf8").replaceAll("\r\n", "\n") : "";
    if (documented !== content) errors.push(`${path.relative(repoRoot, file).replaceAll("\\", "/")} is out of date: run npm run rules-doc`);
  }
  for (const { file, content } of generatedFiles()) {
    const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8").replaceAll("\r\n", "\n") : "";
    if (current !== content) errors.push(`${path.relative(repoRoot, file).replaceAll("\\", "/")} is out of date: run npm run spec-json`);
  }
  return errors;
}

/** Templates of a rule (spec/l10n.md): distinct English texts, the same arguments in every language, valid syntax. */
function messageProblems(rule: { messages?: Record<string, { text: string; ru?: string }> }): string[] {
  const problems: string[] = [];
  const texts = new Map<string, string>();
  for (const [key, message] of Object.entries(rule.messages ?? {})) {
    if (texts.has(message.text)) problems.push(`messages ${texts.get(message.text)} and ${key} have the same text; the key of a finding would be ambiguous`);
    texts.set(message.text, key);
    problems.push(...templateProblems(message.text, true).map((p) => `messages.${key}.text: ${p}`));
    if (message.ru === undefined) continue;
    problems.push(...templateProblems(message.ru, false).map((p) => `messages.${key}.ru: ${p}`));
    const english = [...placeholders(message.text)].sort().join(",");
    const russian = [...placeholders(message.ru)].sort().join(",");
    if (english !== russian) problems.push(`messages.${key}: ru uses arguments {${russian}}, text uses {${english}}`);
  }
  return problems;
}
