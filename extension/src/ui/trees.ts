import path from "node:path";
import * as vscode from "vscode";
import type { AnalysisRun, Finding, Module, SkippedRule } from "../core/model";
import { describeFinding, formatMetrics, groupFindings, groupSkipped, summarizeStyles } from "../core/views";

type Node = vscode.TreeItem & { children?: Node[] };

function branch(label: string, description: string | undefined, children: Node[], icon?: string): Node {
  const item: Node = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
  item.description = description;
  item.children = children;
  if (icon) item.iconPath = new vscode.ThemeIcon(icon);
  return item;
}

function leaf(label: string, description?: string, tooltip?: string): Node {
  const item: Node = new vscode.TreeItem(label);
  item.description = description;
  item.tooltip = tooltip;
  return item;
}

export function locationOf(finding: Finding): { range: vscode.Range } {
  return { range: new vscode.Range(finding.startLine - 1, finding.startColumn - 1, finding.endLine - 1, finding.endColumn - 1) };
}

class Tree implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  protected roots: Node[] = [];

  protected refresh(roots: Node[]): void {
    this.roots = roots;
    this.changed.fire();
  }

  getTreeItem(element: Node): vscode.TreeItem {
    return element;
  }

  getChildren(element?: Node): Node[] {
    return element ? element.children ?? [] : this.roots;
  }
}

const levelIcons: Record<Finding["level"], string> = { error: "error", warning: "warning", note: "info" };

function findingNode(run: AnalysisRun, finding: Finding): Node {
  const item = leaf(finding.message, `${finding.ruleId} · ${finding.confidence}`, describeFinding(finding));
  item.iconPath = new vscode.ThemeIcon(levelIcons[finding.level]);
  item.command = {
    command: "vscode.open",
    title: "Open",
    arguments: [vscode.Uri.file(path.join(run.root, finding.file)), { selection: locationOf(finding).range }],
  };
  return item;
}

/** Findings by module and category, with the module metrics from facts next to them. */
export class FindingsTree extends Tree {
  update(runs: AnalysisRun[]): void {
    this.refresh(runs.flatMap((run) => groupFindings(run.findings).map((module) => {
      const metrics = run.facts.modules.find((m) => m.id === module.module)?.metrics;
      const categories = module.categories.map((c) => branch(c.key, String(c.items.length), c.items.map((f) => findingNode(run, f))));
      const node = branch(module.module, String(module.total), categories, "symbol-namespace");
      if (metrics) node.tooltip = formatMetrics(metrics);
      return node;
    })));
  }
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** One row per reason, in the analyzer's words; the rules it covers are one level down. */
function skipNodes(skipped: SkippedRule[], titles: Map<string, string>): Node[] {
  return groupSkipped(skipped).map((group) => {
    const node = branch(group.message, count(group.rules.length, "rule"), group.rules.map((id) => leaf(id, titles.get(id))), "circle-slash");
    node.tooltip = group.message;
    return node;
  });
}

/** What the module shows and which rules it did not get. No skips are said aloud, so an absent reason is not a mystery. */
function moduleNode(module: Module, skipped: SkippedRule[], everywhere: number, titles: Map<string, string>): Node {
  const own = skipped.filter((s) => s.module === module.id);
  const reasons = skipNodes(own, titles);
  if (!reasons.length) {
    const none = leaf("No rules skipped in this module", undefined, everywhere ? `Rules skipped for the whole project are listed separately (${everywhere}).` : undefined);
    none.iconPath = new vscode.ThemeIcon("check");
    reasons.push(none);
  }
  const evidence = module.paradigmEvidence.map((e) => leaf(e.description ?? e.kind, `${e.count} · ${e.paradigm}`, [e.kind, ...(e.examples ?? [])].join("\n")));
  const description = own.length ? `${count(new Set(own.map((s) => s.ruleId)).size, "rule")} skipped` : undefined;
  return branch(module.name, description, [...reasons, ...evidence], "symbol-namespace");
}

/** Language, then style, then module: a module is listed once, under the style its code shows. */
function languageNode(run: AnalysisRun, titles: Map<string, string>): Node {
  const { modules, skippedRules } = run.facts;
  const summary = summarizeStyles(run.facts);
  const general = skippedRules.filter((s) => !s.module);
  const generalRules = new Set(general.map((s) => s.ruleId)).size;
  const nodes = (ids: string[]) => ids.map((id) => moduleNode(modules.find((m) => m.id === id)!, skippedRules, generalRules, titles));
  const children = summary.styles.map((style) => branch(style.paradigms.join(" + ") || "no active paradigm", count(style.modules.length, "module"), nodes(style.modules), "symbol-class"));
  if (summary.unreported.length) children.push(branch("Not reported by the analyzer", count(summary.unreported.length, "module"), nodes(summary.unreported), "question"));
  if (general.length) children.push(branch("Skipped for the whole project", count(generalRules, "rule"), skipNodes(general, titles), "circle-slash"));
  const node = branch(run.language, count(summary.total, "module"), children, "graph");
  node.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
  return node;
}

/** Styles of the code and the rules that were not applied, with reasons. It reads facts and judges nothing. */
export class ParadigmsTree extends Tree {
  update(runs: AnalysisRun[]): void {
    const titles = new Map(runs.flatMap((run) => Object.entries(run.ruleTitles ?? {})));
    this.refresh(runs.map((run) => languageNode(run, titles)));
  }
}
