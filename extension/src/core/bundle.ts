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

/**
 * A program the analyzer runs on, such as a language runtime: asked from another VS Code extension, read from VS Code
 * settings and environment variables that name its folder (D-058) and, when `path` is given, looked up among programs
 * in PATH (D-057). The extension knows no language; everything here is data.
 */
export interface RuntimeRequirement {
  /** Shown to the person when the runtime is missing. */
  name: string;
  /** Marketplace id of the extension that provides the runtime; without it no extension is asked (D-058). */
  extension?: string;
  /** Command of that extension; it receives `argument`, with `${folder}` in its strings replaced, plus `requestingExtensionId`. */
  command?: string;
  argument?: Record<string, unknown>;
  /** Field of the command's result that holds the executable path; without it the result is the path itself. */
  resultField?: string;
  /** VS Code settings, read for the folder, whose value is the folder the runtime is installed in (D-058). */
  settings?: string[];
  /** Environment variables whose value is that folder, tried after the settings. */
  environment?: string[];
  /** The program inside such a folder, `/`-separated and without the platform's executable suffix, such as `bin/tool`. */
  home?: string;
  /**
   * Programs looked up in PATH, in order, when the extension is not installed or gives no usable program. With them the
   * extension is optional: it is never installed on the person's behalf.
   */
  path?: string[];
  /** Arguments that make a program exit with code 0 only when it is usable, such as a version check; `${bundle}` is the registry folder. */
  check?: string[];
  /** Page that tells how to install the runtime, offered when no program is usable. */
  installUrl?: string;
}

/** What finding a runtime needs from VS Code and the system; the extension implements it, tests replace it. */
export interface RuntimeHost {
  hasExtension(id: string): boolean;
  execute(command: string, argument: Record<string, unknown>): Promise<unknown>;
  /** The value of a VS Code setting for the folder. */
  setting(key: string, folder: string): unknown;
  /** The value of an environment variable. */
  environment(name: string): string | undefined;
  /** Whether the program starts and exits with code 0 for these arguments. */
  usable(program: string, args: string[]): Promise<boolean>;
}

/** `argument` with `${folder}` replaced in every string, at any depth. */
export function runtimeArgument(value: unknown, folder: string): unknown {
  if (typeof value === "string") return value.replaceAll("${folder}", folder);
  if (Array.isArray(value)) return value.map((item) => runtimeArgument(item, folder));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, runtimeArgument(v, folder)]));
  return value;
}

/** A path a command returns quoted for a shell, as a plain path. */
function unquote(text: string): string {
  const trimmed = text.trim();
  return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
}

/** The program `home` names inside an installation folder, with the executable suffix of the platform. */
export function programIn(folder: string, home: string, platform: string = process.platform): string {
  const separator = platform === "win32" ? "\\" : "/";
  const base = folder.replace(/[\\/]+$/, "");
  return base + separator + home.split("/").join(separator) + (platform === "win32" ? ".exe" : "");
}

/**
 * The program of an optional runtime (one with `path`), the first that passes `check`: the extension's answer for the
 * folder, then the folders the settings and the environment variables name, then the programs in PATH; undefined when
 * none is usable.
 */
export async function findRuntime(requirement: RuntimeRequirement, folder: string, host: RuntimeHost, bundle = ""): Promise<string | undefined> {
  const check = (requirement.check ?? []).map((part) => part.replaceAll("${bundle}", bundle));
  if (requirement.extension && requirement.command && host.hasExtension(requirement.extension)) {
    try {
      const result = await host.execute(requirement.command, runtimeArgument(requirement.argument ?? {}, folder) as Record<string, unknown>);
      const value = requirement.resultField ? (result as Record<string, unknown> | undefined)?.[requirement.resultField] : result;
      if (typeof value === "string" && value.trim() && (await host.usable(unquote(value), check))) return unquote(value);
    } catch {
      // The extension could not answer; PATH may still have a program.
    }
  }
  if (requirement.home) {
    const homes = [
      ...(requirement.settings ?? []).map((key) => host.setting(key, folder)),
      ...(requirement.environment ?? []).map((name) => host.environment(name)),
    ];
    for (const home of homes) {
      if (typeof home !== "string" || !home.trim()) continue;
      const program = programIn(home.trim(), requirement.home);
      if (await host.usable(program, check)) return program;
    }
  }
  for (const program of requirement.path ?? []) {
    if (await host.usable(program, check)) return program;
  }
  return undefined;
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
  /** The folder `${bundle}` stands for: the `bundle` folder of the language pack; the core's own bundle when absent. */
  folder?: string;
}

export interface Registry { analyzers: BundledAnalyzer[] }

/** Key of a language pack's package.json that holds its registry entries (D-062). */
export const PackageKey = "nomos";

/** What VS Code tells about an installed extension; a language pack is one whose package.json has `nomos.analyzers`. */
export interface InstalledExtension { id: string; extensionPath: string; packageJSON: unknown }

/**
 * The command an installed extension offers for a double click on a node of the graph (`nomos.inspect.command` of its
 * package.json, D-065); extensions are read in id order and the first one wins. Undefined: a double click does nothing.
 */
export function inspectCommand(extensions: InstalledExtension[]): string | undefined {
  for (const extension of [...extensions].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const command = (extension.packageJSON as { [PackageKey]?: { inspect?: { command?: unknown } } } | undefined)?.[PackageKey]?.inspect?.command;
    if (typeof command === "string" && command) return command;
  }
  return undefined;
}

/**
 * The registry of the installed language packs (D-062), then the analyzers of the core's own bundle, which development
 * and e2e use. Packs are read in id order; a language goes to the first entry that names it. Nothing of a pack runs here.
 */
export function collectRegistry(extensions: InstalledExtension[], own: Registry | undefined, ownFolder: string): Registry {
  const analyzers: BundledAnalyzer[] = [];
  const languages = new Set<string>();
  const add = (analyzer: BundledAnalyzer, folder: string) => {
    if (languages.has(analyzer.language)) return;
    languages.add(analyzer.language);
    analyzers.push({ ...analyzer, folder });
  };
  const packs = [...extensions].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const extension of packs) {
    const entries = (extension.packageJSON as { [PackageKey]?: Registry } | undefined)?.[PackageKey]?.analyzers;
    if (!Array.isArray(entries)) continue;
    for (const analyzer of entries) add(analyzer, path.join(extension.extensionPath, BundleFolderName));
  }
  for (const analyzer of own?.analyzers ?? []) add(analyzer, analyzer.folder ?? ownFolder);
  return { analyzers };
}

/** A language pack the core knows of without it being installed: the name of its extension and the files it reads. */
export interface KnownPack { name: string; analyzers: { language: string; files: string[] }[] }

/** The list of known packs next to the core, written by the build from the analyzers' manifests (D-062). */
export const PacksFileName = "packs.json";

export function readPacks(file: string): KnownPack[] {
  if (!fs.existsSync(file)) return [];
  const packs = parseJson(fs.readFileSync(file, "utf8"), PacksFileName);
  if (!Array.isArray(packs)) throw new Error(`${PacksFileName}: expected an array of packs`);
  return packs as KnownPack[];
}

/** A pack to offer: its extension id, which is the core's publisher and the pack's name, and the languages it adds. */
export interface MissingPack { id: string; languages: string[] }

/**
 * The known packs worth offering for a folder: not installed, no analyzer in the registry for any of their languages,
 * and files of them in the folder. `hasFiles` answers whether any of the globs matches under the folder.
 */
export async function missingPacks(known: KnownPack[], publisher: string, installed: Iterable<string>, registry: Registry,
  hasFiles: (globs: string[]) => Promise<boolean>): Promise<MissingPack[]> {
  const ids = new Set([...installed].map((id) => id.toLowerCase()));
  const languages = new Set(registry.analyzers.map((a) => a.language));
  const missing: MissingPack[] = [];
  for (const pack of known) {
    const id = `${publisher}.${pack.name}`;
    if (ids.has(id.toLowerCase()) || pack.analyzers.some((a) => languages.has(a.language))) continue;
    const found: string[] = [];
    for (const analyzer of pack.analyzers) if (await hasFiles(analyzer.files)) found.push(analyzer.language);
    if (found.length) missing.push({ id, languages: found });
  }
  return missing;
}

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
export function launchConfig(analyzer: BundledAnalyzer, ownBundle: string, storage: string, runtimePath?: string): AnalyzerConfig {
  const bundleFolder = analyzer.folder ?? ownBundle;
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
