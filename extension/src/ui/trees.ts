import path from "node:path";
import * as vscode from "vscode";
import { describeSkip, paradigmName, ruleTitle } from "../core/l10n";
import type { CatalogRule, Translate } from "../core/l10n";
import type { AnalysisRun, Evidence, Finding, Module, SkippedRule } from "../core/model";
import { confidenceText, describeFinding, formatMetrics, groupFindings, groupSkipped, summarizeStyles } from "../core/views";

type Node = vscode.TreeItem & { children?: Node[] };

/** What the trees need to speak the interface language (D-052). */
export interface TreeTexts {
  t: Translate;
  rules: Map<string, CatalogRule>;
  /** Titles of the practices of a rule that the folder of the run does not choose. */
  unchosen(run: AnalysisRun, ruleId: string): string[];
}

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

/** Categories of spec/rules; the English names are the ids, as before. */
function categoryName(category: string, t: Translate): string {
  const names: Record<string, string> = {
    Algorithms: t("Algorithms"), CleanCode: t("CleanCode"), Design: t("Design"), Maintainability: t("Maintainability"),
    Paradigm: t("Paradigm"), Patterns: t("Patterns"), Principles: t("Principles"), Security: t("Security"), Other: t("Other"),
  };
  return names[category] ?? category;
}

function findingNode(run: AnalysisRun, finding: Finding, t: Translate): Node {
  const item = leaf(finding.message, `${finding.ruleId} · ${confidenceText(finding.confidence, t)}`, describeFinding(finding, t));
  item.iconPath = new vscode.ThemeIcon(levelIcons[finding.level]);
  item.command = {
    command: "vscode.open",
    title: t("Open"),
    arguments: [vscode.Uri.file(path.join(run.root, finding.file)), { selection: locationOf(finding).range }],
  };
  return item;
}

/** Findings by module and category, with the module metrics from facts next to them. */
export class FindingsTree extends Tree {
  update(runs: AnalysisRun[], { t }: TreeTexts): void {
    this.refresh(runs.flatMap((run) => groupFindings(run.findings).map((module) => {
      const metrics = run.facts.modules.find((m) => m.id === module.module)?.metrics;
      const categories = module.categories.map((c) => branch(categoryName(c.key, t), String(c.items.length), c.items.map((f) => findingNode(run, f, t))));
      const node = branch(module.module, String(module.total), categories, "symbol-namespace");
      if (metrics) node.tooltip = formatMetrics(metrics, undefined, t);
      return node;
    })));
  }
}

function rules(n: number, t: Translate): string {
  return n === 1 ? t("{0} rule", n) : t("{0} rules", n);
}

function modules(n: number, t: Translate): string {
  return n === 1 ? t("{0} module", n) : t("{0} modules", n);
}

/** Signs of paradigms of spec/paradigms.md; English keeps the analyzer's own description. */
function evidenceName(evidence: Evidence, t: Translate): string {
  if (t.locale === "en") return evidence.description ?? evidence.kind;
  const names: Record<string, string> = {
    "oop.classes": t("classes with methods or fields"),
    "oop.mutable-state-classes": t("classes with mutable instance state"),
    "oop.inheritance": t("project types inheriting project types"),
    "oop.abstractions": t("interfaces and abstract classes"),
    "fp.pure-functions": t("functions that provably have no effects (conservative)"),
    "fp.higher-order": t("functions taking or returning functions"),
    "fp.lambdas": t("lambdas passed as arguments"),
    "fp.immutable-types": t("types without mutable state"),
    "str.free-functions": t("functions outside types"),
    "str.control-flow": t("functions with branches or loops"),
    "str.global-state": t("module-level variables and static mutable state"),
  };
  return names[evidence.kind] ?? evidence.description ?? evidence.kind;
}

/** One row per reason, in the analyzer's words or, in another language, by the reason code; the rules are one level down. */
function skipNodes(run: AnalysisRun, skipped: SkippedRule[], titles: Map<string, string>, texts: TreeTexts): Node[] {
  const { t } = texts;
  const said = skipped.map((s) => ({ ...s, message: describeSkip(s, texts.rules, t, texts.unchosen(run, s.ruleId)) }));
  return groupSkipped(said).map((group) => {
    const children = group.rules.map((id) => leaf(id, ruleTitle(id, texts.rules, t.locale, titles.get(id))));
    const node = branch(group.message, rules(group.rules.length, t), children, "circle-slash");
    node.tooltip = group.message;
    return node;
  });
}

/** What the module shows and which rules it did not get. No skips are said aloud, so an absent reason is not a mystery. */
function moduleNode(run: AnalysisRun, module: Module, everywhere: number, titles: Map<string, string>, texts: TreeTexts): Node {
  const { t } = texts;
  const own = run.facts.skippedRules.filter((s) => s.module === module.id);
  const reasons = skipNodes(run, own, titles, texts);
  if (!reasons.length) {
    const none = leaf(t("No rules skipped in this module"), undefined, everywhere ? t("Rules skipped for the whole project are listed separately ({0}).", everywhere) : undefined);
    none.iconPath = new vscode.ThemeIcon("check");
    reasons.push(none);
  }
  const evidence = module.paradigmEvidence.map((e) => leaf(evidenceName(e, t), `${e.count} · ${paradigmName(e.paradigm, t)}`, [e.kind, ...(e.examples ?? [])].join("\n")));
  const description = own.length ? t("{0} skipped", rules(new Set(own.map((s) => s.ruleId)).size, t)) : undefined;
  return branch(module.name, description, [...reasons, ...evidence], "symbol-namespace");
}

/** Language, then style, then module: a module is listed once, under the style its code shows. */
function languageNode(run: AnalysisRun, titles: Map<string, string>, texts: TreeTexts): Node {
  const { t } = texts;
  const { skippedRules } = run.facts;
  const summary = summarizeStyles(run.facts);
  const general = skippedRules.filter((s) => !s.module);
  const generalRules = new Set(general.map((s) => s.ruleId)).size;
  const nodes = (ids: string[]) => ids.map((id) => moduleNode(run, run.facts.modules.find((m) => m.id === id)!, generalRules, titles, texts));
  const children = summary.styles.map((style) => branch(style.paradigms.map((p) => paradigmName(p, t)).join(" + ") || t("no active paradigm"), modules(style.modules.length, t), nodes(style.modules), "symbol-class"));
  if (summary.unreported.length) children.push(branch(t("Not reported by the analyzer"), modules(summary.unreported.length, t), nodes(summary.unreported), "question"));
  if (general.length) children.push(branch(t("Skipped for the whole project"), rules(generalRules, t), skipNodes(run, general, titles, texts), "circle-slash"));
  const node = branch(run.language, modules(summary.total, t), children, "graph");
  node.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
  return node;
}

/** Styles of the code and the rules that were not applied, with reasons. It reads facts and judges nothing. */
export class ParadigmsTree extends Tree {
  update(runs: AnalysisRun[], texts: TreeTexts): void {
    const titles = new Map(runs.flatMap((run) => Object.entries(run.ruleTitles ?? {})));
    this.refresh(runs.map((run) => languageNode(run, titles, texts)));
  }
}
