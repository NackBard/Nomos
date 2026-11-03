import fs from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import { BundleFolderName, implicitWorkspace, launchConfig, readRegistry, selectBundled } from "./core/bundle";
import type { RuntimeRequirement } from "./core/bundle";
import type { AnalysisRun, AnalyzerConfig, Finding, Workspace } from "./core/model";
import { WorkspaceFileName, analyze, readWorkspace } from "./core/runner";
import { lensesFor } from "./core/views";
import { openGraphWindow, refreshGraph, showGraph } from "./ui/graphPanel";
import { FindingsTree, ParadigmsTree, locationOf } from "./ui/trees";

/** What the end-to-end test reads; the extension has no other public surface. */
export interface NomosApi { runs(): AnalysisRun[]; errors(): string[] }

const severities: Record<Finding["level"], vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  note: vscode.DiagnosticSeverity.Information,
};

function workspaceFolders(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
}

/** One analyzer to run in one folder; preparing it may ask for a runtime, so it is deferred and fails on its own. */
interface Planned { language: string; folder: string; prepare(): Promise<{ config: AnalyzerConfig; workspace: Workspace }> }

async function hasFiles(folder: string, globs: string[]): Promise<boolean> {
  for (const glob of globs) {
    if ((await vscode.workspace.findFiles(new vscode.RelativePattern(folder, glob), undefined, 1)).length) return true;
  }
  return false;
}

function toDiagnostic(finding: Finding): vscode.Diagnostic {
  const { range } = locationOf(finding);
  const diagnostic = new vscode.Diagnostic(range, `${finding.message} (heuristic, ${finding.confidence} confidence)`, severities[finding.level]);
  diagnostic.source = "nomos";
  diagnostic.code = finding.ruleId;
  return diagnostic;
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
  const diagnostics = vscode.languages.createDiagnosticCollection("nomos");
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  status.command = "nomos.analyze";
  const findings = new FindingsTree();
  const paradigms = new ParadigmsTree();
  const lenses = new MetricLens(() => runs);
  const bundleFolder = context.asAbsolutePath(BundleFolderName);
  const storage = context.globalStorageUri.fsPath;
  const runtimes = new Map<string, Promise<string>>();

  /** Asks the extension that provides a runtime for its path, installing that extension on the person's consent. */
  function runtimePath(requirement: RuntimeRequirement, language: string): Promise<string> {
    const key = requirement.extension + "\n" + requirement.command;
    const known = runtimes.get(key);
    if (known) return known;
    const pending = (async () => {
      if (!vscode.extensions.getExtension(requirement.extension)) {
        const install = "Install";
        const choice = await vscode.window.showInformationMessage(
          `Nomos needs ${requirement.name} to analyze the ${language} files of this workspace. The extension ${requirement.extension} provides it.`, install);
        if (choice !== install) throw new Error(`${language}: skipped, ${requirement.name} is not available (the extension ${requirement.extension} was not installed)`);
        await vscode.commands.executeCommand("workbench.extensions.installExtension", requirement.extension);
      }
      const result = await vscode.commands.executeCommand<Record<string, unknown> | undefined>(
        requirement.command, { ...requirement.argument, requestingExtensionId: context.extension.id });
      const value = result?.[requirement.resultField];
      if (typeof value !== "string" || !value) throw new Error(`${language}: ${requirement.extension} did not provide ${requirement.name}`);
      return value;
    })();
    runtimes.set(key, pending);
    pending.catch(() => runtimes.delete(key));
    return pending;
  }

  /** nomos.json decides when present; otherwise the bundled analyzers that find their files (D-046). */
  async function plan(folder: string): Promise<Planned[]> {
    if (fs.existsSync(path.join(folder, WorkspaceFileName))) {
      const workspace = readWorkspace(folder);
      return workspace.analyzers.map((config) => ({ language: config.language, folder, prepare: async () => ({ config, workspace }) }));
    }
    const registry = readRegistry(bundleFolder);
    if (!registry) return [];
    const selected = await selectBundled(registry, (globs) => hasFiles(folder, globs));
    return selected.map((analyzer) => ({
      language: analyzer.language,
      folder,
      prepare: async () => {
        const runtime = analyzer.runtime ? await runtimePath(analyzer.runtime, analyzer.language) : undefined;
        const config = launchConfig(analyzer, bundleFolder, storage, runtime);
        return { config, workspace: implicitWorkspace(config) };
      },
    }));
  }

  function publish(planned = runs.length): void {
    diagnostics.clear();
    const byFile = new Map<string, vscode.Diagnostic[]>();
    for (const run of runs) {
      for (const finding of run.findings) {
        const uri = vscode.Uri.file(path.join(run.root, finding.file));
        const list = byFile.get(uri.toString()) ?? [];
        list.push(toDiagnostic({ ...finding, file: uri.fsPath }));
        byFile.set(uri.toString(), list);
      }
    }
    for (const [uri, list] of byFile) diagnostics.set(vscode.Uri.parse(uri), list);
    findings.update(runs);
    paradigms.update(runs);
    lenses.refresh();
    refreshGraph();

    const total = runs.reduce((sum, run) => sum + run.findings.length, 0);
    const scores = runs.filter((r) => r.facts.health).map((r) => `${r.language} ${r.facts.health!.score}`).join(", ");
    if (planned === 0) {
      // "0 findings" here would read as a clean result although nothing ran.
      status.text = "$(telescope) Nomos: nothing to analyze";
      status.tooltip = "No folder has a nomos.json or files that a bundled analyzer reads. Click to analyze again.";
    } else {
      status.text = `$(telescope) Nomos: ${total} findings${scores ? ` · health ${scores}` : ""}`;
      status.tooltip = "Statistics for your own analysis, not a verdict. Click to analyze again.";
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
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "Nomos: analyzing" }, async () => {
      for (const folder of workspaceFolders()) {
        try {
          for (const item of await plan(folder)) {
            planned++;
            try {
              const { config, workspace } = await item.prepare();
              const run = await analyze(config, folder, workspace, controller.signal);
              fresh.push(run);
              for (const d of run.facts.diagnostics) output.appendLine(`${run.language}: ${d.level}: ${d.file ? `${d.file}: ` : ""}${d.message}`);
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
    publish(planned);
    for (const message of failures) {
      output.appendLine(`error: ${message}`);
      void vscode.window.showErrorMessage(`Nomos: ${message}`);
    }
    const partial = fresh.filter((r) => r.partial).map((r) => r.language);
    if (partial.length) void vscode.window.showWarningMessage(`Nomos: partial result for ${partial.join(", ")}: some files were not parsed. See the Nomos output.`);
  }

  // The side bar icon opens the graph next to the code; there is nothing to draw before the first analysis.
  const findingsView = vscode.window.createTreeView("nomos.findings", { treeDataProvider: findings });
  findingsView.onDidChangeVisibility(({ visible }) => {
    if (!visible) return;
    showGraph(context, () => runs, true);
    if (!runs.length && !running) void analyzeAll();
  });

  context.subscriptions.push(
    output, diagnostics, status, findingsView,
    vscode.window.registerTreeDataProvider("nomos.paradigms", paradigms),
    vscode.languages.registerCodeLensProvider({ scheme: "file" }, lenses),
    vscode.commands.registerCommand("nomos.analyze", analyzeAll),
    vscode.commands.registerCommand("nomos.showGraph", () => showGraph(context, () => runs)),
    vscode.commands.registerCommand("nomos.openGraphWindow", () => openGraphWindow(context, () => runs)),
    vscode.workspace.onDidSaveTextDocument((document) => {
      const own = path.basename(document.uri.fsPath) === WorkspaceFileName || path.basename(path.dirname(document.uri.fsPath)) === ".nomos";
      if (!own && vscode.workspace.getConfiguration("nomos").get<boolean>("analyzeOnSave", false)) void analyzeAll();
    }),
  );
  return { runs: () => runs, errors: () => errors };
}

export function deactivate(): void {}

