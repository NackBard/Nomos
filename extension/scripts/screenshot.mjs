// Renders the graph page outside VS Code and saves a screenshot, to check the layout with real facts (D-044, D-047).
//   npm run compile
//   node scripts/screenshot.mjs --facts <facts.json> --out <file.png> [--module <id> [--peer <id>]]
//        [--hover <node name>] [--hide <kind,kind>] [--theme light] [--size 1500,900] [--locale ru]
// Facts come from an analyzer: `dotnet bundle/csharp/nomos-csharp.dll analyze --root <project> > facts.json`
// (after `npm run package -- --bundle-only`). BROWSER overrides the path to Edge or Chrome.
// The page, graph.js and the data go to a folder next to the screenshot; nothing is written into the extension.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const extension = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { graphPage } = require(path.join(extension, "out", "ui", "graphPage.js"));
const { buildGraph, buildFocus } = require(path.join(extension, "out", "core", "views.js"));
const { graphStrings } = require(path.join(extension, "out", "ui", "graphStrings.js"));
const { localeOf, readBundle, translator } = require(path.join(extension, "out", "core", "l10n.js"));

const option = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const factsFile = option("facts"), out = option("out");
if (!factsFile || !out) {
  console.error("usage: node scripts/screenshot.mjs --facts <facts.json> --out <file.png> [--module <id> [--peer <id>]] [--hover <name>] [--hide <kinds>] [--theme light] [--size W,H] [--locale ru]");
  process.exit(2);
}
const module = option("module"), peer = option("peer");

// PowerShell redirection writes a BOM.
const facts = JSON.parse(fs.readFileSync(factsFile, "utf8").replace(/^\uFEFF/, ""));
const runs = [{ language: facts.analyzer.language, root: ".", facts, findings: [], partial: false }];
// The page is in the language of --locale, from the same bundle VS Code would load (D-052).
const locale = localeOf(option("locale") ?? "en");
const t = translator(readBundle(path.join(extension, "l10n", `bundle.l10n.${locale}.json`)), locale);
const strings = graphStrings(t);
const graph = module ? buildFocus(runs, module, peer, t) : buildGraph(runs);
if (!graph) throw new Error(`module ${module} is not in ${factsFile}`);
const level = module ? "type" : "module";

// The VS Code theme variables the page uses, for the default dark and light themes.
const theme = option("theme") === "light"
  ? { fg: "#1f1f1f", bg: "#ffffff", desc: "#717171", err: "#e51400", btn: "#005fb8", btnFg: "#fff", btn2: "#e5e5e5", btn2Fg: "#3b3b3b" }
  : { fg: "#cccccc", bg: "#1f1f1f", desc: "#9d9d9d", err: "#f85149", btn: "#0078d4", btnFg: "#fff", btn2: "#313131", btn2Fg: "#cccccc" };
const variables = `:root{--vscode-foreground:${theme.fg};--vscode-editor-background:${theme.bg};--vscode-descriptionForeground:${theme.desc};--vscode-errorForeground:${theme.err};--vscode-button-background:${theme.btn};--vscode-button-foreground:${theme.btnFg};--vscode-button-secondaryBackground:${theme.btn2};--vscode-button-secondaryForeground:${theme.btn2Fg};--vscode-font-family:Segoe UI}`;

// Stands in for the extension: answers the page's first request with the graph, then clicks the legend and hovers a node.
const hide = (option("hide") ?? "").split(",").filter(Boolean);
const hover = option("hover") ?? "";
const host = `
window.acquireVsCodeApi = () => ({ postMessage(message) {
  if (message.type === "level") setTimeout(() => window.postMessage({ type: "graph", level: ${JSON.stringify(level)}, focus: ${JSON.stringify(module ? { module, peer } : undefined)}, graph: ${JSON.stringify(graph)}, strings: ${JSON.stringify(strings)} }, "*"), 0);
} });
window.addEventListener("load", () => setTimeout(() => {
  for (const kind of ${JSON.stringify(hide.map((kind) => strings.kinds[kind]?.name ?? kind))}) [...document.querySelectorAll("#legend button.link")].find((b) => b.textContent === kind)?.click();
  const name = ${JSON.stringify(hover)};
  if (name) [...document.querySelectorAll("path.node")].find((p) => p.querySelector("title").textContent.split(" (")[0].endsWith(name))?.dispatchEvent(new MouseEvent("mouseenter"));
}, 300));`;

const folder = path.resolve(path.dirname(out), "screenshot-page");
fs.mkdirSync(folder, { recursive: true });
fs.copyFileSync(path.join(extension, "media", "graph.js"), path.join(folder, "graph.js"));
const html = graphPage("n", "graph.js", strings, locale)
  .replace(`<style nonce="n">`, `<style nonce="n">${variables}\n`)
  .replace(`<script nonce="n" src`, `<script nonce="n">${host}</script>\n<script nonce="n" src`);
const page = path.join(folder, "index.html");
fs.writeFileSync(page, html);

const browsers = [process.env.BROWSER, "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome", "/usr/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
const browser = browsers.find((b) => b && fs.existsSync(b));
if (!browser) throw new Error("no Edge or Chrome found; set BROWSER");
execFileSync(browser, ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--window-size=${option("size") ?? "1500,900"}`, "--virtual-time-budget=3000",
  `--screenshot=${path.resolve(out)}`, `--user-data-dir=${path.join(folder, "profile")}`, `file:///${page.replaceAll("\\", "/")}`], { stdio: "ignore" });
console.log(`${path.resolve(out)}: ${graph.nodes.length} nodes, ${graph.edges.length} edges`);
