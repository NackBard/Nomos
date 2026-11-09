// Builds what an agent sends to the model: its instructions and a context made of Nomos data and source code.
// The same requests serve the VS Code agents and the prompts of the MCP server, so any MCP client gets the same agents.
import fs from "node:fs";
import path from "node:path";
import type { Changes, LineRange } from "./git";
import { changes as gitChanges } from "./git";
import type { Finding, FunctionEntity, Scope, Snapshot } from "./model";
import type { Locale } from "./prompts";
import { performanceInstructions, reviewInstructions } from "./prompts";
import type { Selected } from "./select";
import { allFunctions, byCost, byReviewInterest, changedFindings, changedFunctions, lastLine, ordinal, performanceCandidates, timeEstimate } from "./select";

export type AgentKind = "review" | "performance";

export interface AgentOptions {
  scope: Scope;
  /** Commit or branch to compare with; the merge base with the default branch when absent. */
  base?: string;
  /** Upper bound of the context in characters; what does not fit is named, never dropped silently. */
  maxCharacters: number;
  locale: Locale;
  /** What the developer added to the request, if anything. */
  question?: string;
}

export interface AgentSummary {
  scope: Scope;
  baseDescription?: string;
  changedFiles: number;
  /** Functions chosen for the agent, and how many of them fit into the context. */
  functions: number;
  included: number;
  omitted: string[];
}

export interface AgentRequest { system: string; user: string; summary: AgentSummary }

export const DefaultMaxCharacters = 200_000;
/** A longer function is shown in its first lines only, and the context says so. */
const MaxFunctionLines = 400;
const MaxChangedFilesListed = 200;
const MaxModules = 60;

/** Reads source files once per request. */
class Sources {
  private readonly cache = new Map<string, string[] | undefined>();
  constructor(private readonly root: string) {}

  lines(file: string): string[] | undefined {
    if (!this.cache.has(file)) {
      const full = path.resolve(this.root, file);
      const inside = !path.relative(this.root, full).startsWith("..");
      this.cache.set(file, inside && fs.existsSync(full) ? fs.readFileSync(full, "utf8").split(/\r?\n/) : undefined);
    }
    return this.cache.get(file);
  }
}

function metricsLine(fn: FunctionEntity): string {
  const names = Object.keys(fn.metrics).filter((k) => fn.metrics[k] !== null).sort(ordinal);
  const estimate = timeEstimate(fn);
  return [...(estimate ? [`time estimate ${estimate}`] : []), ...names.map((k) => `${k}=${fn.metrics[k]}`)].join(", ");
}

function findingLine(f: Finding): string {
  const measured = f.measured ? ` [${f.measured.metric}=${f.measured.value}${f.measured.threshold !== undefined ? `, reported from ${f.measured.threshold}` : ""}]` : "";
  return `- ${f.ruleId} (${f.ruleTitle}, ${f.confidence} confidence) at ${f.file}:${f.startLine}: ${f.message}${measured}. Why: ${f.explanation}`;
}

function changedLine(line: number, ranges: LineRange[] | undefined): boolean {
  return ranges === undefined || ranges.some((r) => line >= r.start && line <= r.end);
}

function codeBlock(selected: Selected, sources: Sources, changed?: Map<string, LineRange[] | undefined>): string {
  const { fn, language, findings } = selected;
  const end = lastLine(fn.location, fn.metrics.lines);
  const header = `### ${fn.id} (${fn.kind ?? "function"}, ${language}) — ${fn.location.file}:${fn.location.startLine}-${end}`;
  const lines = sources.lines(fn.location.file);
  const parts = [header, `Metrics: ${metricsLine(fn)}`];
  if (findings.length) parts.push("Nomos findings:", ...findings.map(findingLine));
  if (!lines) {
    parts.push("(source file not readable from the analyzed root)");
    return parts.join("\n");
  }
  const shownEnd = Math.min(end, fn.location.startLine + MaxFunctionLines - 1, lines.length);
  const ranges = changed?.get(fn.location.file);
  const width = String(shownEnd).length;
  const body: string[] = [];
  for (let n = fn.location.startLine; n <= shownEnd; n++) {
    const mark = changed && changedLine(n, ranges) ? "*" : " ";
    body.push(`${String(n).padStart(width)}${mark}| ${lines[n - 1] ?? ""}`);
  }
  parts.push("```" + language, ...body, "```");
  if (shownEnd < end) parts.push(`(lines ${shownEnd + 1}-${end} not shown: the function is longer than ${MaxFunctionLines} lines)`);
  return parts.join("\n");
}

function projectSection(snapshot: Snapshot): string {
  const lines = ["## Project", `Root folder: ${path.basename(snapshot.root)}`];
  for (const run of snapshot.runs) {
    const health = run.facts.health ? `, health score ${run.facts.health.score} (a statistic, not a verdict)` : "";
    lines.push(`- ${run.language}: ${run.facts.files.length} files, ${run.facts.types.length} types, ${run.facts.functions.length} functions, ${run.findings.length} findings${health}`);
  }
  return lines.join("\n");
}

function paradigmSection(snapshot: Snapshot, modules: Set<string> | undefined): string {
  const lines = ["## Paradigms of the modules", "Active paradigms and the evidence Nomos found (kind × count)."];
  let shown = 0;
  let hidden = 0;
  for (const run of snapshot.runs) {
    for (const module of [...run.facts.modules].sort((a, b) => ordinal(a.id, b.id))) {
      if (modules && !modules.has(module.id)) continue;
      if (shown >= MaxModules) {
        hidden++;
        continue;
      }
      shown++;
      const evidence = [...module.paradigmEvidence].sort((a, b) => ordinal(a.kind, b.kind)).map((e) => `${e.kind}×${e.count}`).join(", ");
      lines.push(`- ${module.id} (${run.language}): active ${module.activeParadigms?.length ? module.activeParadigms.join(", ") : "none"}; evidence ${evidence || "none"}`);
    }
  }
  if (hidden) lines.push(`(${hidden} more modules not listed)`);
  const skipped = new Map<string, string>();
  for (const run of snapshot.runs) {
    for (const s of run.facts.skippedRules) {
      if (s.module && modules && !modules.has(s.module)) continue;
      const key = `${s.ruleId}: ${s.message}`;
      if (!skipped.has(key)) skipped.set(key, `- ${s.ruleId} skipped (${s.reason})${s.module ? ` in ${s.module}` : ""}: ${s.message}`);
    }
  }
  if (skipped.size) lines.push("", "Rules Nomos did not apply here:", ...[...skipped.keys()].sort(ordinal).slice(0, 100).map((k) => skipped.get(k)!));
  return lines.join("\n");
}

function catalogSection(snapshot: Snapshot, ruleIds: Set<string>): string {
  if (!snapshot.practices.length && !snapshot.rules.length) return "";
  const lines = ["## Practices and rules"];
  for (const practice of snapshot.practices) lines.push(`- practice ${practice.id} — ${practice.title}: ${practice.description ?? ""} Rules: ${practice.rules.join(", ")}`);
  const used = snapshot.rules.filter((r) => ruleIds.has(r.id)).sort((a, b) => ordinal(a.id, b.id));
  if (used.length) lines.push("", "Rules of the findings below:", ...used.map((r) => `- ${r.id} — ${r.title}: ${r.description ?? ""}${r.rationale ? ` (${r.rationale})` : ""}`));
  return lines.join("\n");
}

function changesSection(found: Changes): string {
  const listed = found.files.slice(0, MaxChangedFilesListed).map((f) => `- ${f.file}${f.ranges ? ` (lines ${f.ranges.map((r) => (r.start === r.end ? `${r.start}` : `${r.start}-${r.end}`)).join(", ")})` : " (new file)"}`);
  const more = found.files.length > MaxChangedFilesListed ? [`(${found.files.length - MaxChangedFilesListed} more files)`] : [];
  return ["## Changes", `Compared with ${found.baseDescription}.`, ...listed, ...more].join("\n");
}

/** Builds the request of an agent; throws GitError when the scope is "changes" outside a git repository. */
export function buildRequest(kind: AgentKind, snapshot: Snapshot, options: AgentOptions): AgentRequest {
  const changesOnly = options.scope === "changes";
  const found = changesOnly ? gitChanges(snapshot.root, options.base) : undefined;
  const changedMap = found ? new Map(found.files.map((f) => [f.file, f.ranges])) : undefined;

  let chosen: Selected[];
  if (found) {
    const changed = changedFunctions(snapshot, found.files);
    chosen = kind === "performance" ? [...changed].sort(byCost) : changed;
  } else {
    const all = allFunctions(snapshot).filter((s) => s.fn.kind !== "lambda");
    chosen = kind === "performance" ? performanceCandidates(all) : all.sort(byReviewInterest);
  }

  const looseFindings = found
    ? changedFindings(snapshot, found.files).filter((f) => !chosen.some((s) => s.findings.includes(f)))
    : [];
  const modules = new Set(chosen.map((s) => s.fn.module));
  const ruleIds = new Set([...chosen.flatMap((s) => s.findings), ...looseFindings].map((f) => f.ruleId));

  const head = [
    projectSection(snapshot),
    found ? changesSection(found) : "## Scope\nThe whole analyzed root.",
    paradigmSection(snapshot, found ? modules : undefined),
    kind === "review" ? catalogSection(snapshot, ruleIds) : "",
    looseFindings.length ? ["## Findings on changed lines outside functions", ...looseFindings.map(findingLine)].join("\n") : "",
  ].filter(Boolean);
  const question = options.question?.trim() ? `## Request of the developer\n${options.question.trim()}` : "";

  const sources = new Sources(snapshot.root);
  const blocks: string[] = [];
  const omitted: string[] = [];
  let size = head.join("\n\n").length + question.length;
  for (const item of chosen) {
    const block = codeBlock(item, sources, changedMap);
    if (size + block.length > options.maxCharacters) {
      omitted.push(item.fn.id);
      continue;
    }
    blocks.push(block);
    size += block.length + 2;
  }

  const title = kind === "performance" ? "## Functions to estimate" : "## Functions to review";
  const empty = found ? "No analyzed function overlaps the changes." : "No function matches.";
  const omittedNote = omitted.length
    ? `## Not shown\n${omitted.length} of ${chosen.length} functions did not fit into the context and were not shown: ${omitted.slice(0, 50).join(", ")}${omitted.length > 50 ? ", …" : ""}`
    : "";
  const user = [...head, [title, ...(blocks.length ? blocks : [empty])].join("\n\n"), omittedNote, question].filter(Boolean).join("\n\n");
  const system = kind === "performance" ? performanceInstructions(options.locale, changesOnly) : reviewInstructions(options.locale, changesOnly);
  return {
    system,
    user,
    summary: { scope: options.scope, baseDescription: found?.baseDescription, changedFiles: found?.files.length ?? 0, functions: chosen.length, included: blocks.length, omitted },
  };
}
