import { randomBytes } from "node:crypto";
import path from "node:path";
import * as vscode from "vscode";
import type { AnalysisRun } from "../core/model";
import { buildGraph } from "../core/views";
import type { GraphLevel } from "../core/views";

let panel: vscode.WebviewPanel | undefined;

function page(webview: vscode.Webview, script: vscode.Uri): string {
  const nonce = randomBytes(16).toString("hex");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'">
<title>Nomos graph</title>
<style nonce="${nonce}">
  html, body { height: 100%; margin: 0; overflow: hidden; color: var(--vscode-foreground); background: var(--vscode-editor-background); font: 12px var(--vscode-font-family); }
  #bar { position: fixed; top: 8px; left: 8px; display: flex; gap: 8px; align-items: center; }
  button { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); border: 0; padding: 4px 10px; cursor: pointer; }
  button[aria-pressed="true"] { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  svg { width: 100%; height: 100%; display: block; cursor: grab; }
  line { stroke: var(--vscode-foreground); stroke-opacity: .25; }
  line.cycle { stroke: var(--vscode-errorForeground); stroke-opacity: .9; }
  circle { fill: var(--vscode-charts-blue); cursor: pointer; }
  circle.cycle { fill: var(--vscode-errorForeground); }
  text { fill: var(--vscode-foreground); pointer-events: none; }
  .dim { opacity: .12; }
</style>
</head>
<body>
<div id="bar"><button data-level="module">Modules</button><button data-level="type">Types</button><span id="info"></span></div>
<svg id="graph"></svg>
<script nonce="${nonce}" src="${webview.asWebviewUri(script)}"></script>
</body>
</html>`;
}

/** Opens the graph; the page asks for a level and receives only data from facts. */
export function showGraph(context: vscode.ExtensionContext, runs: () => AnalysisRun[]): void {
  if (panel) {
    panel.reveal();
    return;
  }
  const media = vscode.Uri.joinPath(context.extensionUri, "media");
  panel = vscode.window.createWebviewPanel("nomos.graph", "Nomos: Dependency Graph", vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [media], retainContextWhenHidden: true });
  panel.webview.html = page(panel.webview, panel.webview.asWebviewUri(vscode.Uri.joinPath(media, "graph.js")));
  panel.onDidDispose(() => (panel = undefined));
  panel.webview.onDidReceiveMessage(async (message: { type: string; level?: GraphLevel; language?: string; file?: string; line?: number }) => {
    if (message.type === "level") {
      void panel?.webview.postMessage({ type: "graph", level: message.level, graph: buildGraph(runs(), message.level!) });
    } else if (message.type === "open" && message.file) {
      const run = runs().find((r) => r.language === message.language);
      if (!run) return;
      const line = Math.max((message.line ?? 1) - 1, 0);
      await vscode.window.showTextDocument(vscode.Uri.file(path.join(run.root, message.file)), { selection: new vscode.Range(line, 0, line, 0), viewColumn: vscode.ViewColumn.Beside });
    }
  });
}
