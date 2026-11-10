// Renders the score page outside VS Code and saves a screenshot, to check the layout with real facts (D-065).
//   npm run compile
//   node scripts/screenshot.mjs --facts <facts.json> [--sarif <log.sarif>] --out <file.png> [--module <id> [--unit <id>]]
//        [--theme light] [--locale ru] [--size 1400,2600]
// Findings come from the SARIF log through the core's reader (extension/out, after its npm run compile).
// The page, score.js and the data go to a folder next to the screenshot; nothing is written into the extension.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const score = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { scorePage } = require(path.join(score, "out", "ui", "page.js"));
const { scoreStrings } = require(path.join(score, "out", "ui", "strings.js"));
const { analyse } = require(path.join(score, "out", "core", "score.js"));
const { moduleOfTarget, moduleView, systemView } = require(path.join(score, "out", "core", "dashboard.js"));
const { localeOf, translator } = require(path.join(score, "out", "core", "l10n.js"));

const option = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const factsFile = option("facts"), out = option("out");
if (!factsFile || !out) {
  console.error("usage: node scripts/screenshot.mjs --facts <facts.json> [--sarif <log>] --out <file.png> [--module <id> [--unit <id>]] [--theme light] [--locale ru] [--size W,H]");
  process.exit(2);
}
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
const facts = read(factsFile);
let findings = [];
if (option("sarif")) {
  const { readFindings } = require(path.join(score, "..", "extension", "out", "core", "sarif.js"));
  findings = readFindings(read(option("sarif")), option("sarif"));
}
const analysis = analyse({ language: facts.analyzer.language, root: ".", facts, findings });
const unit = option("unit");
const target = unit ? moduleOfTarget(analysis, unit) : undefined;
const module = option("module") ?? target?.module;
const data = module ? moduleView(analysis, module, target?.unit) : systemView(analysis);
if (!data) throw new Error(`module ${module} is not in ${factsFile}`);

const locale = localeOf(option("locale") ?? "en");
const bundleFile = path.join(score, "l10n", `bundle.l10n.${locale}.json`);
const t = translator(fs.existsSync(bundleFile) ? read(bundleFile) : undefined, locale);
const strings = scoreStrings(t);

const light = option("theme") === "light";
const theme = light
  ? { fg: "#1f1f1f", bg: "#ffffff", desc: "#717171", btn2: "#e5e5e5", btn2Fg: "#3b3b3b", link: "#005fb8" }
  : { fg: "#cccccc", bg: "#1f1f1f", desc: "#9d9d9d", btn2: "#313131", btn2Fg: "#cccccc", link: "#4daafc" };
const variables = `:root{--vscode-foreground:${theme.fg};--vscode-editor-background:${theme.bg};--vscode-descriptionForeground:${theme.desc};--vscode-button-secondaryBackground:${theme.btn2};--vscode-button-secondaryForeground:${theme.btn2Fg};--vscode-textLink-foreground:${theme.link};--vscode-font-family:Segoe UI}`;
const message = { type: "score", data, runs: [facts.analyzer.language], run: 0, strings };
const host = `
window.acquireVsCodeApi = () => ({ postMessage(m) { if (m.type === "ready") setTimeout(() => window.postMessage(${JSON.stringify(message)}, "*"), 0); } });`;

const folder = path.resolve(path.dirname(out), "score-page");
fs.mkdirSync(folder, { recursive: true });
fs.copyFileSync(path.join(score, "media", "score.js"), path.join(folder, "score.js"));
const html = scorePage("n", "score.js", locale)
  .replace(`<style nonce="n">`, `<style nonce="n">${variables}\n`)
  .replace(`<body>`, light ? `<body class="vscode-light">` : `<body class="vscode-dark">`)
  .replace(`<script nonce="n" src`, `<script nonce="n">${host}</script>\n<script nonce="n" src`);
const page = path.join(folder, "index.html");
fs.writeFileSync(page, html);

const browsers = [process.env.BROWSER, "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome", "/usr/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
const browser = browsers.find((b) => b && fs.existsSync(b));
if (!browser) throw new Error("no Edge or Chrome found; set BROWSER");
execFileSync(browser, ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--window-size=${option("size") ?? "1400,2600"}`, "--virtual-time-budget=3000",
  `--screenshot=${path.resolve(out)}`, `--user-data-dir=${path.join(folder, "profile")}`, `file:///${page.replaceAll("\\", "/")}`], { stdio: "ignore" });
console.log(`${path.resolve(out)}: ${data.view} view`);
