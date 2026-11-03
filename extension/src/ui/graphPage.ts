// The graph page without the VS Code API, so that it can also be rendered outside the editor for screenshots.

// Medium tones that read on light and dark themes. Red stays for cycles; the last color covers all deeper layers.
const LAYER_COLORS = ["#2f9e8f", "#3f8fdc", "#7a6fe0", "#c060c8", "#e0a020", "#8a9a2c", "#c07a50", "#8a94a6"];
// One color per kind of dependency in the facts contract.
const EDGE_COLORS: Record<string, string> = { inheritance: "#e0559a", call: "#e0a020", "type-ref": "#3f9fe0", import: "#38b070" };

/** The HTML of the graph page; `script` is the URI of media/graph.js as the page may load it. */
export function graphPage(nonce: string, script: string): string {
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
  button:disabled { opacity: .5; cursor: default; }
  #graph { width: 100%; height: 100%; display: block; cursor: grab; }
  .edge { fill: none; stroke: var(--vscode-foreground); stroke-opacity: .7; stroke-width: 1.25; pointer-events: none; vector-effect: non-scaling-stroke; }
  /* The kind of a link reads from its line, not from color alone: thick for inheritance, dashed for type use, dotted for imports. */
  .edge.kind-inheritance { stroke-width: 2.25; stroke-opacity: .9; }
  /* A fin is as thick as its line. */
  .head.kind-inheritance { stroke-width: 2.25; }
  .edge.kind-type-ref { stroke-dasharray: 5 3; }
  .edge.kind-import { stroke-dasharray: 1.5 3; stroke-linecap: round; }
  .halo { fill: none; stroke: var(--vscode-errorForeground); stroke-opacity: .35; stroke-width: 7; pointer-events: none; vector-effect: non-scaling-stroke; }
  /* A fin in the middle of the line: two short strokes pointing the way the link goes. */
  .head { fill: none; stroke-width: 1.25; stroke-linecap: round; stroke-linejoin: round; pointer-events: none; vector-effect: non-scaling-stroke; }
  .off { display: none; }
  .hit { fill: none; stroke: transparent; stroke-width: 12; pointer-events: stroke; vector-effect: non-scaling-stroke; }
  .hit.open { cursor: pointer; }
  .node { cursor: pointer; stroke: var(--vscode-editor-background); }
  .node.cycle { stroke: var(--vscode-errorForeground); }
  .node.peer { fill: var(--vscode-descriptionForeground); }
  text.peer { font-weight: 600; }
  text { fill: var(--vscode-foreground); text-anchor: middle; pointer-events: none; paint-order: stroke; stroke: var(--vscode-editor-background); stroke-width: 3px; }
  .dim { opacity: .12; }
  /* The types a line reaches in a folded module: present, but quieter than the names of nodes. */
  text.via { fill-opacity: .55; stroke-width: 2px; stroke-opacity: .8; }
  .busy text.via { display: none; }
  .busy text.via.near { display: block; }
  .quiet text { display: none; }
  .quiet text.near { display: block; }
  #legend { display: flex; gap: 8px; flex-wrap: wrap; }
  #legend span { display: flex; gap: 4px; align-items: center; }
  #legend i { width: 10px; height: 10px; border-radius: 50%; }
  #legend i.cycle { box-sizing: border-box; border: 2px solid var(--vscode-errorForeground); }
  #legend svg { width: 12px; height: 12px; fill: var(--vscode-foreground); }
  #legend button.link { display: flex; gap: 4px; align-items: center; padding: 2px 6px; color: var(--vscode-foreground); background: transparent; border: 1px solid transparent; }
  #legend button.link[aria-pressed="false"] { opacity: .45; text-decoration: line-through; }
  #legend button.link:hover { border-color: var(--vscode-descriptionForeground); }
  #legend button.link svg { width: 30px; height: 12px; fill: none; }
  /* Bottom right: the left columns hold what everything depends on and are the fullest. */
  #relations { position: fixed; right: 8px; bottom: 8px; max-width: min(460px, 60vw); max-height: 45vh; overflow: auto; padding: 6px 10px; line-height: 1.5;
    background: var(--vscode-editor-background); border: 1px solid var(--vscode-descriptionForeground); border-radius: 3px; }
  #relations:empty { display: none; }
  #relations b { display: block; }
  #relations .verb { color: var(--vscode-descriptionForeground); }
  #relations .hint { color: var(--vscode-descriptionForeground); }
${LAYER_COLORS.map((color, i) => `  .layer-${i} { fill: ${color}; background: ${color}; }`).join("\n")}
${Object.entries(EDGE_COLORS).map(([kind, color]) => `  .kind-${kind} { stroke: ${color}; }`).join("\n")}
</style>
</head>
<body>
<div id="bar"><button data-level="module">Modules</button><button data-level="type">Types</button><span id="info"></span><div id="legend" data-colors="${LAYER_COLORS.length}"></div></div>
<svg id="graph"></svg>
<div id="relations"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}
