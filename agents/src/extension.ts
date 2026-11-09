// Nomos Agents (D-063): two agents over the Nomos analysis — review of paradigms and practices, and performance of
// functions — as chat participants and commands, plus the Nomos MCP server registered in VS Code. The data comes
// from the core extension (NomosApi); nothing here knows a programming language.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import type { AgentKind, AgentSummary } from "./core/agents";
import { buildRequest } from "./core/agents";
import { GitError } from "./core/git";
import type { Finding, Facts, PracticeText, RuleText, Scope, Snapshot } from "./core/model";
import type { Locale } from "./core/prompts";
import { SnapshotError, writeSnapshot } from "./core/snapshot";
import { ordinal } from "./core/select";
import type { Backend } from "./llm/backend";
import { BackendError } from "./llm/backend";
import { VsCodeLmBackend } from "./llm/vscodeLm";

const CoreId = "honestarchitector.nomos";
const KeySecret = "nomosAgents.anthropicApiKey";
const McpProviderId = "nomos-agents.mcp";
const SnapshotsFolder = "snapshots";

/** The part of the core API the agents use (extension/src/extension.ts). */
interface AnalysisRun { language: string; root: string; facts: Facts; findings: Finding[] }
interface NomosApi { runs(): AnalysisRun[]; onDidAnalyze?: vscode.Event<void> }

function t(message: string, ...args: (string | number)[]): string {
  return vscode.l10n.t(message, ...args);
}

function locale(): Locale {
  return vscode.env.language.toLowerCase().startsWith("ru") ? "ru" : "en";
}

function settings(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("nomosAgents");
}

function readCatalog<T>(file: string): T[] {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T[];
  } catch {
    return [];
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const storage = path.join(context.globalStorageUri.fsPath, SnapshotsFolder);
  const mcpChanged = new vscode.EventEmitter<void>();
  let listening = false;

  async function core(): Promise<NomosApi> {
    const extension = vscode.extensions.getExtension<NomosApi>(CoreId);
    if (!extension) throw new BackendError(t("The Nomos extension is not installed; the agents read its analysis."));
    const api = extension.isActive ? extension.exports : await extension.activate();
    if (!listening && api.onDidAnalyze) {
      listening = true;
      context.subscriptions.push(api.onDidAnalyze(() => saveSnapshots(api)));
    }
    return api;
  }

  /** One snapshot per analyzed root, with the rule and practice texts of the core. */
  function snapshots(api: NomosApi): Snapshot[] {
    const corePath = vscode.extensions.getExtension(CoreId)?.extensionPath;
    const rules = corePath ? readCatalog<RuleText>(path.join(corePath, "rules.json")) : [];
    const practices = corePath ? readCatalog<PracticeText>(path.join(corePath, "practices.json")) : [];
    const byRoot = new Map<string, Snapshot>();
    for (const run of api.runs()) {
      const snapshot = byRoot.get(run.root) ?? { root: run.root, runs: [], rules, practices };
      snapshot.runs.push({ language: run.language, facts: run.facts, findings: run.findings });
      byRoot.set(run.root, snapshot);
    }
    return [...byRoot.values()].sort((a, b) => ordinal(a.root, b.root));
  }

  /** The workspace folder an analyzed root belongs to, which names its snapshot folder for the MCP server. */
  function folderOf(root: string): string {
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root));
    return folder?.uri.fsPath ?? root;
  }

  function snapshotFolder(folder: string): string {
    return path.join(storage, createHash("sha256").update(folder).digest("hex").slice(0, 16));
  }

  function saveSnapshots(api: NomosApi): void {
    for (const snapshot of snapshots(api)) writeSnapshot(snapshotFolder(folderOf(snapshot.root)), snapshot);
    mcpChanged.fire();
  }

  /** The snapshot of the root that holds the active editor, else the first; analyzes once if there is none. */
  async function currentSnapshot(): Promise<Snapshot> {
    const api = await core();
    let found = snapshots(api);
    if (!found.length) {
      await vscode.commands.executeCommand("nomos.analyze");
      found = snapshots(api);
    }
    if (!found.length) throw new SnapshotError(t("Nomos has no analysis of this workspace: nothing to look at. See the Nomos status bar item."));
    saveSnapshots(api);
    const active = vscode.window.activeTextEditor?.document.uri.fsPath;
    return found.find((s) => active && !path.relative(s.root, active).startsWith("..")) ?? found[0];
  }

  async function backend(model?: vscode.LanguageModelChat): Promise<Backend> {
    if (settings().get<string>("provider", "vscode-lm") !== "anthropic") {
      return new VsCodeLmBackend(model, settings().get<string>("vscodeLm.family", ""), t("No language model is available in VS Code. Install a provider such as GitHub Copilot, or set nomosAgents.provider to anthropic."));
    }
    // Loaded only when chosen, so that the language model API path never loads the SDK.
    const { AnthropicBackend } = await import("./llm/anthropic");
    return new AnthropicBackend(await context.secrets.get(KeySecret), settings().get<string>("anthropic.model", "claude-opus-5-5"), settings().get("anthropic.effort", "high"), {
      refused: t("The model declined to answer this request."),
      cutOff: t("The answer reached the length limit and is cut off."),
      badKey: t("The Anthropic API rejected the key. Set it again with \"Nomos: Agents: Set Anthropic API Key\"."),
      failed: t("The Anthropic API returned an error:"),
    });
  }

  function summaryText(kind: AgentKind, summary: AgentSummary): string {
    const scope = summary.scope === "changes"
      ? t("Changed code against {0}: {1} files.", summary.baseDescription ?? "", summary.changedFiles)
      : t("All analyzed code.");
    const what = kind === "review" ? t("Functions to review: {0}, in the context: {1}.", summary.functions, summary.included)
      : t("Functions to estimate: {0}, in the context: {1}.", summary.functions, summary.included);
    const omitted = summary.omitted.length ? " " + t("{0} did not fit into the context (setting nomosAgents.contextCharacters).", summary.omitted.length) : "";
    return `${scope} ${what}${omitted}`;
  }

  function scopeSetting(kind: AgentKind): Scope {
    const value = settings().get<string>(kind === "review" ? "review.scope" : "performance.scope", kind === "review" ? "changes" : "all");
    return value === "all" ? "all" : "changes";
  }

  /** Builds the request; undefined when there is nothing to send, with the reason already shown. */
  async function prepare(kind: AgentKind, scope: Scope, question: string | undefined, show: (text: string) => void) {
    const snapshot = await currentSnapshot();
    const request = buildRequest(kind, snapshot, {
      scope,
      base: settings().get<string>("base", "") || undefined,
      maxCharacters: settings().get<number>("contextCharacters", 200_000),
      locale: locale(),
      question,
    });
    show(`_${summaryText(kind, request.summary)}_\n\n`);
    if (!request.summary.functions) {
      show(scope === "changes" ? t("No analyzed function overlaps the changes. Analyze again after saving, or use the scope \"all\".") : t("No function to look at."));
      return undefined;
    }
    return request;
  }

  function problemText(e: unknown): string {
    if (e instanceof BackendError || e instanceof GitError || e instanceof SnapshotError) return e.message;
    if (e instanceof vscode.LanguageModelError) return t("The language model returned an error: {0}", e.message);
    return t("Unexpected error: {0}", (e as Error).message ?? String(e));
  }

  function participant(kind: AgentKind): vscode.ChatRequestHandler {
    return async (request, _context, stream, token) => {
      const scope: Scope = request.command === "changes" || request.command === "all" ? request.command : scopeSetting(kind);
      try {
        stream.progress(t("Collecting the Nomos analysis…"));
        const built = await prepare(kind, scope, request.prompt, (text) => stream.markdown(text));
        if (!built) return {};
        const model = await backend(request.model);
        await model.send(built.system, built.user, (text) => stream.markdown(text), token);
        return {};
      } catch (e) {
        return { errorDetails: { message: problemText(e) } };
      }
    };
  }

  /** The command form: the answer goes into a new Markdown document, for people without a chat view. */
  async function runCommand(kind: AgentKind): Promise<void> {
    const fallback = scopeSetting(kind);
    const changed: vscode.QuickPickItem & { scope: Scope } = { label: t("Changed code"), description: t("against git"), scope: "changes" };
    const all: vscode.QuickPickItem & { scope: Scope } = { label: t("All code"), description: t("the whole analyzed root"), scope: "all" };
    // The scope of the settings comes first, so Enter keeps it.
    const items = fallback === "all" ? [all, changed] : [changed, all];
    const picked = await vscode.window.showQuickPick(items, { placeHolder: t("What should the agent look at?") });
    if (!picked) return;
    const title = kind === "review" ? t("Nomos Review") : t("Nomos Performance");
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (_progress, token) => {
      let text = `# ${title}\n\n`;
      try {
        const built = await prepare(kind, picked.scope, undefined, (part) => (text += part));
        if (built) {
          const model = await backend();
          await model.send(built.system, built.user, (part) => (text += part), token);
        }
      } catch (e) {
        text += `\n\n> ${problemText(e)}`;
      }
      const document = await vscode.workspace.openTextDocument({ language: "markdown", content: text });
      await vscode.window.showTextDocument(document, { preview: false });
    });
  }

  function registerMcp(): void {
    // Stable since VS Code 1.101; on older versions the MCP server is still usable by hand (agents/README.md).
    const lm = vscode.lm as typeof vscode.lm & { registerMcpServerDefinitionProvider?: typeof vscode.lm.registerMcpServerDefinitionProvider };
    if (!lm.registerMcpServerDefinitionProvider) return;
    const server = context.asAbsolutePath(path.join("out", "mcp", "server.js"));
    const version = String(context.extension.packageJSON.version ?? "0.0.0");
    context.subscriptions.push(lm.registerMcpServerDefinitionProvider(McpProviderId, {
      onDidChangeMcpServerDefinitions: mcpChanged.event,
      provideMcpServerDefinitions: () => (vscode.workspace.workspaceFolders ?? []).map((folder) =>
        // The extension host binary runs scripts as Node with ELECTRON_RUN_AS_NODE, so no Node install is needed.
        new vscode.McpStdioServerDefinition(`Nomos (${folder.name})`, process.execPath,
          [server, "--snapshot", snapshotFolder(folder.uri.fsPath), "--root", folder.uri.fsPath, "--locale", locale()],
          { ELECTRON_RUN_AS_NODE: "1" }, version)),
    }));
  }

  const review = vscode.chat.createChatParticipant("nomos-agents.review", participant("review"));
  const performance = vscode.chat.createChatParticipant("nomos-agents.performance", participant("performance"));
  review.iconPath = performance.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "icon.png");
  context.subscriptions.push(
    review, performance, mcpChanged,
    vscode.commands.registerCommand("nomosAgents.review", () => runCommand("review")),
    vscode.commands.registerCommand("nomosAgents.performance", () => runCommand("performance")),
    vscode.commands.registerCommand("nomosAgents.setAnthropicKey", async () => {
      const key = await vscode.window.showInputBox({ prompt: t("Anthropic API key; it is kept in the secret storage of VS Code."), password: true, ignoreFocusOut: true });
      if (key) await context.secrets.store(KeySecret, key.trim());
    }),
    vscode.commands.registerCommand("nomosAgents.clearAnthropicKey", () => context.secrets.delete(KeySecret)),
  );
  registerMcp();
  // A snapshot for the MCP server as soon as the core has analyzed; failures here are not the person's concern yet.
  void core().then(saveSnapshots, () => undefined);
}

export function deactivate(): void {}
