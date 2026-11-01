import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ContractError, checkContract, parseJson } from "./contracts";
import type { AnalysisRun, AnalyzerConfig, Facts, Workspace } from "./model";
import { readFindings } from "./sarif";

export const WorkspaceFileName = "nomos.json";
const DefaultTimeoutSeconds = 300;
const SuccessCode = 0;
const PartialCode = 4;

export interface Manifest { name: string; language: string; version: string; capabilities: { sarif?: boolean } }

/** Why an analyzer did not produce a result; the codes are those of docs/ARCHITECTURE.md. */
export class AnalyzerError extends Error {}

const codeMeaning: Record<number, string> = {
  1: "unexpected analyzer error",
  2: "usage error",
  3: "the input is not usable",
};

export function readWorkspace(folder: string): Workspace {
  const file = path.join(folder, WorkspaceFileName);
  return checkContract<Workspace>("nomos", parseJson(fs.readFileSync(file, "utf8"), WorkspaceFileName), WorkspaceFileName);
}

interface Exit { code: number | null; stdout: string; stderr: string }

function run(config: AnalyzerConfig, folder: string, args: string[], signal?: AbortSignal): Promise<Exit> {
  return new Promise((resolve, reject) => {
    const [command, ...fixed] = config.command;
    const child = spawn(command, [...fixed, ...args], {
      cwd: config.cwd ? path.resolve(folder, config.cwd) : folder,
      env: { ...process.env, ...config.env },
      signal,
      timeout: (config.timeoutSeconds ?? DefaultTimeoutSeconds) * 1000,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => stdout.push(d));
    child.stderr.on("data", (d: Buffer) => stderr.push(d));
    child.on("error", (e) => reject(new AnalyzerError(`${config.language}: cannot start "${command}": ${e.message}`)));
    child.on("close", (code) => resolve({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
  });
}

function failure(config: AnalyzerConfig, command: string, exit: Exit): AnalyzerError {
  const meaning = exit.code === null ? "stopped or timed out" : codeMeaning[exit.code] ?? "unknown exit code";
  const detail = exit.stderr.trim().split("\n")[0];
  return new AnalyzerError(`${config.language}: "${command}" exited with ${exit.code} (${meaning})${detail ? `: ${detail}` : ""}`);
}

export async function readManifest(config: AnalyzerConfig, folder: string, signal?: AbortSignal): Promise<Manifest> {
  const exit = await run(config, folder, ["manifest"], signal);
  if (exit.code !== SuccessCode) throw failure(config, "manifest", exit);
  const manifest = checkContract<Manifest>("manifest", parseJson(exit.stdout, `${config.language} manifest`), `${config.language} manifest`);
  if (manifest.language !== config.language) throw new ContractError(`manifest language "${manifest.language}" differs from nomos.json "${config.language}"`);
  return manifest;
}

/** Runs one analyzer over the workspace root. The SARIF path is relative so facts carry no absolute path. */
export async function analyze(config: AnalyzerConfig, folder: string, workspace: Workspace, signal?: AbortSignal): Promise<AnalysisRun> {
  const manifest = await readManifest(config, folder, signal);
  const workingDirectory = config.cwd ? path.resolve(folder, config.cwd) : folder;
  const root = path.resolve(folder, workspace.root ?? ".");
  const sarifRelative = path.posix.join(".nomos", `${config.language}.sarif`);
  const sarifFile = path.join(workingDirectory, sarifRelative);
  const wantsSarif = manifest.capabilities.sarif !== false;
  const args = ["analyze", "--root", root, "--config", path.join(folder, WorkspaceFileName)];
  if (wantsSarif) {
    fs.mkdirSync(path.dirname(sarifFile), { recursive: true });
    fs.rmSync(sarifFile, { force: true });
    args.push("--sarif", sarifRelative);
  }

  const exit = await run(config, folder, args, signal);
  if (exit.code !== SuccessCode && exit.code !== PartialCode) throw failure(config, "analyze", exit);
  const facts = checkContract<Facts>("facts", parseJson(exit.stdout, `${config.language} facts`), `${config.language} facts`);
  if (facts.analyzer.language !== config.language) throw new ContractError(`facts language "${facts.analyzer.language}" differs from nomos.json "${config.language}"`);
  const findings = wantsSarif ? readFindings(parseJson(fs.readFileSync(sarifFile, "utf8"), `${config.language} SARIF`), `${config.language} SARIF`) : [];
  return { language: config.language, root, facts, findings, partial: exit.code === PartialCode };
}
