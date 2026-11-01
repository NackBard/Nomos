// Runs every analyzer of a workspace file, as the extension does but without an IDE. Findings never change the
// outcome (D-021): only a run that could not produce a result is an error.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";

const contracts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../contracts");

export interface AnalyzerEntry {
  language: string;
  command: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutSeconds?: number;
}

export interface Run {
  language: string;
  facts: any;
  sarif: any;
  /** Files with syntax errors make the result partial; it is reported, not failed. */
  partial: boolean;
}

export interface RunFailure { language: string; message: string }

function validator(name: string): (document: unknown) => string | undefined {
  const ajv = new Ajv2020({ allErrors: false, strict: false });
  const schema = JSON.parse(fs.readFileSync(path.join(contracts, `${name}.schema.json`), "utf8"));
  const validate = ajv.compile(schema);
  return (document) => (validate(document) ? undefined : `${name}: ${ajv.errorsText(validate.errors)}`);
}

/** Runs the analyzers of the workspace file and writes <language>.facts.json and <language>.sarif to the output folder. */
export function runWorkspace(workspaceFile: string, outDir: string): { runs: Run[]; failures: RunFailure[] } {
  const workspacePath = path.resolve(workspaceFile);
  const folder = path.dirname(workspacePath);
  const workspace = JSON.parse(fs.readFileSync(workspacePath, "utf8"));
  const problem = validator("nomos")(workspace);
  if (problem) throw new Error(`${workspaceFile}: ${problem}`);
  const root = path.resolve(folder, workspace.root ?? ".");
  const checkFacts = validator("facts");
  fs.mkdirSync(outDir, { recursive: true });

  const runs: Run[] = [];
  const failures: RunFailure[] = [];
  for (const analyzer of workspace.analyzers as AnalyzerEntry[]) {
    const cwd = path.resolve(folder, analyzer.cwd ?? ".");
    const sarifFile = path.resolve(outDir, `${analyzer.language}.sarif`);
    // Relative, because the path is echoed in facts and facts carry no absolute paths.
    const sarifArgument = path.relative(cwd, sarifFile).replaceAll("\\", "/");
    const result = spawnSync(analyzer.command[0], [...analyzer.command.slice(1), "analyze", "--root", root, "--config", workspacePath, "--sarif", sarifArgument], {
      cwd, encoding: "utf8", maxBuffer: 1024 * 1024 * 1024, env: { ...process.env, ...analyzer.env }, timeout: (analyzer.timeoutSeconds ?? 300) * 1000,
    });
    if (result.error || (result.status !== 0 && result.status !== 4)) {
      failures.push({ language: analyzer.language, message: result.error?.message ?? `exit code ${result.status}: ${(result.stderr ?? "").trim().split("\n")[0]}` });
      continue;
    }
    const facts = JSON.parse(result.stdout);
    const invalid = checkFacts(facts);
    if (invalid) {
      failures.push({ language: analyzer.language, message: invalid });
      continue;
    }
    fs.writeFileSync(path.join(outDir, `${analyzer.language}.facts.json`), result.stdout);
    runs.push({ language: analyzer.language, facts, sarif: JSON.parse(fs.readFileSync(sarifFile, "utf8")), partial: result.status === 4 });
  }
  return { runs, failures };
}
