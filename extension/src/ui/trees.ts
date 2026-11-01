import path from "node:path";
import * as vscode from "vscode";
import type { AnalysisRun, Finding } from "../core/model";
import { describeFinding, formatMetrics, groupFindings, summarizeStyles } from "../core/views";

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

function styleNode(run: AnalysisRun): Node {
  const summary = summarizeStyles(run.facts);
  const children = summary.paradigms.map((p) => leaf(p.paradigm, `${p.modules} of ${summary.total}`));
  for (const style of summary.styles) {
    children.push(branch(style.paradigms.join(" + ") || "no active paradigm", String(style.modules.length), style.modules.map((m) => leaf(m)), "symbol-class"));
  }
  if (summary.unreported.length) children.push(branch("Not reported by the analyzer", String(summary.unreported.length), summary.unreported.map((m) => leaf(m)), "question"));
  return branch(`Modules by style (${run.language})`, `${summary.total} modules`, children, "graph");
}

/** Modules by style, then paradigm evidence per module and the rules that were not applied, with reasons. */
export class ParadigmsTree extends Tree {
  update(runs: AnalysisRun[]): void {
    this.refresh(runs.flatMap((run) => {
      const modules = run.facts.modules.map((m) => {
        const evidence = m.paradigmEvidence.map((e) => leaf(e.kind, String(e.count), [e.description, ...(e.examples ?? [])].filter(Boolean).join("\n")));
        const skipped = run.facts.skippedRules.filter((s) => s.module === m.id).map((s) => leaf(s.ruleId, s.reason, s.message));
        const children = [...evidence];
        if (skipped.length) children.push(branch("Skipped rules", String(skipped.length), skipped, "circle-slash"));
        const shown = m.activeParadigms ? m.activeParadigms.join(", ") || "no active paradigm" : "not reported";
        return branch(m.name, shown, children, "symbol-namespace");
      });
      const general = run.facts.skippedRules.filter((s) => !s.module).map((s) => leaf(s.ruleId, s.reason, s.message));
      if (general.length) modules.push(branch("Skipped for the whole project", String(general.length), general, "circle-slash"));
      return [styleNode(run), ...modules];
    }));
  }
}
