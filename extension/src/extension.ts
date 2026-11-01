import fs from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import type { AnalysisRun, Finding } from "./core/model";
import { WorkspaceFileName, analyze, readWorkspace } from "./core/runner";
import { lensesFor } from "./core/views";
import { showGraph } from "./ui/graphPanel";
import { FindingsTree, ParadigmsTree, locationOf } from "./ui/trees";

/** What the end-to-end test reads; the extension has no other public surface. */
export interface NomosApi { runs(): AnalysisRun[]; errors(): string[] }

const severities: Record<Finding["level"], vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  note: vscode.DiagnosticSeverity.Information,
};

function workspaceFolders(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath).filter((f) => fs.existsSync(path.join(f, WorkspaceFileName)));
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

  function publish(): void {
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

    const total = runs.reduce((sum, run) => sum + run.findings.length, 0);
    const scores = runs.filter((r) => r.facts.health).map((r) => `${r.language} ${r.facts.health!.score}`).join(", ");
    status.text = `$(telescope) Nomos: ${total} findings${scores ? ` · health ${scores}` : ""}`;
    status.tooltip = "Statistics for your own analysis, not a verdict. Click to analyze again.";
    status.show();
  }

  async function analyzeAll(): Promise<void> {
    running?.abort();
    const controller = new AbortController();
    running = controller;
    const fresh: AnalysisRun[] = [];
    const failures: string[] = [];
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "Nomos: analyzing" }, async () => {
      for (const folder of workspaceFolders()) {
        try {
          const workspace = readWorkspace(folder);
          for (const analyzer of workspace.analyzers) {
            try {
              const run = await analyze(analyzer, folder, workspace, controller.signal);
              fresh.push(run);
              for (const d of run.facts.diagnostics) output.appendLine(`${run.language}: ${d.level}: ${d.file ? `${d.file}: ` : ""}${d.message}`);
            } catch (e) {
              failures.push((e as Error).message);
            }
          }
        } catch (e) {
          failures.push((e as Error).message);
        }
      }
    });
    if (running !== controller) return;
    running = undefined;
    runs = fresh;
    errors = failures;
    publish();
    for (const message of failures) {
      output.appendLine(`error: ${message}`);
      void vscode.window.showErrorMessage(`Nomos: ${message}`);
    }
    const partial = fresh.filter((r) => r.partial).map((r) => r.language);
    if (partial.length) void vscode.window.showWarningMessage(`Nomos: partial result for ${partial.join(", ")}: some files were not parsed. See the Nomos output.`);
  }

  context.subscriptions.push(
    output, diagnostics, status,
    vscode.window.registerTreeDataProvider("nomos.findings", findings),
    vscode.window.registerTreeDataProvider("nomos.paradigms", paradigms),
    vscode.languages.registerCodeLensProvider({ scheme: "file" }, lenses),
    vscode.commands.registerCommand("nomos.analyze", analyzeAll),
    vscode.commands.registerCommand("nomos.showGraph", () => showGraph(context, () => runs)),
    vscode.workspace.onDidSaveTextDocument((document) => {
      const own = path.basename(document.uri.fsPath) === WorkspaceFileName || path.basename(path.dirname(document.uri.fsPath)) === ".nomos";
      if (!own && vscode.workspace.getConfiguration("nomos").get<boolean>("analyzeOnSave", false)) void analyzeAll();
    }),
  );
  return { runs: () => runs, errors: () => errors };
}

export function deactivate(): void {}

