import { randomBytes } from "node:crypto";
import path from "node:path";
import * as vscode from "vscode";
import type { AnalysisRun } from "../core/model";
import { buildGraph } from "../core/views";
import type { GraphLevel } from "../core/views";

let panel: vscode.WebviewPanel | undefined;

// Medium tones that read on light and dark themes. Red stays for cycles; the last color covers all deeper layers.
const LAYER_COLORS = ["#2f9e8f", "#3f8fdc", "#7a6fe0", "#c060c8", "#e0a020", "#8a9a2c", "#c07a50", "#8a94a6"];

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
  #bar { position: fixed; top: 0; left: 0; right: 0; padding: 8px; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; background: var(--vscode-editor-background); }
  button { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); border: 0; padding: 4px 10px; cursor: pointer; }
  button[aria-pressed="true"] { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  svg { width: 100%; height: 100%; display: block; cursor: grab; }
  line { stroke: var(--vscode-foreground); stroke-opacity: .25; vector-effect: non-scaling-stroke; }
  line.cycle { stroke: var(--vscode-errorForeground); stroke-opacity: .9; }
  circle { cursor: pointer; stroke: var(--vscode-editor-background); }
  circle.cycle { stroke: var(--vscode-errorForeground); }
  text { fill: var(--vscode-foreground); pointer-events: none; }
  .dim { opacity: .12; }
  .quiet text { display: none; }
  .quiet text.near { display: block; }
  #legend { display: flex; gap: 8px; flex-wrap: wrap; }
  #legend span { display: flex; gap: 4px; align-items: center; }
  #legend i { width: 10px; height: 10px; border-radius: 50%; }
  #legend i.cycle { box-sizing: border-box; border: 2px solid var(--vscode-errorForeground); }
${LAYER_COLORS.map((color, i) => `  .layer-${i} { fill: ${color}; background: ${color}; }`).join("\n")}
</style>
</head>
<body>
<div id="bar"><button data-level="module">Modules</button><button data-level="type">Types</button><span id="info"></span><div id="legend" data-colors="${LAYER_COLORS.length}"></div></div>
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
