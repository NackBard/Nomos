import fs from "node:fs";
import path from "node:path";
import { parseJson } from "./contracts";
import type { AnalyzerConfig, Workspace } from "./model";

/**
 * Analyzers shipped inside the extension package (D-046). `scripts/bundle-analyzers.mjs` writes the registry
 * next to the binaries; the code here reads it as data and never names a language.
 */
export const RegistryFileName = "analyzers.json";
/** Folder of the extension package that holds the registry and the binaries. */
export const BundleFolderName = "bundle";

/** A program another VS Code extension provides on request, such as a language runtime. */
export interface RuntimeRequirement {
  /** Shown to the person when the runtime has to be installed. */
  name: string;
  /** Marketplace id of the extension that provides the runtime. */
  extension: string;
  /** Command of that extension; it receives `argument` plus `requestingExtensionId`. */
  command: string;
  argument: Record<string, unknown>;
  /** Field of the command's result that holds the executable path. */
  resultField: string;
}

export interface BundledAnalyzer {
  language: string;
  /**
   * `${bundle}` is the registry folder, `${runtime}` the executable from `runtime`, `${node}` the Node.js that runs the
   * extension: inside VS Code its own executable in Node mode, so nothing has to be installed (D-055).
   */
  command: string[];
  /** `files` of the analyzer's manifest, copied when the bundle was built. */
  files: string[];
  runtime?: RuntimeRequirement;
}

export interface Registry { analyzers: BundledAnalyzer[] }

/** The registry in `folder`, or undefined for a build without bundled analyzers. */
export function readRegistry(folder: string): Registry | undefined {
  const file = path.join(folder, RegistryFileName);
  if (!fs.existsSync(file)) return undefined;
  const registry = parseJson(fs.readFileSync(file, "utf8"), RegistryFileName) as Registry;
  if (!Array.isArray(registry?.analyzers)) throw new Error(`${RegistryFileName}: "analyzers" is not an array`);
  return registry;
}

/**
 * What runs in a folder without nomos.json: every bundled analyzer that has at least one file to read.
 * `hasFiles` answers whether any of the globs matches under the folder.
 */
export async function selectBundled(registry: Registry, hasFiles: (globs: string[]) => Promise<boolean>): Promise<BundledAnalyzer[]> {
  const selected: BundledAnalyzer[] = [];
  for (const analyzer of registry.analyzers) {
    if (await hasFiles(analyzer.files)) selected.push(analyzer);
  }
  return selected;
}

/**
 * The workspace an analyzer sees without nomos.json: the folder itself, default settings, plus the practices chosen
 * in the VS Code settings (D-050). `practices` in nomos.json appeared in 1.1.0.
 */
export function implicitWorkspace(config: AnalyzerConfig, practices?: string[]): Workspace {
  return practices === undefined ? { schemaVersion: "1.0.0", analyzers: [config] } : { schemaVersion: "1.1.0", analyzers: [config], practices };
}

/**
 * Writes the workspace file an analyzer gets through --config when there is no nomos.json, into the extension's storage.
 * `key` tells folders and languages apart; the file is rewritten before every run.
 */
export function writeWorkspaceFile(workspace: Workspace, storage: string, key: string): string {
  const folder = path.join(storage, "workspaces");
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `${key}.json`);
  fs.writeFileSync(file, JSON.stringify(workspace, null, 2) + "\n");
  return file;
}

/**
 * Turns a bundled analyzer into a launch configuration. The working directory is the extension's storage,
 * so the SARIF file does not land in the analyzed project.
 */
export function launchConfig(analyzer: BundledAnalyzer, bundleFolder: string, storage: string, runtimePath?: string): AnalyzerConfig {
  if (analyzer.runtime && !runtimePath) throw new Error(`${analyzer.language}: ${analyzer.runtime.name} is required`);
  const command = analyzer.command.map((part) => part.replaceAll("${bundle}", bundleFolder).replaceAll("${runtime}", runtimePath ?? "").replaceAll("${node}", process.execPath));
  // VS Code does not create an extension's storage folder; a missing working directory fails the start with ENOENT.
  fs.mkdirSync(storage, { recursive: true });
  // A package does not always keep the executable bit of a bundled program.
  if (process.platform !== "win32" && analyzer.command[0].startsWith("${bundle}") && fs.existsSync(command[0])) fs.chmodSync(command[0], 0o755);
  // The executable of VS Code is Electron; this variable makes it behave as plain Node. Node itself ignores it.
  const usesNode = analyzer.command.some((part) => part.includes("${node}"));
  return { language: analyzer.language, command, cwd: storage, ...(usesNode ? { env: { ELECTRON_RUN_AS_NODE: "1" } } : {}) };
}
