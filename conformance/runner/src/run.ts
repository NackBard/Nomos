import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import { activatingKinds, checkApplicability, checkParity, checkRequiredInputs, compareFacts } from "./compare.ts";
import type { CaseSpec } from "./compare.ts";
import { casesDir, repoRoot, rulesDir } from "./paths.ts";
import { checkSarif } from "./sarif.ts";
import { formatErrors, loadValidators, readJson } from "./schemas.ts";

export interface Analyzer { language: string; command: string[] }
export interface Check { name: string; errors: string[] }

function invoke(command: string[], args: string[]): { code: number | null; stdout: string; stderr: string } {
  const result = spawnSync(command[0], [...command.slice(1), ...args], { cwd: repoRoot, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (result.error) return { code: null, stdout: "", stderr: result.error.message };
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function parseJson(text: string): { value?: any; error?: string } {
  try {
    return { value: JSON.parse(text) };
  } catch (e) {
    return { error: `stdout is not JSON: ${(e as Error).message}` };
  }
}

interface SpecRule { category: string; paradigms: string[]; title: string; description: string; rationale: string; requires?: string[] }

function loadSpecRules(): { ids: Set<string>; byId: Map<string, SpecRule> } {
  const ids = new Set<string>();
  const byId = new Map<string, SpecRule>();
  for (const file of fs.readdirSync(rulesDir).filter((f) => f.endsWith(".yaml"))) {
    for (const rule of YAML.parse(fs.readFileSync(path.join(rulesDir, file), "utf8")).rules) {
      ids.add(rule.id);
      byId.set(rule.id, { category: rule.category, paradigms: rule.paradigms, title: rule.title, description: rule.description, rationale: rule.rationale, requires: rule.requires });
    }
  }
  return { ids, byId };
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}

function checkManifest(analyzer: Analyzer, validators: ReturnType<typeof loadValidators>, specRules: ReturnType<typeof loadSpecRules>): { check: Check; supported: Set<string>; manifest?: any } {
  const errors: string[] = [];
  const supported = new Set<string>();
  let valid: any;
  const run = invoke(analyzer.command, ["manifest"]);
  if (run.code !== 0) {
    errors.push(`"manifest" exited with ${run.code ?? "no code"}; stderr: ${firstLine(run.stderr)}`);
  } else {
    const parsed = parseJson(run.stdout);
    const validate = validators.get("manifest")!;
    if (parsed.error) errors.push(parsed.error);
    else if (!validate(parsed.value)) errors.push(...formatErrors(validate));
    else {
      const manifest = parsed.value;
      valid = manifest;
      if (manifest.language !== analyzer.language) errors.push(`manifest language is "${manifest.language}", the analyzer was registered for "${analyzer.language}"`);
      const ruleIds = new Set<string>(manifest.rules.map((r: any) => r.id));
      for (const id of manifest.capabilities.supportedRules as string[]) {
        supported.add(id);
        if (!ruleIds.has(id)) errors.push(`rule ${id} is in supportedRules but not in rules`);
      }
      for (const rule of manifest.rules as { id: string; category: string; paradigms: string[] }[]) {
        const spec = specRules.byId.get(rule.id);
        if (!spec) continue;
        // Applicability is decided by spec/rules: a different paradigm list would silently change where the rule runs.
        const own = [...rule.paradigms].sort().join(",");
        const shared = [...spec.paradigms].sort().join(",");
        if (own !== shared) errors.push(`rule ${rule.id}: manifest paradigms [${own}] differ from spec [${shared}]`);
        if (rule.category !== spec.category) errors.push(`rule ${rule.id}: manifest category "${rule.category}" differs from spec "${spec.category}"`);
      }
      for (const id of ruleIds) {
        if (!supported.has(id)) errors.push(`rule ${id} is in rules but not in supportedRules`);
        if (!id.includes(".") && !specRules.ids.has(id)) errors.push(`rule ${id} is not defined in spec/rules`);
      }
    }
  }
  return { check: { name: `${analyzer.language}: manifest`, errors }, supported, manifest: valid };
}

function analyze(analyzer: Analyzer, root: string, sarif?: string, config?: string): { facts?: any; errors: string[]; text?: string; code?: number } {
  const run = invoke(analyzer.command, ["analyze", "--root", root, ...(sarif ? ["--sarif", sarif] : []), ...(config ? ["--config", config] : [])]);
  if (run.code !== 0 && run.code !== 4) return { errors: [`"analyze" exited with ${run.code ?? "no code"} (expected 0 or 4); stderr: ${firstLine(run.stderr)}`] };
  const parsed = parseJson(run.stdout);
  return parsed.error ? { errors: [parsed.error] } : { facts: parsed.value, text: run.stdout, errors: [], code: run.code ?? undefined };
}

/** Runs every case for every registered analyzer. */
export function runConformance(analyzers: Analyzer[], only?: string): Check[] {
  const checks: Check[] = [];
  const validators = loadValidators();
  const specRules = loadSpecRules();
  const activating = activatingKinds(fs.readFileSync(path.join(repoRoot, "spec", "paradigms.md"), "utf8"));
  const caseIds = fs.existsSync(casesDir)
    ? fs.readdirSync(casesDir).filter((d) => fs.existsSync(path.join(casesDir, d, "case.json")) && (!only || d === only)).sort()
    : [];
  const supportedBy = new Map<string, Set<string>>();
  const manifests = new Map<string, any>();

  for (const analyzer of analyzers) {
    const { check, supported, manifest } = checkManifest(analyzer, validators, specRules);
    checks.push(check);
    supportedBy.set(analyzer.language, supported);
    if (manifest) manifests.set(analyzer.language, manifest);
  }

  for (const id of caseIds) {
    const spec = readJson(path.join(casesDir, id, "case.json")) as CaseSpec;
    const factsByLanguage = new Map<string, any>();
    for (const analyzer of analyzers.filter((a) => spec.languages.includes(a.language))) {
      const errors: string[] = [];
      const root = path.join(casesDir, id, analyzer.language, "src");
      // The SARIF path is relative to the repository root so that facts.checks.sarifFile carries no absolute path.
      const sarifRelative = path.posix.join("conformance", "runner", ".out", `${analyzer.language}-${id}.sarif`);
      const sarifFile = path.join(repoRoot, sarifRelative);
      fs.mkdirSync(path.dirname(sarifFile), { recursive: true });
      fs.rmSync(sarifFile, { force: true });
      const configFile = spec.config ? path.join(casesDir, id, analyzer.language, "nomos.json") : undefined;
      const first = analyze(analyzer, root, sarifRelative, configFile);
      errors.push(...first.errors);
      if (first.facts) {
        const validate = validators.get("facts")!;
        if (!validate(first.facts)) {
          errors.push(...formatErrors(validate).map((m) => `facts schema: ${m}`));
        } else {
          factsByLanguage.set(analyzer.language, first.facts);
          errors.push(...compareFacts(readJson(path.join(casesDir, id, analyzer.language, "expected.facts.json")), first.facts, spec));
          // Exit code 4 means a partial result: it is expected exactly when the reference marks a file as not parsed.
          const expectedFacts = readJson(path.join(casesDir, id, analyzer.language, "expected.facts.json"));
          const expectedCode = expectedFacts.files.some((f: any) => f.parsed === false) ? 4 : 0;
          if (first.code !== expectedCode) errors.push(`exit code is ${first.code}, expected ${expectedCode}`);
          const supported = supportedBy.get(analyzer.language) ?? new Set<string>();
          errors.push(...checkApplicability(first.facts, activating, [...supported].flatMap((ruleId) => {
            const rule = specRules.byId.get(ruleId);
            return rule ? [{ id: ruleId, paradigms: rule.paradigms }] : [];
          })));
          errors.push(...checkRequiredInputs(first.facts, configFile ? readJson(configFile) : undefined, [...supported].flatMap((ruleId) => {
            const rule = specRules.byId.get(ruleId);
            return rule ? [{ id: ruleId, requires: rule.requires }] : [];
          })));
          if (first.text!.includes(repoRoot) || first.text!.includes(repoRoot.replaceAll("\\", "/"))) errors.push("output contains an absolute path");
          const manifest = manifests.get(analyzer.language);
          if (manifest && fs.existsSync(sarifFile)) {
            const sarifText = fs.readFileSync(sarifFile, "utf8");
            const expectedFile = path.join(casesDir, id, analyzer.language, "expected.sarif.json");
            errors.push(...checkSarif(sarifText, {
              manifest,
              entities: new Map<string, Record<string, number | null>>([...first.facts.types, ...first.facts.functions].map((e: any) => [e.id, e.metrics])),
              sarifPath: sarifRelative,
              facts: first.facts,
              specRules: specRules.byId,
              expected: spec.expectSarif && fs.existsSync(expectedFile) ? readJson(expectedFile) : undefined,
              covers: new Set(spec.covers ?? []),
            }).map((m) => `sarif: ${m}`));
            const second = analyze(analyzer, root, sarifRelative, configFile);
            if (second.text !== first.text || fs.readFileSync(sarifFile, "utf8") !== sarifText) errors.push("two runs on the same input differ (output is not deterministic)");
          } else {
            if (manifest?.capabilities.sarif !== false && first.facts.checks === undefined) errors.push("--sarif was passed but facts.checks and the SARIF file are missing (capabilities.sarif is advertised)");
            const second = analyze(analyzer, root, sarifRelative, configFile);
            if (second.text !== first.text) errors.push("two runs on the same input differ (output is not deterministic)");
          }
        }
      }
      checks.push({ name: `${analyzer.language}: ${id}`, errors });
    }
    if (spec.parity?.length) checks.push({ name: `parity: ${id}`, errors: checkParity(spec, factsByLanguage) });
  }
  return checks;
}
