// Nomos Score (D-065): scores, Martin's diagram, percolation and the key problems of a system, over the analysis of the
// core extension (NomosApi). One tab shows the whole system or one module; the core's graph opens a module here on a
// double click through `nomos.inspect.command` of package.json. Nothing here knows a programming language.
import { randomBytes } from "node:crypto";
import path from "node:path";
import * as vscode from "vscode";
import type { ModuleView, SystemView } from "./core/dashboard";
import { moduleOfTarget, moduleView, systemView } from "./core/dashboard";
import { localeOf, translator } from "./core/l10n";
import type { Translate } from "./core/l10n";
import type { AnalysisRun } from "./core/model";
import { ordinal } from "./core/model";
import type { Analysis } from "./core/score";
import { analyse } from "./core/score";
import { scorePage } from "./ui/page";
import { scoreStrings } from "./ui/strings";

const CoreId = "honestarchitector.nomos";
const PanelType = "nomosScore.dashboard";

/** The part of the core API the scores use (extension/src/extension.ts). */
interface NomosApi { runs(): AnalysisRun[]; onDidAnalyze?: vscode.Event<void> }

/** What the core's graph sends on a double click (D-065). */
interface InspectTarget { language?: string; root?: string; role?: string; id?: string }

type Shown = { view: "system" } | { view: "module"; module: string; selected?: string };

let current: Translate | undefined;
function t(message: string, ...args: (string | number)[]): string {
  current ??= translator(vscode.l10n.bundle, localeOf(vscode.env.language));
  return current(message, ...args);
}

export function activate(context: vscode.ExtensionContext): void {
  let panel: vscode.WebviewPanel | undefined;
  let shown: Shown = { view: "system" };
  let runIndex = 0;
  let analyses: (Analysis | undefined)[] = [];
  let runs: AnalysisRun[] = [];
  let listening = false;
  let stale = false;

  async function core(): Promise<NomosApi> {
    const extension = vscode.extensions.getExtension<NomosApi>(CoreId);
    if (!extension) throw new Error(t("The Nomos extension is not installed; the scores read its analysis."));
    const api = extension.isActive ? extension.exports : await extension.activate();
    if (!listening && api.onDidAnalyze) {
      listening = true;
      context.subscriptions.push(api.onDidAnalyze(() => {
        load(api);
        send();
      }));
    }
    return api;
  }

  /** Runs in Ordinal order of language and root; analyses are computed when first shown. */
  function load(api: NomosApi): void {
    runs = [...api.runs()].sort((a, b) => ordinal(a.language, b.language) || ordinal(a.root, b.root));
    analyses = runs.map(() => undefined);
    if (runIndex >= runs.length) runIndex = 0;
  }

  function analysisOf(index: number): Analysis | undefined {
    if (!runs[index]) return undefined;
    return (analyses[index] ??= analyse(runs[index]));
  }

  function runLabels(): string[] {
    const roots = new Set(runs.map((r) => r.root));
    return runs.map((r) => (roots.size > 1 ? `${r.language} · ${path.basename(r.root)}` : r.language));
  }

  function send(): void {
    if (!panel) return;
    // A hidden page has no size to lay out, so it gets the data when it is shown.
    stale = !panel.visible;
    if (stale) return;
    const strings = scoreStrings(current ?? (current = translator(vscode.l10n.bundle, localeOf(vscode.env.language))));
    const analysis = analysisOf(runIndex);
    let data: SystemView | ModuleView | undefined;
    let missing: string | undefined;
    if (analysis && shown.view === "module") {
      data = moduleView(analysis, shown.module, shown.selected);
      if (!data) missing = shown.module;
    } else if (analysis) data = systemView(analysis);
    panel.title = shown.view === "module" && data ? t("Score: {0}", (data as ModuleView).module.name) : t("Nomos: Score");
    void panel.webview.postMessage({ type: "score", data, missing, runs: runLabels(), run: runIndex, strings });
  }

  function openPanel(preserveFocus = false): vscode.WebviewPanel {
    if (panel) {
      panel.reveal(undefined, preserveFocus);
      return panel;
    }
    const media = vscode.Uri.joinPath(context.extensionUri, "media");
    const created = vscode.window.createWebviewPanel(PanelType, t("Nomos: Score"), { viewColumn: vscode.ViewColumn.Beside, preserveFocus }, { enableScripts: true, localResourceRoots: [media], retainContextWhenHidden: true });
    created.webview.html = scorePage(randomBytes(16).toString("hex"), created.webview.asWebviewUri(vscode.Uri.joinPath(media, "score.js")).toString(), localeOf(vscode.env.language));
    created.iconPath = vscode.Uri.joinPath(media, "icon.svg");
    created.onDidDispose(() => (panel = undefined));
    created.onDidChangeViewState(() => {
      if (stale) send();
    });
    created.webview.onDidReceiveMessage(async (message: { type: string; id?: string; index?: number; file?: string; line?: number }) => {
      if (message.type === "ready") send();
      else if (message.type === "system") {
        shown = { view: "system" };
        send();
      } else if (message.type === "module" && message.id) {
        shown = { view: "module", module: message.id };
        send();
      } else if (message.type === "run" && typeof message.index === "number") {
        runIndex = Math.max(0, Math.min(runs.length - 1, message.index));
        shown = { view: "system" };
        send();
      } else if (message.type === "open" && message.file && runs[runIndex]) {
        const uri = vscode.Uri.file(path.join(runs[runIndex].root, message.file));
        const line = Math.max((message.line ?? 1) - 1, 0);
        const column = created.viewColumn === vscode.ViewColumn.One ? vscode.ViewColumn.Beside : vscode.ViewColumn.One;
        await vscode.window.showTextDocument(uri, { selection: new vscode.Range(line, 0, line, 0), viewColumn: column, preview: true });
      }
    });
    panel = created;
    return created;
  }

  /** The core's runs, analyzing first when there are none yet. */
  async function ready(): Promise<boolean> {
    const api = await core();
    load(api);
    if (runs.length) return true;
    await vscode.commands.executeCommand("nomos.analyze");
    load(api);
    return runs.length > 0;
  }

  async function showSystem(): Promise<void> {
    try {
      await ready();
      shown = { view: "system" };
      openPanel();
      send();
    } catch (e) {
      void vscode.window.showErrorMessage(`Nomos Score: ${(e as Error).message}`);
    }
  }

  async function inspect(target?: InspectTarget): Promise<void> {
    try {
      if (!(await ready())) {
        openPanel();
        send();
        return;
      }
      if (target?.id && target.role !== "folder") {
        const index = runs.findIndex((r) => r.language === target.language && (!target.root || r.root === target.root));
        const at = index >= 0 ? index : runIndex;
        const analysis = analysisOf(at);
        const found = analysis && moduleOfTarget(analysis, target.id);
        if (found) {
          runIndex = at;
          shown = { view: "module", module: found.module, selected: found.unit };
          openPanel();
          send();
          return;
        }
      }
      // From the command palette: choose a module of any run.
      const items = runs.flatMap((run, index) => run.facts.modules.map((m) => ({ label: m.name, description: m.id, detail: run.language, index, id: m.id })))
        .sort((a, b) => ordinal(a.detail, b.detail) || ordinal(a.description, b.description));
      const picked = await vscode.window.showQuickPick(items, { placeHolder: t("Module whose dashboard to open"), matchOnDescription: true });
      if (!picked) return;
      runIndex = picked.index;
      shown = { view: "module", module: picked.id };
      openPanel();
      send();
    } catch (e) {
      void vscode.window.showErrorMessage(`Nomos Score: ${(e as Error).message}`);
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("nomosScore.showSystem", showSystem),
    vscode.commands.registerCommand("nomosScore.inspect", inspect),
    vscode.commands.registerCommand("nomosScore.openWindow", async () => {
      if (!panel) await showSystem();
      else panel.reveal();
      await vscode.commands.executeCommand("workbench.action.moveEditorToNewWindow");
    }),
  );
}

export function deactivate(): void {}
