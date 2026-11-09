// Tools and prompts of the Nomos MCP server. Every tool reads the snapshot afresh, so it shows the last analysis.
// Results are deterministic JSON or text; tools never change files.
import fs from "node:fs";
import path from "node:path";
import type { AgentKind } from "../core/agents";
import { DefaultMaxCharacters, buildRequest } from "../core/agents";
import { changes } from "../core/git";
import type { FunctionEntity, Scope, Snapshot } from "../core/model";
import type { Locale } from "../core/prompts";
import { allFunctions, changedFunctions, lastLine, ordinal, performanceCandidates, timeEstimate } from "../core/select";

export interface ToolDefinition { name: string; description: string; inputSchema: Record<string, unknown> }
export interface PromptDefinition { name: string; description: string; arguments: { name: string; description: string; required?: boolean }[] }

type Args = Record<string, unknown>;

const scopeProperty = { type: "string", enum: ["changes", "all"], description: "\"changes\": what differs from the base commit (git); \"all\": the whole analyzed root" };
const baseProperty = { type: "string", description: "Commit or branch to compare with; by default the merge base with the default branch" };
const fileProperty = { type: "string", description: "Path relative to the analyzed root, forward slashes" };
const limitProperty = { type: "integer", minimum: 1, description: "Largest number of items to return" };

export const tools: ToolDefinition[] = [
  {
    name: "nomos_overview",
    description: "Languages, sizes, health scores (statistics, not verdicts) and finding counts per rule of the last Nomos analysis.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "nomos_findings",
    description: "Heuristic findings of Nomos with confidence, message and explanation; filter by file or rule.",
    inputSchema: { type: "object", properties: { file: fileProperty, ruleId: { type: "string" }, limit: limitProperty }, additionalProperties: false },
  },
  {
    name: "nomos_functions",
    description: "Functions with their metrics (cyclomatic, maxNesting, lines, static time and memory estimates, and others), largest value of a metric first.",
    inputSchema: { type: "object", properties: { file: fileProperty, sortBy: { type: "string", description: "Metric to sort by, cyclomatic by default" }, limit: limitProperty }, additionalProperties: false },
  },
  {
    name: "nomos_paradigms",
    description: "Paradigms active in each module with the evidence found, and the rules skipped because their paradigm is absent.",
    inputSchema: { type: "object", properties: { module: { type: "string", description: "Module id; all modules when absent" } }, additionalProperties: false },
  },
  {
    name: "nomos_changes",
    description: "Files and line ranges changed against the base commit, and the analyzed functions they touch.",
    inputSchema: { type: "object", properties: { base: baseProperty }, additionalProperties: false },
  },
  {
    name: "nomos_hotspots",
    description: "Functions whose static estimates point at a cost: superlinear or exponential time, growing memory, allocation in loops. Estimates from code shape, not measurements.",
    inputSchema: { type: "object", properties: { scope: scopeProperty, base: baseProperty, limit: limitProperty }, additionalProperties: false },
  },
  {
    name: "nomos_source",
    description: "Lines of a source file under the analyzed root, numbered.",
    inputSchema: { type: "object", properties: { file: fileProperty, startLine: { type: "integer", minimum: 1 }, endLine: { type: "integer", minimum: 1 } }, required: ["file"], additionalProperties: false },
  },
];

const agentArguments = [
  { name: "scope", description: "\"changes\" (default for review) or \"all\" (default for performance)" },
  { name: "base", description: "Commit or branch to compare with; the merge base with the default branch by default" },
  { name: "question", description: "What else to look at or ask" },
];

export const prompts: PromptDefinition[] = [
  { name: "review", description: "Nomos Review: agreement of the code with its paradigms and with practices and approaches.", arguments: agentArguments },
  { name: "performance", description: "Nomos Performance: speed of functions and ways to optimize them.", arguments: agentArguments },
];

export class ToolInputError extends Error {}

function text(value: Args, name: string): string | undefined {
  const v = value[name];
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") throw new ToolInputError(`${name} must be a string`);
  return v;
}

function count(value: Args, name: string, fallback: number): number {
  const v = value[name] ?? fallback;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw new ToolInputError(`${name} must be a positive integer`);
  return v;
}

function scopeOf(value: Args, fallback: Scope): Scope {
  const v = text(value, "scope") ?? fallback;
  if (v !== "changes" && v !== "all") throw new ToolInputError("scope must be \"changes\" or \"all\"");
  return v;
}

const json = (value: unknown) => JSON.stringify(value, null, 2);

function functionSummary(language: string, fn: FunctionEntity) {
  return { language, id: fn.id, name: fn.name, kind: fn.kind ?? "function", file: fn.location.file, startLine: fn.location.startLine, endLine: lastLine(fn.location, fn.metrics.lines), timeEstimate: timeEstimate(fn), metrics: fn.metrics };
}

/** Runs a tool; a wrong argument throws ToolInputError, a missing snapshot SnapshotError, a git problem GitError. */
export function callTool(name: string, args: Args, snapshot: () => Snapshot): string {
  switch (name) {
    case "nomos_overview": {
      const s = snapshot();
      return json({
        root: path.basename(s.root),
        note: "Statistics and heuristic observations, not verdicts.",
        languages: s.runs.map((run) => {
          const byRule: Record<string, number> = {};
          for (const f of run.findings) byRule[f.ruleId] = (byRule[f.ruleId] ?? 0) + 1;
          return {
            language: run.language,
            files: run.facts.files.length,
            modules: run.facts.modules.length,
            types: run.facts.types.length,
            functions: run.facts.functions.length,
            health: run.facts.health,
            findingsByRule: Object.fromEntries(Object.keys(byRule).sort(ordinal).map((k) => [k, byRule[k]])),
          };
        }),
      });
    }
    case "nomos_findings": {
      const file = text(args, "file");
      const ruleId = text(args, "ruleId");
      const limit = count(args, "limit", 200);
      const found = snapshot().runs.flatMap((run) => run.findings.map((f) => ({ language: run.language, ...f })))
        .filter((f) => (!file || f.file === file) && (!ruleId || f.ruleId === ruleId))
        .sort((a, b) => ordinal(a.file, b.file) || a.startLine - b.startLine || ordinal(a.ruleId, b.ruleId));
      return json({ total: found.length, findings: found.slice(0, limit) });
    }
    case "nomos_functions": {
      const file = text(args, "file");
      const sortBy = text(args, "sortBy") ?? "cyclomatic";
      const limit = count(args, "limit", 50);
      const found = allFunctions(snapshot()).filter((s) => !file || s.fn.location.file === file)
        .sort((a, b) => (b.fn.metrics[sortBy] ?? -Infinity) - (a.fn.metrics[sortBy] ?? -Infinity) || ordinal(a.fn.id, b.fn.id));
      return json({ total: found.length, sortBy, functions: found.slice(0, limit).map((s) => functionSummary(s.language, s.fn)) });
    }
    case "nomos_paradigms": {
      const module = text(args, "module");
      const s = snapshot();
      return json(s.runs.map((run) => ({
        language: run.language,
        modules: run.facts.modules.filter((m) => !module || m.id === module)
          .map((m) => ({ id: m.id, activeParadigms: m.activeParadigms ?? [], evidence: m.paradigmEvidence })),
        skippedRules: run.facts.skippedRules.filter((r) => !module || !r.module || r.module === module),
      })));
    }
    case "nomos_changes": {
      const s = snapshot();
      const found = changes(s.root, text(args, "base"));
      return json({
        base: found.baseDescription,
        files: found.files,
        functions: changedFunctions(s, found.files).map((sel) => functionSummary(sel.language, sel.fn)),
      });
    }
    case "nomos_hotspots": {
      const s = snapshot();
      const scope = scopeOf(args, "all");
      const limit = count(args, "limit", 20);
      const pool = scope === "changes" ? changedFunctions(s, changes(s.root, text(args, "base")).files) : allFunctions(s);
      const found = performanceCandidates(pool);
      return json({
        note: "Static estimates from the shape of the code (spec/metrics.md); nothing was run.",
        total: found.length,
        functions: found.slice(0, limit).map((sel) => ({ ...functionSummary(sel.language, sel.fn), findings: sel.findings.map((f) => `${f.ruleId}: ${f.message}`) })),
      });
    }
    case "nomos_source": {
      const file = text(args, "file");
      if (!file) throw new ToolInputError("file is required");
      const root = snapshot().root;
      const full = path.resolve(root, file);
      if (path.relative(root, full).startsWith("..") || path.isAbsolute(path.relative(root, full))) throw new ToolInputError("file must be under the analyzed root");
      if (!fs.existsSync(full)) throw new ToolInputError(`no file ${file}`);
      const lines = fs.readFileSync(full, "utf8").split(/\r?\n/);
      const start = count(args, "startLine", 1);
      const end = Math.min(count(args, "endLine", lines.length), lines.length, start + 1999);
      return lines.slice(start - 1, end).map((line, i) => `${start + i}| ${line}`).join("\n");
    }
    default:
      throw new ToolInputError(`unknown tool ${name}`);
  }
}

/** The text of a prompt: the agent's instructions followed by its context, as one user message. */
export function getPrompt(name: string, args: Args, snapshot: () => Snapshot, locale: Locale): string {
  if (name !== "review" && name !== "performance") throw new ToolInputError(`unknown prompt ${name}`);
  const kind: AgentKind = name;
  const request = buildRequest(kind, snapshot(), {
    scope: scopeOf(args, kind === "review" ? "changes" : "all"),
    base: text(args, "base"),
    question: text(args, "question"),
    maxCharacters: DefaultMaxCharacters,
    locale,
  });
  return `${request.system}\n\n---\n\n${request.user}`;
}
