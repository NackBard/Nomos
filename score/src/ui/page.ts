// The score page without the VS Code API, so that it can also be rendered outside the editor for screenshots.
import type { Locale } from "../core/l10n";

/** The HTML of the score page; `script` is the URI of media/score.js as the page may load it. */
export function scorePage(nonce: string, script: string, locale: Locale): string {
  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'">
<title>Nomos Score</title>
<style nonce="${nonce}">
  /* Chart colors as tokens (dataviz reference palette): dark steps by default, light steps under a light theme. */
  body {
    --ink: var(--vscode-foreground);
    --ink-2: var(--vscode-descriptionForeground);
    --muted: #898781;
    --grid: #2c2c2a;
    --axis: #4a4a46;
    --card: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-foreground) 8%);
    --series-1: #3987e5;
    --series-2: #d95926;
    --series-3: #199e70;
    --low: #e66767;
    --mid: #77766f;
    --high: #3987e5;
    --zone: rgba(230, 103, 103, .12);
    --zone-2: rgba(137, 135, 129, .14);
    --line: rgba(255, 255, 255, .10);
  }
  body.vscode-light {
    --muted: #898781;
    --grid: #e1e0d9;
    --axis: #c3c2b7;
    --series-1: #2a78d6;
    --series-2: #eb6834;
    --series-3: #1baf7a;
    --low: #e34948;
    --mid: #a8a69e;
    --high: #2a78d6;
    --zone: rgba(227, 73, 72, .10);
    --zone-2: rgba(137, 135, 129, .14);
    --line: rgba(11, 11, 11, .10);
  }
  html, body { margin: 0; color: var(--ink); background: var(--vscode-editor-background); font: 13px var(--vscode-font-family, system-ui, sans-serif); }
  #app { padding: 12px 16px 40px; max-width: 1500px; margin: 0 auto; box-sizing: border-box; }
  header { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: baseline; margin-bottom: 4px; }
  h1 { font-size: 18px; font-weight: 600; margin: 0; }
  h2 { font-size: 13px; font-weight: 600; margin: 0 0 2px; }
  .about, .note { color: var(--ink-2); font-size: 12px; margin: 0 0 8px; }
  .note { margin: 0 0 12px; }
  button { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); border: 0; padding: 4px 10px; cursor: pointer; font: inherit; }
  select { color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border, transparent); padding: 3px 6px; font: inherit; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 190px), 1fr)); gap: 10px; margin-bottom: 12px; align-items: start; }
  .tile { background: var(--card); border: 1px solid var(--line); border-radius: 6px; padding: 10px 12px; }
  .tile .label { color: var(--ink-2); font-size: 12px; }
  .tile .value { font-size: 28px; font-weight: 600; line-height: 1.2; }
  .tile .value small { font-size: 12px; font-weight: 400; color: var(--ink-2); }
  .tile .about { margin: 2px 0 0; }
  .meter { height: 4px; background: var(--grid); border-radius: 2px; margin-top: 6px; overflow: hidden; }
  .meter > div { height: 100%; border-radius: 2px; }
  .parts { margin-top: 8px; display: grid; gap: 6px; }
  .part { font-size: 12px; }
  .part .row { display: flex; justify-content: space-between; gap: 8px; }
  .part .detail { color: var(--ink-2); font-size: 11px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 440px), 1fr)); gap: 12px; align-items: start; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 6px; padding: 10px 12px; min-width: 0; }
  .card.wide { grid-column: 1 / -1; }
  svg.chart { width: 100%; max-width: 640px; height: auto; display: block; margin: 0 auto; overflow: visible; }
  svg text { fill: var(--ink-2); font-size: 11px; }
  svg .tick { stroke: var(--grid); stroke-width: 1; }
  svg .axis { stroke: var(--axis); stroke-width: 1; }
  svg .sequence { stroke: var(--muted); stroke-width: 1.5; stroke-dasharray: 5 4; }
  svg .zone { fill: var(--zone); }
  svg .zone-2 { fill: var(--zone-2); }
  svg .dot { stroke: var(--vscode-editor-background); stroke-width: 1.5; cursor: pointer; }
  svg .dot.faded { opacity: .35; }
  svg .dot.selected { stroke: var(--ink); stroke-width: 2.5; }
  svg .curve { fill: none; stroke-width: 2; stroke-linejoin: round; }
  svg .bar { fill: var(--series-1); }
  svg .bar:hover, svg .dot:hover { filter: brightness(1.2); }
  svg .critical { stroke: var(--muted); stroke-width: 1; stroke-dasharray: 3 3; }
  svg .cross { stroke: var(--muted); stroke-width: 1; }
  svg .label-ink { fill: var(--ink); }
  .legend { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 12px; color: var(--ink-2); margin-top: 6px; }
  .legend span::before { content: ""; display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 5px; vertical-align: -1px; background: var(--swatch); }
  .legend .gradient::before { width: 60px; border-radius: 2px; background: linear-gradient(90deg, var(--low), var(--mid), var(--high)); }
  table { width: 100%; border-collapse: collapse; font-size: 12px; font-variant-numeric: tabular-nums; }
  th, td { text-align: right; padding: 4px 6px; border-bottom: 1px solid var(--line); white-space: nowrap; }
  th:first-child, td:first-child { text-align: left; white-space: normal; word-break: break-word; }
  th { color: var(--ink-2); font-weight: 600; cursor: pointer; user-select: none; position: sticky; top: 0; background: var(--card); }
  th[aria-sort="descending"]::after { content: " ↓"; }
  th[aria-sort="ascending"]::after { content: " ↑"; }
  tr.link { cursor: pointer; }
  tr.link:hover td { background: var(--vscode-list-hoverBackground); }
  tr.selected td { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .scroll { max-height: 420px; overflow: auto; }
  .problems { max-height: 540px; overflow: auto; }
  .chip { display: inline-block; width: 34px; height: 4px; border-radius: 2px; background: var(--grid); vertical-align: middle; margin-left: 6px; overflow: hidden; }
  .chip > i { display: block; height: 100%; }
  .problem { display: grid; grid-template-columns: 70px 1fr; gap: 2px 10px; padding: 6px 0; border-bottom: 1px solid var(--line); }
  .problem:last-child { border-bottom: 0; }
  .problem .lost { font-variant-numeric: tabular-nums; text-align: right; }
  .problem .lost .meter { margin-top: 3px; }
  .problem .what a, a.module { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; }
  .problem .what a:hover, a.module:hover { text-decoration: underline; }
  .problem .detail, .problem .hint { color: var(--ink-2); font-size: 12px; }
  .problem .hint { font-style: italic; }
  .empty { color: var(--ink-2); padding: 8px 0; }
  .links { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .links ul { list-style: none; padding: 0; margin: 4px 0 0; }
  .links li { display: flex; justify-content: space-between; gap: 8px; padding: 2px 0; }
  #tip { position: fixed; pointer-events: none; z-index: 10; max-width: 360px; padding: 5px 8px; font-size: 12px; border-radius: 4px;
    color: var(--vscode-editorHoverWidget-foreground, var(--ink)); background: var(--vscode-editorHoverWidget-background, var(--card));
    border: 1px solid var(--vscode-editorHoverWidget-border, var(--line)); display: none; white-space: pre-line; }
  @media (max-width: 520px) { .links { grid-template-columns: 1fr; } .tile .value { font-size: 22px; } }
</style>
</head>
<body>
<div id="app"></div>
<div id="tip"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}
