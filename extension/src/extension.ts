import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import { createHash } from "node:crypto";
import { BundleFolderName, PacksFileName, collectRegistry, findRuntime, implicitWorkspace, launchConfig, missingPacks, readPacks, readRegistry, selectBundled, writeWorkspaceFile } from "./core/bundle";
import type { Registry, RuntimeHost, RuntimeRequirement } from "./core/bundle";
import type { AnalysisRun, AnalyzerConfig, Finding, Workspace } from "./core/model";
import { RulesFileName, localizeFinding, readRules } from "./core/l10n";
import type { Translate } from "./core/l10n";
import { PracticesFileName, choiceToStore, describePractices, practiceText, readPractices, unchosenPractices } from "./core/practices";
import { WorkspaceFileName, analyze, readWorkspace, writePractices } from "./core/runner";
import { confidenceText, lensesFor } from "./core/views";
import { exportClassDiagram } from "./ui/exportDiagram";
import type { DiagramTarget } from "./ui/exportDiagram";
import { openGraphWindow, refreshGraph, showGraph } from "./ui/graphPanel";
import { interfaceTranslator } from "./ui/translate";
import { FindingsTree, ParadigmsTree, locationOf } from "./ui/trees";
import type { TreeTexts } from "./ui/trees";

/** Language packs the person declined to be asked about again, kept in globalState (D-062). */
const DeclinedPacksKey = "nomos.declinedPacks";

/** What the end-to-end test and the agents extension read (D-063); the extension has no other public surface. */
export interface NomosApi { runs(): AnalysisRun[]; errors(): string[]; registry(): Registry; onDidAnalyze: vscode.Event<void> }

const severities: Record<Finding["level"], vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  note: vscode.DiagnosticSeverity.Information,
};

/** How findings look in the editor (`nomos.diagnostics`); undefined means they are not shown there, only in the tree. */
function diagnosticSeverity(finding: Finding): vscode.DiagnosticSeverity | undefined {
  switch (vscode.workspace.getConfiguration("nomos").get<string>("diagnostics", "hint")) {
    case "off": return undefined;
    case "information": return vscode.DiagnosticSeverity.Information;
    case "level": return severities[finding.level];
    default: return vscode.DiagnosticSeverity.Hint;
  }
}

function workspaceFolders(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
}

/** One analyzer to run in one folder; preparing it may ask for a runtime, so it is deferred and fails on its own. */
interface Planned { language: string; folder: string; prepare(): Promise<{ config: AnalyzerConfig; workspace: Workspace; configFile?: string }> }

/** Practices chosen for a folder without nomos.json (D-050); undefined means every practice. */
function settingPractices(folder: string): string[] | undefined {
  const value = vscode.workspace.getConfiguration("nomos", vscode.Uri.file(folder)).get<string[] | null>("practices");
  return Array.isArray(value) ? value : undefined;
}

/** The practices that apply in a folder: nomos.json decides when present, the setting otherwise. */
function folderPractices(folder: string): string[] | undefined {
  return fs.existsSync(path.join(folder, WorkspaceFileName)) ? readWorkspace(folder).practices : settingPractices(folder);
}

async function hasFiles(folder: string, globs: string[]): Promise<boolean> {
  for (const glob of globs) {
    if ((await vscode.workspace.findFiles(new vscode.RelativePattern(folder, glob), undefined, 1)).length) return true;
  }
  return false;
}

function toDiagnostic(finding: Finding, severity: vscode.DiagnosticSeverity, t: Translate): vscode.Diagnostic {
  const { range } = locationOf(finding);
  const diagnostic = new vscode.Diagnostic(range, t("{0} (heuristic, {1} confidence)", finding.message, confidenceText(finding.confidence, t)), severity);
  diagnostic.source = "nomos";
  diagnostic.code = finding.ruleId;
  return diagnostic;
}

/** Levels of facts diagnostics; the message itself is the analyzer's. */
function levelName(level: string, t: Translate): string {
  const names: Record<string, string> = { info: t("info"), warning: t("warning"), error: t("error") };
  return names[level] ?? level;
}

class MetricLens implements vscode.CodeLensProvider {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;

  constructor(private readonly runs: () => AnalysisRun[]) {}

  refresh(): void {
    this.changed.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!vscode.workspace.getConfiguration("nomos").get<boolean>("codeLens", true)) return [];
    return this.runs().flatMap((run) => {
      const file = path.relative(run.root, document.uri.fsPath).replaceAll("\\", "/");
      return lensesFor(run.facts, file).map((lens) => {
        const line = Math.min(lens.line - 1, document.lineCount - 1);
        return new vscode.CodeLens(new vscode.Range(line, 0, line, 0), { title: lens.text, command: "" });
      });
    });
  }
}

export function activate(context: vscode.ExtensionContext): NomosApi {
  let runs: AnalysisRun[] = [];
  let errors: string[] = [];
  let running: AbortController | undefined;

  const output = vscode.window.createOutputChannel("Nomos");
  const analyzedEvent = new vscode.EventEmitter<void>();
  const diagnostics = vscode.languages.createDiagnosticCollection("nomos");
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  status.command = "nomos.analyze";
  const findings = new FindingsTree();
  const paradigms = new ParadigmsTree();
  const lenses = new MetricLens(() => runs);
  const bundleFolder = context.asAbsolutePath(BundleFolderName);
  const storage = context.globalStorageUri.fsPath;
  const runtimes = new Map<string, Promise<string>>();
  const catalog = readPractices(context.asAbsolutePath(PracticesFileName));
  const rules = readRules(context.asAbsolutePath(RulesFileName));
  const knownPacks = readPacks(context.asAbsolutePath(PacksFileName));
  /** Packs offered in this session, so that each analysis does not ask again. */
  const offered = new Set<string>();
  /** Packs that would analyze files found by the last analysis, for the status bar tooltip. */
  let missingIds = new Set<string>();
  /** Whether an analysis has run, so that a change of extensions before it starts nothing. */
  let analyzed = false;
  const t = interfaceTranslator();
  const texts: TreeTexts = { t, rules, unchosen: (run, ruleId) => unchosenPractices(catalog, folderPractices(run.root), ruleId, t) };
  /** Practices per analyzed folder, for the status bar tooltip. */
  let practiceLines: string[] = [];

  /**
   * The program a runtime requirement names. A required runtime comes from its extension, installed on the person's
   * consent; an optional one (with `path`) is the extension's answer for the folder or a program in PATH (D-057).
   */
  function runtimePath(requirement: RuntimeRequirement, language: string, folder: string, bundle: string): Promise<string> {
    const optional = requirement.path !== undefined;
    const key = requirement.extension + "\n" + requirement.command + (optional ? "\n" + folder : "");
    const known = runtimes.get(key);
    if (known) return known;
    const pending = optional ? optionalRuntime(requirement, language, folder, bundle) : requiredRuntime(requirement, language);
    runtimes.set(key, pending);
    pending.catch(() => runtimes.delete(key));
    return pending;
  }

  async function requiredRuntime(requirement: RuntimeRequirement, language: string): Promise<string> {
    if (!vscode.extensions.getExtension((requirement.extension ?? ""))) {
      const install = t("Install");
      const choice = await vscode.window.showInformationMessage(
        t("Nomos needs {0} to analyze the {1} files of this workspace. The extension {2} provides it.", requirement.name, language, (requirement.extension ?? "")), install);
      if (choice !== install) throw new Error(t("{0}: skipped, {1} is not available (the extension {2} was not installed)", language, requirement.name, (requirement.extension ?? "")));
      await vscode.commands.executeCommand("workbench.extensions.installExtension", (requirement.extension ?? ""));
    }
    const result = await vscode.commands.executeCommand<Record<string, unknown> | undefined>(
      requirement.command ?? "", { ...requirement.argument, requestingExtensionId: context.extension.id });
    const value = requirement.resultField ? result?.[requirement.resultField] : result;
    if (typeof value !== "string" || !value) throw new Error(t("{0}: {1} did not provide {2}", language, requirement.extension ?? "", requirement.name));
    return value;
  }

  async function optionalRuntime(requirement: RuntimeRequirement, language: string, folder: string, bundle: string): Promise<string> {
    const host: RuntimeHost = {
      hasExtension: (id) => vscode.extensions.getExtension(id) !== undefined,
      execute: (command, argument) => Promise.resolve(vscode.commands.executeCommand(command, { ...argument, requestingExtensionId: context.extension.id })),
      setting: (key, folder) => vscode.workspace.getConfiguration(undefined, vscode.Uri.file(folder)).get(key),
      environment: (name) => process.env[name],
      usable: (program, args) => new Promise((resolve) => execFile(program, args, { timeout: 20000, windowsHide: true }, (error) => resolve(!error))),
    };
    const found = await findRuntime(requirement, folder, host, bundle);
    if (found) return found;
    const open = t("Open download page");
    const programs = (requirement.path ?? []).join(", ");
    const message = requirement.extension
      ? t("Nomos needs {0} to analyze the {1} files of this workspace. Neither the extension {2} nor PATH ({3}) gives one.", requirement.name, language, requirement.extension, programs)
      : t("Nomos needs {0} to analyze the {1} files of this workspace. None of the settings and variables {2} nor PATH ({3}) gives one.",
        requirement.name, language, [...(requirement.settings ?? []), ...(requirement.environment ?? [])].join(", "), programs);
    void vscode.window.showWarningMessage(message, ...(requirement.installUrl ? [open] : [])).then((choice) => {
      if (choice === open && requirement.installUrl) void vscode.env.openExternal(vscode.Uri.parse(requirement.installUrl));
    });
    throw new Error(t("{0}: skipped, {1} was not found", language, requirement.name));
  }

  /** The analyzers of the installed language packs, then those of the core's own bundle (D-062). */
  function registry(): Registry {
    const extensions = vscode.extensions.all.map((e) => ({ id: e.id, extensionPath: e.extensionPath, packageJSON: e.packageJSON as unknown }));
    return collectRegistry(extensions, readRegistry(bundleFolder), bundleFolder);
  }

  /** Offers the known packs whose files the folder has; each pack once a session, never after "Don't ask again". */
  async function offerPacks(folder: string, installed: Registry): Promise<void> {
    const publisher = String((context.extension.packageJSON as { publisher?: string }).publisher);
    const missing = await missingPacks(knownPacks, publisher, vscode.extensions.all.map((e) => e.id), installed, (globs) => hasFiles(folder, globs));
    for (const pack of missing) {
      missingIds.add(pack.id);
      const declined = context.globalState.get<string[]>(DeclinedPacksKey, []);
      if (offered.has(pack.id) || declined.includes(pack.id)) continue;
      offered.add(pack.id);
      const install = t("Install");
      const never = t("Don't ask again");
      void vscode.window.showInformationMessage(t("Nomos can analyze the {0} files of this workspace with the language pack {1}.", pack.languages.join(", "), pack.id), install, never)
        .then(async (choice) => {
          // Installing changes the extensions; the listener below analyzes again.
          if (choice === install) await vscode.commands.executeCommand("workbench.extensions.installExtension", pack.id);
          else if (choice === never) await context.globalState.update(DeclinedPacksKey, [...declined, pack.id]);
        });
    }
  }

  /** nomos.json decides when present; otherwise the installed analyzers that find their files (D-046, D-062). */
  async function plan(folder: string): Promise<Planned[]> {
    if (fs.existsSync(path.join(folder, WorkspaceFileName))) {
      const workspace = readWorkspace(folder);
      return workspace.analyzers.map((config) => ({ language: config.language, folder, prepare: async () => ({ config, workspace }) }));
    }
    const installed = registry();
    await offerPacks(folder, installed);
    const selected = await selectBundled(installed, (globs) => hasFiles(folder, globs));
    return selected.map((analyzer) => ({
      language: analyzer.language,
      folder,
      prepare: async () => {
        const runtime = analyzer.runtime ? await runtimePath(analyzer.runtime, analyzer.language, folder, analyzer.folder ?? bundleFolder) : undefined;
        const config = launchConfig(analyzer, bundleFolder, storage, runtime);
        const practices = settingPractices(folder);
        const workspace = implicitWorkspace(config, practices);
        if (practices === undefined) return { config, workspace };
        // Without nomos.json the chosen practices reach the analyzer through a workspace file of our own (D-050).
        const key = createHash("sha256").update(folder).digest("hex").slice(0, 16) + "-" + analyzer.language;
        return { config, workspace, configFile: writeWorkspaceFile(workspace, storage, key) };
      },
    }));
  }

  /** Findings in the editor; the setting only changes how they look, so a change needs no new analysis. */
  function showDiagnostics(): void {
    diagnostics.clear();
    const byFile = new Map<string, vscode.Diagnostic[]>();
    for (const run of runs) {
      for (const finding of run.findings) {
        const severity = diagnosticSeverity(finding);
        if (severity === undefined) return;
        const uri = vscode.Uri.file(path.join(run.root, finding.file));
        const list = byFile.get(uri.toString()) ?? [];
        list.push(toDiagnostic({ ...finding, file: uri.fsPath }, severity, t));
        byFile.set(uri.toString(), list);
      }
    }
    for (const [uri, list] of byFile) diagnostics.set(vscode.Uri.parse(uri), list);
  }

  function publish(planned = runs.length): void {
    showDiagnostics();
    findings.update(runs, texts);
    paradigms.update(runs, texts);
    lenses.refresh();
    refreshGraph();

    const total = runs.reduce((sum, run) => sum + run.findings.length, 0);
    const scores = runs.filter((r) => r.facts.health).map((r) => `${r.language} ${r.facts.health!.score}`).join(", ");
    if (planned === 0) {
      // "0 findings" here would read as a clean result although nothing ran.
      status.text = `$(telescope) ${t("Nomos: nothing to analyze")}`;
      status.tooltip = [t("No folder has a nomos.json or files that an installed analyzer reads. Click to analyze again."),
        ...(missingIds.size ? [t("Language packs for the files found: {0}", [...missingIds].join(", "))] : [])].join("\n");
    } else {
      const counted = total === 1 ? t("Nomos: {0} finding", total) : t("Nomos: {0} findings", total);
      status.text = `$(telescope) ${counted}${scores ? ` · ${t("health {0}", scores)}` : ""}`;
      status.tooltip = [t("Statistics for your own analysis, not a verdict. Click to analyze again."), ...practiceLines].join("\n");
    }
    status.show();
  }

  async function analyzeAll(): Promise<void> {
    running?.abort();
    const controller = new AbortController();
    running = controller;
    const fresh: AnalysisRun[] = [];
    const failures: string[] = [];
    let planned = 0;
    missingIds = new Set<string>();
    analyzed = true;
    const lines: string[] = [];
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: t("Nomos: analyzing") }, async () => {
      for (const folder of workspaceFolders()) {
        try {
          const chosen = describePractices(catalog, folderPractices(folder), t);
          lines.push(workspaceFolders().length > 1 ? t("Practices in {0}: {1}", path.basename(folder), chosen) : t("Practices: {0}", chosen));
          for (const item of await plan(folder)) {
            planned++;
            try {
              const { config, workspace, configFile } = await item.prepare();
              const run = await analyze(config, folder, workspace, controller.signal, configFile, t);
              fresh.push({ ...run, findings: run.findings.map((finding) => localizeFinding(finding, rules, t.locale)) });
              for (const d of run.facts.diagnostics) output.appendLine(`${run.language}: ${levelName(d.level, t)}: ${d.file ? `${d.file}: ` : ""}${d.message}`);
            } catch (e) {
              failures.push((e as Error).message);
            }
          }
        } catch (e) {
          planned++;
          failures.push((e as Error).message);
        }
      }
    });
    if (running !== controller) return;
    running = undefined;
    runs = fresh;
    errors = failures;
    practiceLines = lines;
    publish(planned);
    analyzedEvent.fire();
    for (const message of failures) {
      output.appendLine(`${levelName("error", t)}: ${message}`);
      void vscode.window.showErrorMessage(`Nomos: ${message}`);
    }
    const partial = fresh.filter((r) => r.partial).map((r) => r.language);
    if (partial.length) void vscode.window.showWarningMessage(t("Nomos: partial result for {0}: some files were not parsed. See the Nomos output.", partial.join(", ")));
  }

  /** Lets the person tick the practices to look at; the choice goes to nomos.json when the folder has one, else to the settings. */
  async function choosePractices(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const target = folders.length > 1 ? await vscode.window.showWorkspaceFolderPick({ placeHolder: t("Folder whose practices to choose") }) : folders[0];
    if (!target) return;
    const folder = target.uri.fsPath;
    const hasFile = fs.existsSync(path.join(folder, WorkspaceFileName));
    const current = new Set(folderPractices(folder) ?? catalog.map((p) => p.id));
    const items = catalog.map((p) => ({ label: practiceText(p, t).title, description: p.id, detail: practiceText(p, t).description, picked: current.has(p.id), id: p.id }));
    const picked = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      title: t("Nomos: practices to look at"),
      placeHolder: t("Rules of unticked practices do not run; metrics are shown either way"),
    });
    if (!picked) return;
    const chosen = choiceToStore(catalog, picked.map((p) => p.id));
    if (hasFile) {
      const write = t("Write to nomos.json");
      const answer = await vscode.window.showInformationMessage(t("{0} has nomos.json, which decides its practices. Write the choice into it?", path.basename(folder)), { modal: true }, write);
      if (answer !== write) return;
      writePractices(folder, chosen);
      await analyzeAll();
    } else {
      // The configuration listener runs the analysis.
      await vscode.workspace.getConfiguration("nomos", target.uri).update("practices", chosen, vscode.ConfigurationTarget.WorkspaceFolder);
    }
  }

  // The side bar icon opens the graph next to the code; there is nothing to draw before the first analysis.
  const findingsView = vscode.window.createTreeView("nomos.findings", { treeDataProvider: findings });
  findingsView.onDidChangeVisibility(({ visible }) => {
    if (!visible) return;
    showGraph(context, () => runs, true);
    if (!runs.length && !running) void analyzeAll();
  });

  context.subscriptions.push(
    output, analyzedEvent, diagnostics, status, findingsView,
    vscode.window.registerTreeDataProvider("nomos.paradigms", paradigms),
    vscode.languages.registerCodeLensProvider({ scheme: "file" }, lenses),
    vscode.commands.registerCommand("nomos.analyze", analyzeAll),
    vscode.commands.registerCommand("nomos.showGraph", () => showGraph(context, () => runs)),
    vscode.commands.registerCommand("nomos.openGraphWindow", () => openGraphWindow(context, () => runs)),
    vscode.commands.registerCommand("nomos.choosePractices", choosePractices),
    vscode.commands.registerCommand("nomos.exportClassDiagram", (target?: DiagramTarget) => exportClassDiagram(runs, target)),
    // A language pack installed, removed, enabled or disabled changes what can run (D-062).
    vscode.extensions.onDidChange(() => {
      if (analyzed && !running) void analyzeAll();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("nomos.practices")) void analyzeAll();
      if (event.affectsConfiguration("nomos.diagnostics")) showDiagnostics();
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      const own = path.basename(document.uri.fsPath) === WorkspaceFileName || path.basename(path.dirname(document.uri.fsPath)) === ".nomos";
      if (!own && vscode.workspace.getConfiguration("nomos").get<boolean>("analyzeOnSave", false)) void analyzeAll();
    }),
  );
  return { runs: () => runs, errors: () => errors, registry, onDidAnalyze: analyzedEvent.event };
}

export function deactivate(): void {}

