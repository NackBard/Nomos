import { randomBytes } from "node:crypto";
import path from "node:path";
import * as vscode from "vscode";
import type { AnalysisRun } from "../core/model";
import { buildFocus, buildGraph, neighbourGroup } from "../core/views";
import type { GraphLevel } from "../core/views";
import { graphPage } from "./graphPage";

let panel: vscode.WebviewPanel | undefined;
let level: GraphLevel = "module";
// The types level always shows one module or a pair of them; it stays remembered while the modules are shown.
let focus: { module: string; peer?: string } | undefined;
let runsOf: () => AnalysisRun[] = () => [];
let stale = false;

function page(webview: vscode.Webview, script: vscode.Uri): string {
  return graphPage(randomBytes(16).toString("hex"), webview.asWebviewUri(script).toString());
}

function send(): void {
  if (!panel) return;
  // A hidden page has no size to fit the graph to, so it gets the data when it is shown.
  stale = !panel.visible;
  if (stale) return;
  const shown = focus && buildFocus(runsOf(), focus.module, focus.peer);
  if (!shown) {
    focus = undefined;
    level = "module";
  }
  const graph = level === "type" && shown ? shown : buildGraph(runsOf());
  void panel.webview.postMessage({ type: "graph", level, focus, graph });
}

/** Shows fresh facts in the open graph, if there is one. */
export function refreshGraph(): void {
  send();
}

/** Shows code in the group next to the graph, reusing its preview tab; with no such group the graph's group is split. */
export async function openNextToGraph(file: vscode.Uri, line: number, graph: vscode.ViewColumn | undefined): Promise<vscode.TextEditor> {
  const groups = vscode.window.tabGroups.all.map((g) => g.viewColumn);
  const viewColumn = neighbourGroup(groups, graph) ?? vscode.ViewColumn.Beside;
  return vscode.window.showTextDocument(file, { selection: new vscode.Range(line, 0, line, 0), viewColumn, preview: true });
}

/** Opens the graph in a tab of its own, next to the code; the page asks for a level and receives only data from facts. */
export function showGraph(context: vscode.ExtensionContext, runs: () => AnalysisRun[], preserveFocus = false): void {
  runsOf = runs;
  if (panel) {
    panel.reveal(undefined, preserveFocus);
    return;
  }
  const media = vscode.Uri.joinPath(context.extensionUri, "media");
  panel = vscode.window.createWebviewPanel("nomos.graph", "Nomos: Dependency Graph", { viewColumn: vscode.ViewColumn.Beside, preserveFocus }, { enableScripts: true, localResourceRoots: [media], retainContextWhenHidden: true });
  panel.webview.html = page(panel.webview, vscode.Uri.joinPath(media, "graph.js"));
  panel.iconPath = vscode.Uri.joinPath(media, "icon.svg");
  panel.onDidDispose(() => (panel = undefined));
  panel.onDidChangeViewState(() => {
    if (stale) send();
  });
  panel.webview.onDidReceiveMessage(async (message: { type: string; level?: GraphLevel; module?: string; peer?: string; language?: string; file?: string; line?: number }) => {
    if (message.type === "level") {
      level = message.level === "type" && focus ? "type" : "module";
      if (level === "type" && focus) focus = { module: focus.module };
      send();
    } else if (message.type === "focus" && message.module) {
      focus = { module: message.module, peer: message.peer };
      level = "type";
      send();
    } else if (message.type === "open" && message.file) {
      const run = runs().find((r) => r.language === message.language);
      if (!run) return;
      const line = Math.max((message.line ?? 1) - 1, 0);
      await openNextToGraph(vscode.Uri.file(path.join(run.root, message.file)), line, panel?.viewColumn);
    }
  });
}

/** Moves the graph out of the main window, which keeps the whole screen for the code. */
export async function openGraphWindow(context: vscode.ExtensionContext, runs: () => AnalysisRun[]): Promise<void> {
  showGraph(context, runs);
  await vscode.commands.executeCommand("workbench.action.moveEditorToNewWindow");
}
