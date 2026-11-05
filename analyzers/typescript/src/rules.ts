import { createHash } from "node:crypto";
import ts from "typescript";
import type { Config, SpecRule } from "./config.ts";
import { ordinal } from "./config.ts";
import type { Coverage } from "./coverage.ts";
import { growthText, selfCalls } from "./estimate.ts";
import type { Growth } from "./estimate.ts";
import type { Edge, Graphs } from "./graph.ts";
import { components, simpleName } from "./graph.ts";
import {
  allocates, atfd, cyclomatic, dit, hofOrder, isInstanceMethod, lambdaNesting, lcom4, lineSpan, maintainabilityIndex, maxNesting,
  memberUse, mostUsedForeign, parameterCount, round, spaceDegree, tcc, testedTypes, walkBody, walkLoops, wmc,
} from "./metrics.ts";
import { moduleFunctions } from "./paradigms.ts";
import type { Fn, Module, Place, Project, SourceInfo, TypeUnit } from "./project.ts";
import { isFunctionValue, unwrap } from "./project.ts";
import { fixed, render, tx } from "./text.ts";
import type { Text } from "./text.ts";

export interface Measured { metric: string; value: number; threshold: number }

/** One heuristic result. */
export interface Finding {
  rule: string;
  severity: string;
  confidence: string;
  category: string;
  place: Place;
  message: string;
  explanation: string;
  module: string;
  entity: string;
  measured?: Measured;
  /** The templates of spec/rules with their arguments (spec/l10n.md). */
  messageText: Text;
  explanationText: Text;
}

/** Does not depend on the line (contracts/sarif-profile.md). */
export function fingerprint(f: Finding): string {
  return createHash("sha256").update(`${f.rule}|${f.place.file}|${f.entity}|${f.message}`).digest("hex").slice(0, 16);
}

/**
 * The rules implemented for TypeScript and JavaScript. The others are recorded as not-supported: goto does not exist
 * in the language (STR001), and the remaining detectors are not written yet (D-055).
 */
export const supported = [
  "ALG001", "ALG002", "ALG003", "ALG004", "CC001", "CC002", "CC003", "CC004", "CC009", "DSN001", "DSN002", "DSN003", "DSN004", "DSN005", "DSN006",
  "FUN005", "MNT001", "MNT002", "MNT003", "MNT004", "OOP001", "OOP002", "OOP003", "OOP004", "OOP005", "PRN007", "SEC001", "SEC003", "STR002", "STR003",
];

/** State of one analysis shared by the detectors. */
export class Run {
  findings: Finding[] = [];
  rule!: SpecRule;
  ran = new Map<string, SpecRule>();
  /** Module to its active and enabled paradigms. */
  active = new Map<string, Set<string>>();
  coverage?: Coverage;
  readonly p: Project;
  readonly config: Config;
  readonly edges: Edge[];
  readonly graphs: Graphs;
  readonly estimates: Map<string, Growth>;

  constructor(p: Project, config: Config, edges: Edge[], graphs: Graphs, estimates: Map<string, Growth>) {
    this.p = p;
    this.config = config;
    this.edges = edges;
    this.graphs = graphs;
    this.estimates = estimates;
  }

  applies(m: Module): boolean {
    return this.rule.paradigms.length === 0 || this.rule.paradigms.some((paradigm) => this.active.get(m.id)?.has(paradigm));
  }

  number(name: string): number {
    return this.config.number(this.rule, name);
  }

  report(confidence: string, place: Place, module: string, entity: string, message: Text, explanation: Text, measured?: Measured, severity?: string): void {
    const level = this.config.rules[this.rule.id]?.severity || severity || this.rule.severity;
    this.findings.push({
      rule: this.rule.id, severity: level, confidence, category: this.rule.category, place, message: render(message), explanation: render(explanation),
      module, entity, measured, messageText: message, explanationText: explanation,
    });
  }

  functions(visit: (f: Fn) => void): void {
    for (const m of this.p.modules) if (this.applies(m)) moduleFunctions(m).forEach(visit);
  }

  types(visit: (t: TypeUnit) => void): void {
    for (const m of this.p.modules) if (this.applies(m)) m.types.forEach(visit);
  }

  /** Ca, Ce, I, A and D of a module over the unit graph (spec/metrics.md). */
  martin(m: Module): { ca: number; ce: number; instability: number | null; abstractness: number | null; distance: number | null } {
    const inside = new Set([...m.types.map((t) => t.id), ...m.functions.map((f) => f.id)]);
    const incoming = new Set<string>();
    const outgoing = new Set<string>();
    for (const unit of inside) {
      for (const other of this.graphs.units.prev.get(unit) ?? []) if (!inside.has(other)) incoming.add(other);
      for (const other of this.graphs.units.next.get(unit) ?? []) if (!inside.has(other)) outgoing.add(other);
    }
    const ca = incoming.size;
    const ce = outgoing.size;
    const instability = ca + ce > 0 ? round(ce / (ca + ce), 4) : null;
    const abstractness = m.types.length > 0 ? round(m.types.filter((t) => t.isAbstract).length / m.types.length, 4) : null;
    const distance = instability !== null && abstractness !== null ? round(Math.abs(abstractness + instability - 1), 4) : null;
    return { ca, ce, instability, abstractness, distance };
  }

  /** Distinct other types a type depends on, the standard library excluded. */
  cbo(t: TypeUnit): number {
    const seen = new Set<string>();
    for (const e of this.edges) if (e.from === t.id && e.kind !== "import" && e.toType && !e.stdlib) seen.add(e.to);
    return seen.size;
  }
}

function placeOf(p: Project, node: ts.Node): Place {
  const sf = node.getSourceFile();
  return p.place(sf, node.getStart(sf), node.getEnd());
}

function filePlace(path: string): Place {
  return { file: path, startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 };
}

function isArrayType(checker: ts.TypeChecker, node: ts.Expression): boolean {
  const type = checker.getTypeAtLocation(node);
  const name = type.symbol?.name;
  return name === "Array" || name === "ReadonlyArray" || checker.isArrayType?.(type) === true || checker.isTupleType?.(type) === true;
}

function isStringType(checker: ts.TypeChecker, node: ts.Expression): boolean {
  return !!(checker.getTypeAtLocation(node).flags & ts.TypeFlags.StringLike);
}

const searches = new Set(["includes", "indexOf", "lastIndexOf", "find", "findIndex", "findLast", "findLastIndex"]);
const materializing = new Set(["slice", "concat"]);

/** Every detector by rule id; its texts are templates of that rule in spec (checked by text.test.ts). */
export const detectors: Record<string, (r: Run) => void> = {
  CC001(r) {
    const limit = r.number("maxLines");
    r.functions((f) => {
      const lines = lineSpan(f.place);
      if (!f.body || lines <= limit) return;
      r.report("high", f.place, f.module.id, f.id, tx("{0} spans {1} lines", f.name, lines), tx("The line count is exact; the limit of {0} is a readability convention.", limit), { metric: "lines", value: lines, threshold: limit }, lines > limit * 2 ? "major" : undefined);
    });
  },

  CC002(r) {
    const maxLines = r.number("maxLines");
    const maxMembers = r.number("maxMembers");
    r.types((t) => {
      const lines = lineSpan(t.place);
      const count = t.members.length + t.methods.filter((m) => m.kind !== "accessor").length;
      if (t.kind === "type" || (lines <= maxLines && count <= maxMembers)) return;
      const measured = lines > maxLines ? { metric: "lines", value: lines, threshold: maxLines } : undefined;
      r.report("high", t.place, t.module.id, t.id, tx("{0} has {1} lines and {2} members", t.name, lines, count), tx("The counts are exact; the limits ({0} lines, {1} members) are conventions.", maxLines, maxMembers), measured);
    });
  },

  CC003(r) {
    const limit = r.number("maxParameters");
    const constructors = r.number("maxConstructorParameters");
    r.functions((f) => {
      const count = parameterCount(f);
      const own = f.kind === "constructor" ? constructors : limit;
      if (count > own) {
        r.report("high", f.place, f.module.id, f.id, tx("{0} takes {1} parameters", f.name, count), tx("The limit is {0}. Long lists are easy to misorder; a parameter object groups what belongs together.", own), { metric: "parameterCount", value: count, threshold: own });
      }
    });
  },

  CC004(r) {
    const limit = r.number("maxDepth");
    r.functions((f) => {
      const depth = maxNesting(f);
      if (depth > limit) r.report("high", f.place, f.module.id, f.id, tx("{0} nests {1} levels deep", f.name, depth), tx("The limit is {0}. Guard clauses or extracted functions flatten the flow.", limit), { metric: "maxNesting", value: depth, threshold: limit });
    });
  },

  CC009(r) {
    r.functions((f) => {
      walkBody(f, (n) => {
        if (!ts.isCatchClause(n) || n.block.statements.length > 0) return;
        const sf = n.getSourceFile();
        const inner = sf.text.slice(n.block.getStart(sf) + 1, n.block.getEnd() - 1);
        if (/\/\/|\/\*/.test(inner)) return; // a comment says why ignoring is safe
        r.report("high", placeOf(r.p, n), f.module.id, f.id, tx("Empty catch in {0}", f.name), tx("The exception disappears without handling, logging or a comment saying why that is safe."));
      });
    });
  },

  ALG001(r) {
    const reportFrom = r.number("reportFromDegree");
    r.functions((f) => {
      const growth = r.estimates.get(f.id);
      if (!growth || (!growth.exponential && growth.degree < reportFrom)) return;
      const uncertain = growth.uncertain;
      const explanation = uncertain
        ? tx("Estimated from recursion, a while loop or a callee; loop bounds and call counts are not known exactly.")
        : tx("Estimated from nested loops over inputs of unknown size. Small inputs may make this irrelevant.");
      const measured = growth.exponential ? { metric: "timeExponential", value: 1, threshold: 1 } : { metric: "timeDegree", value: growth.degree, threshold: reportFrom };
      r.report(uncertain ? "low" : "medium", f.place, f.module.id, f.id, tx("{0} is likely {1}", f.name, growthText(growth)), explanation, measured, growth.exponential ? "major" : undefined);
    });
  },

  ALG002(r) {
    r.functions((f) => {
      const checker = f.file.checker;
      walkLoops(f, (n, depth) => {
        if (depth === 0) return;
        if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
          const method = n.expression.name.text;
          const receiver = n.expression.expression;
          if (searches.has(method) && isArrayType(checker, receiver)) {
            r.report("medium", placeOf(r.p, n), f.module.id, f.id, tx("Likely quadratic: {0} on a sequence inside a loop", method), tx("Each iteration scans the array. A Set or Map built once makes the lookup constant-time."));
          }
          const front = method === "unshift" || (method === "splice" && n.arguments.length >= 3 && ts.isNumericLiteral(n.arguments[0]) && n.arguments[0].text === "0" && ts.isNumericLiteral(n.arguments[1]) && n.arguments[1].text === "0");
          if (front && isArrayType(checker, receiver)) {
            r.report("medium", placeOf(r.p, n), f.module.id, f.id, tx("Likely quadratic: front insertion inside a loop"), tx("Every element shifts on each call. Pushing and reversing once avoids this."));
          }
        }
        if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken && isStringType(checker, n.left) && !ts.isElementAccessExpression(n.left)) {
          r.report("medium", placeOf(r.p, n), f.module.id, f.id, tx("Likely quadratic: String concatenation inside a loop"), tx("Each step copies the whole string so far. Collecting the parts in an array and joining once avoids this."));
        }
      });
    });
  },

  ALG003(r) {
    const limit = r.number("minDepthForObjects");
    r.functions((f) => {
      const measured = { metric: "allocationDepth", value: 0, threshold: limit };
      const reported: ts.Node[] = [];
      walkLoops(f, (n, depth) => {
        if (allocates(n)) measured.value = Math.max(measured.value, depth);
      });
      walkLoops(f, (n, depth) => {
        if (depth >= 1 && ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && materializing.has(n.expression.name.text)
          && isArrayType(f.file.checker, n.expression.expression)) {
          r.report("medium", placeOf(r.p, n), f.module.id, f.id, tx("{0} allocates on each loop iteration", `${n.expression.name.text}()`), tx("A new collection is built per iteration; moving it out of the loop or reusing a buffer reduces GC pressure."));
        }
        if (depth < limit || !allocates(n) || reported.some((outer) => n.pos >= outer.pos && n.end <= outer.end)) return;
        reported.push(n);
        const place = placeOf(r.p, n);
        if (isFunctionValue(n)) {
          r.report("low", place, f.module.id, f.id, tx("Lambda in a nested loop"), tx("Every evaluation of a lambda creates a new function object."), { ...measured });
        } else if (ts.isNewExpression(n)) {
          r.report("low", place, f.module.id, f.id, tx("Allocation of {0} in a nested loop", n.expression.getText().replace(/\s+/g, " ")), tx("Runs once per inner iteration. Whether it matters depends on how hot the loop really is, which static analysis cannot tell."), { ...measured });
        } else {
          r.report("low", place, f.module.id, f.id, tx("Allocation in a nested loop"), tx("Runs once per inner iteration. Whether it matters depends on how hot the loop really is, which static analysis cannot tell."), { ...measured });
        }
      });
    });
  },

  ALG004(r) {
    const reportFrom = r.number("reportFromDegree");
    r.functions((f) => {
      if (!f.body) return;
      const degree = spaceDegree(f, selfCalls(r.p, f).length);
      if (degree >= reportFrom) {
        r.report("low", f.place, f.module.id, f.id, tx("{0} likely uses {1} extra memory", f.name, growthText({ degree, log: 0, exponential: false, uncertain: false })), tx("Estimated from collection growth under nested loops or multi-dimensional allocation sizes."), { metric: "spaceDegree", value: degree, threshold: reportFrom });
      }
    });
  },

  DSN001(r) {
    const limit = r.number("maxDistance");
    const coupling = r.number("minCoupling");
    for (const m of r.p.modules) {
      const { ca, ce, instability, abstractness, distance } = r.martin(m);
      if (distance === null || distance <= limit || ca + ce < coupling || m.types.length === 0) continue;
      const explanation = instability! < 0.5
        ? tx("A = {0}, I = {1}, so it sits near the zone of pain: concrete and heavily depended upon.", fixed(abstractness!, 2), fixed(instability!, 2))
        : tx("A = {0}, I = {1}, so it sits near the zone of uselessness: abstract and unused.", fixed(abstractness!, 2), fixed(instability!, 2));
      r.report("medium", m.types[0].place, m.id, "", tx("Module {0} is far from the main sequence (D = {1})", m.id, fixed(distance, 2)), explanation, { metric: "distance", value: distance, threshold: limit });
    }
  },

  DSN002(r) {
    for (const cycle of components(r.graphs.runtimeModules)) {
      const m = r.p.modules.find((x) => x.id === cycle[0]);
      if (m) r.report("high", filePlace(m.file.path), m.id, "", tx("Module cycle: {0}", cycle.join(" <-> ")), tx("These modules depend on each other, directly or transitively, so none can be built, tested or released alone."));
    }
    for (const cycle of components(r.graphs.runtimeUnits)) {
      const unit = r.p.types.get(cycle[0]) ?? r.p.functions.get(cycle[0]);
      if (!unit) continue;
      r.report("high", unit.place, unit.module.id, cycle[0], tx("Type cycle of {0}: {1}", cycle.length, cycle.map(simpleName).join(" <-> ")), tx("These units reference each other, so a change to one can ripple through all of them."), undefined, "minor");
    }
  },

  DSN003(r) {
    if (r.config.layers.length === 0) return;
    for (const e of r.edges) {
      if (e.external || e.kind === "import") continue;
      const from = r.graphs.moduleOf.get(e.from);
      const to = r.graphs.moduleOf.get(e.to);
      if (!from || !to || from === to) continue;
      const source = r.config.layerOf(from.id);
      const target = r.config.layerOf(to.id);
      if (!source || !target || source.name === target.name || source.mayDependOn.includes(target.name)) continue;
      const explanation = source.mayDependOn.length > 0
        ? tx("{0} ({1}) uses {2} ({3}); allowed: {4}.", simpleName(e.from), from.id, simpleName(e.to), to.id, source.mayDependOn.join(", "))
        : tx("{0} ({1}) uses {2} ({3}); allowed: none.", simpleName(e.from), from.id, simpleName(e.to), to.id);
      r.report("high", e.place, from.id, e.from, tx("{0} must not depend on {1}", source.name, target.name), explanation);
    }
  },

  DSN004(r) {
    const minWmc = r.number("minWmc");
    const minAtfd = r.number("minAtfd");
    const maxTcc = r.number("maxTcc");
    r.types((t) => {
      if (t.kind !== "class") return;
      const w = wmc(t);
      const a = atfd(r.p, t);
      const c = tcc(r.p, t);
      if (w >= minWmc && a >= minAtfd && c !== null && c < maxTcc) {
        r.report("medium", t.place, t.module.id, t.id, tx("{0} looks like a god class", t.name), tx("WMC = {0} (>= {1}), ATFD = {2} (>= {3}), TCC = {4} (< {5}): it does much, uses others' data, and its methods share little.", w, minWmc, a, minAtfd, fixed(c, 2), fixed(maxTcc, 2)), { metric: "wmc", value: w, threshold: minWmc });
      }
    });
  },

  DSN005(r) {
    const limit = r.number("minForeignMembers");
    r.functions((f) => {
      if (!isInstanceMethod(f)) return;
      const { owner, members } = mostUsedForeign(r.p, f);
      const own = memberUse(r.p, f).own.size;
      if (members.length >= limit && members.length > own) {
        r.report("medium", f.place, f.module.id, f.id, tx("{0} is more interested in {1} than in {2}", f.name, simpleName(owner), f.owner!.name), tx("It uses {0} members of {1} ({2}) and {3} of its own.", members.length, owner, members.join(", "), own), { metric: "foreignMembers", value: members.length, threshold: limit });
      }
    });
  },

  DSN006(r) {
    const limit = r.number("maxDependents");
    for (const t of r.p.allTypes()) {
      const radius = r.graphs.radius.get(t.id) ?? 0;
      if (radius > limit) {
        r.report("medium", t.place, t.module.id, t.id, tx("Changing {0} can reach {1} units", t.name, radius), tx("Stable abstractions at such points limit the spread. Static dependencies overstate real impact when a change keeps the contract."), { metric: "blastRadius", value: radius, threshold: limit });
      }
    }
  },

  FUN005(r) {
    const maxOrder = r.number("maxOrder");
    const maxNestingOfLambdas = r.number("maxLambdaNesting");
    r.functions((f) => {
      const order = hofOrder(f);
      if (order > maxOrder) r.report("medium", f.place, f.module.id, f.id, tx("{0} has order {1}", f.name, order), tx("The signature nests function types beyond order {0}.", maxOrder), { metric: "hofOrder", value: order, threshold: maxOrder });
      const nesting = lambdaNesting(f);
      if (nesting > maxNestingOfLambdas) r.report("medium", f.place, f.module.id, f.id, tx("{0} nests lambdas {1} levels deep", f.name, nesting), tx("Beyond {0} levels, captured variables are hard to trace; named functions help.", maxNestingOfLambdas), { metric: "lambdaNesting", value: nesting, threshold: maxNestingOfLambdas });
    });
  },

  MNT001(r) {
    const limit = r.number("maxComplexity");
    r.functions((f) => {
      const complexity = cyclomatic(f);
      if (!f.body || complexity <= limit) return;
      r.report("high", f.place, f.module.id, f.id, tx("{0} has cyclomatic complexity {1}", f.name, complexity), tx("The count is exact; above {0}, the number of paths to test and to understand grows quickly.", limit), { metric: "cyclomatic", value: complexity, threshold: limit }, complexity > limit * 2 ? "major" : undefined);
    });
  },

  MNT002(r) {
    const limit = r.number("minIndex");
    r.functions((f) => {
      const index = maintainabilityIndex(f);
      if (!f.body || index === null || index >= limit) return;
      r.report("medium", f.place, f.module.id, f.id, tx("{0} has a maintainability index of {1}", f.name, fixed(index, 0)), tx("Below {0}. The formula is an empirical blend of size and complexity, useful for ranking rather than as a measure of quality.", limit), { metric: "maintainabilityIndex", value: round(index, 4), threshold: limit });
    });
  },

  MNT003(r) {
    const window = r.number("minTokens");
    const base = 1000003;
    const modulus = 1000000007;
    const ids = new Map<string, number>();
    const files = r.p.files.map((file) => ({ file, tokens: normalized(file, ids) })).filter((x) => x.tokens.length >= window);
    let power = 1;
    for (let i = 1; i < window; i++) power = (power * base) % modulus;
    const seen = new Map<number, { file: number; at: number }[]>();
    files.forEach(({ file, tokens }, index) => {
      let hash = 0;
      for (let i = 0; i < window; i++) hash = (hash * base + tokens[i].id) % modulus;
      let skipUntil = 0;
      for (let at = 0; at + window <= tokens.length; at++) {
        if (at > 0) {
          hash = (hash - ((tokens[at - 1].id * power) % modulus) + modulus) % modulus;
          hash = (hash * base + tokens[at + window - 1].id) % modulus;
        }
        if (at >= skipUntil) {
          for (const earlier of seen.get(hash) ?? []) {
            const other = files[earlier.file].tokens;
            let length = 0;
            while (earlier.at + length < other.length && at + length < tokens.length && other[earlier.at + length].id === tokens[at + length].id) length++;
            if (length < window || (earlier.file === index && earlier.at + length > at)) continue;
            skipUntil = at + length;
            const place = { file: file.path, startLine: tokens[at].line, startColumn: 1, endLine: tokens[at + length - 1].line, endColumn: 1 };
            r.report("high", place, "", "", tx("{0} tokens duplicate {1}:{2}", length, files[earlier.file].file.path, other[earlier.at].line), tx("The token sequences are identical after replacing identifiers and literals with placeholders."), { metric: "cloneTokens", value: length, threshold: window });
            break;
          }
        }
        const list = seen.get(hash) ?? [];
        list.push({ file: index, at });
        seen.set(hash, list);
      }
    });
  },

  MNT004(r) {
    if (!r.coverage) return;
    const limit = r.number("minCoverage");
    const report = String(r.config.threshold(r.rule, "report") ?? "");
    for (const f of r.p.files) {
      const percent = r.coverage.percent(f.path);
      if (percent !== undefined && percent < limit) {
        r.report("high", filePlace(f.path), "", "", tx("{0} has {1}% line coverage", f.path, fixed(percent, 0)), tx("Measured from {0}; below the {1}% minimum. Coverage shows what ran, not what was verified.", report, limit), { metric: "coverage", value: percent, threshold: limit });
      }
    }
  },

  OOP001(r) {
    r.types((t) => {
      if (t.kind !== "class") return;
      for (const member of t.members) {
        if (member.kind === "field" && member.visibility === "public" && member.mutable && !member.isStatic) {
          r.report("medium", placeOf(r.p, member.node), t.module.id, t.id, tx("Public mutable field {0}.{1}", t.name, member.name), tx("Any caller can change this field, so the type cannot protect its invariants. A property or a method can."));
        }
      }
    });
  },

  OOP002(r) {
    const limit = r.number("maxDepth");
    r.types((t) => {
      if (t.kind !== "class") return;
      const depth = dit(r.p, t);
      if (depth > limit) r.report("medium", t.place, t.module.id, t.id, tx("{0} sits {1} levels deep", t.name, depth), tx("The depth counts base classes in the project; a base outside it is one step. Beyond {0} levels, behavior is spread over many classes. Composition often reads better.", limit), { metric: "dit", value: depth, threshold: limit });
    });
  },

  OOP003(r) {
    const limit = r.number("minTypeTests");
    r.functions((f) => {
      const tested = testedTypes(r.p, f);
      if (tested.length >= limit) {
        r.report("medium", f.place, f.module.id, f.id, tx("{0} branches on {1} runtime types", f.name, tested.length), tx("It tests for {0}. A virtual member on their common base would dispatch without the checks.", tested.map(simpleName).join(", ")), { metric: "typeTests", value: tested.length, threshold: limit });
      }
    });
  },

  OOP004(r) {
    const maxLcom = r.number("maxLcom");
    const minMethods = r.number("minMethods");
    r.types((t) => {
      if (t.kind !== "class") return;
      const lcom = lcom4(r.p, t);
      if (lcom !== null && lcom > maxLcom && t.methods.filter((m) => m.kind === "method" && !m.isStatic && m.body).length >= minMethods) {
        r.report("medium", t.place, t.module.id, t.id, tx("{0} splits into {1} unrelated method groups", t.name, lcom), tx("LCOM4 finds method groups that share no field and do not call each other; each may be a separate class."), { metric: "lcom4", value: lcom, threshold: maxLcom });
      }
    });
  },

  OOP005(r) {
    const limit = r.number("maxCoupling");
    r.types((t) => {
      if (t.kind !== "class") return;
      const coupling = r.cbo(t);
      if (coupling > limit) r.report("medium", t.place, t.module.id, t.id, tx("{0} depends on {1} types", t.name, coupling), tx("Beyond {0} collaborators, changes elsewhere are likely to reach this class.", limit), { metric: "cbo", value: coupling, threshold: limit });
    });
  },

  PRN007(r) {
    const limit = r.number("maxBooleanOperators");
    r.functions((f) => {
      const counted: ts.Node[] = [];
      walkBody(f, (n) => {
        if (ts.isConditionalExpression(n) && (ts.isConditionalExpression(unwrap(n.whenTrue)) || ts.isConditionalExpression(unwrap(n.whenFalse)))) {
          r.report("medium", placeOf(r.p, n), f.module.id, f.id, tx("Nested ternary expression"), tx("A ternary inside a ternary hides the branching; an if or a switch expression shows it."));
        }
        const condition = ts.isIfStatement(n) || ts.isWhileStatement(n) || ts.isDoStatement(n) ? n.expression : ts.isConditionalExpression(n) ? n.condition : ts.isForStatement(n) ? n.condition : undefined;
        if (!condition || counted.includes(condition)) return;
        counted.push(condition);
        let operators = 0;
        walk(condition, (c) => {
          if (ts.isBinaryExpression(c) && (c.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || c.operatorToken.kind === ts.SyntaxKind.BarBarToken)) operators++;
          return !isFunctionValue(c);
        });
        if (operators > limit) {
          r.report("medium", placeOf(r.p, condition), f.module.id, f.id, tx("Condition combines {0} boolean operators", operators), tx("More than {0} operators in one condition; named intermediate values or a predicate method would state the intent.", limit));
        }
      });
    });
  },

  SEC001(r) {
    for (const m of r.p.modules) {
      const sf = m.file.sf;
      const owner = (n: ts.Node): string => {
        for (let x: ts.Node | undefined = n; x; x = x.parent) {
          const entry = r.p.lookup(x);
          if (entry && "fn" in entry) return entry.fn.id;
        }
        return "";
      };
      walk(sf, (n) => {
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) checkSecret(r, m, n.name.text, n.initializer, owner(n));
        else if (ts.isPropertyAssignment(n) && (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name))) checkSecret(r, m, n.name.text, n.initializer, owner(n));
        else if (ts.isPropertyDeclaration(n) && n.initializer && (ts.isIdentifier(n.name) || ts.isPrivateIdentifier(n.name))) checkSecret(r, m, n.name.text, n.initializer, owner(n));
        else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          const target = ts.isIdentifier(n.left) ? n.left.text : ts.isPropertyAccessExpression(n.left) ? n.left.name.text : "";
          if (target) checkSecret(r, m, target, n.right, owner(n));
        }
      });
    }
  },

  SEC003(r) {
    for (const m of r.p.modules) {
      for (const f of moduleFunctions(m)) {
        const inner = new Set<ts.Node>();
        walkBody(f, (n) => {
          if (inner.has(n)) return;
          let text = "";
          let dynamic = false;
          if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
            const parts = (x: ts.Expression) => {
              x = unwrap(x);
              if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.PlusToken) {
                inner.add(x);
                parts(x.left);
                parts(x.right);
              } else if (ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) text += x.text;
              else dynamic = true;
            };
            parts(n);
          } else if (ts.isTemplateExpression(n) && !ts.isTaggedTemplateExpression(n.parent)) {
            text = n.head.text + n.templateSpans.map((s) => s.literal.text).join(" ");
            dynamic = n.templateSpans.length > 0;
          } else {
            return;
          }
          if (dynamic && sqlText.test(text)) {
            r.report("medium", placeOf(r.p, n), m.id, f.id, tx("SQL built from non-constant values"), tx("Heuristic: if any value comes from a user, this allows injection. Parameterized queries keep data out of the statement."));
          }
        });
      }
    }
  },

  STR002(r) {
    for (const m of r.p.modules) {
      if (!r.applies(m)) continue;
      for (const g of m.globals) r.report("high", g.place, m.id, "", tx("Global variable {0}", g.name), tx("Any function can change it, so its value depends on the call history."));
      for (const t of m.types) {
        for (const member of t.members) {
          if (!member.isStatic || !member.mutable || member.visibility === "private") continue;
          if (member.kind === "property") r.report("high", placeOf(r.p, member.node), m.id, t.id, tx("Global mutable property {0}.{1}", t.name, member.name), tx("A static settable property is shared by all code and threads."));
          else r.report("high", placeOf(r.p, member.node), m.id, t.id, tx("Global mutable field {0}.{1}", t.name, member.name), tx("A non-private static mutable field is shared by all code and threads."));
        }
      }
    }
  },

  STR003(r) {
    const maxModule = r.number("maxModuleLines");
    const maxFile = r.number("maxFileLines");
    for (const m of r.p.modules) {
      if (!r.applies(m)) continue;
      if (m.file.loc > maxModule) r.report("high", filePlace(m.file.path), m.id, "", tx("Module {0} has {1} lines of code", m.id, m.file.loc), tx("The limit is {0}; a smaller module is easier to understand as a unit.", maxModule), { metric: "loc", value: m.file.loc, threshold: maxModule });
      if (m.file.lines > maxFile) r.report("high", filePlace(m.file.path), "", "", tx("{0} has {1} lines", m.file.path, m.file.lines), tx("The limit is {0}.", maxFile), { metric: "lines", value: m.file.lines, threshold: maxFile });
    }
  },
};

const secretName = /password|passwd|pwd|secret|api_?key|apikey|access_?token|auth_?token|private_?key/i;
const knownCredential = /AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|sk-[A-Za-z0-9]{32,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[baprs]-[A-Za-z0-9-]{10,}/;
const sqlText = /\b(SELECT\s[\s\S]+\sFROM|INSERT\s+INTO|UPDATE\s[\s\S]+\sSET|DELETE\s+FROM|DROP\s+TABLE)\b/i;

function checkSecret(r: Run, m: Module, name: string, value: ts.Expression, entity: string): void {
  value = unwrap(value);
  if (!(ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) || value.text.length < 6) return;
  const text = value.text;
  const place = placeOf(r.p, value);
  if (knownCredential.test(text)) {
    r.report("high", place, m.id, entity, tx("{0} holds what looks like a real credential", name), tx("Heuristic: the literal matches the format of a known key or token. Rotate it if it is real, and load it from a secret store."), undefined, "critical");
  } else if (secretName.test(name) && !/[ {]/.test(text)) {
    r.report("medium", place, m.id, entity, tx("{0} looks like a hardcoded secret", name), tx("Heuristic: the name suggests a secret and the value is a literal. It may be a placeholder or a non-secret value."));
  }
}

function walk(node: ts.Node, visit: (n: ts.Node) => boolean | void): void {
  const go = (n: ts.Node) => {
    if (visit(n) === false) return;
    ts.forEachChild(n, go);
  };
  go(node);
}

/** Tokens with identifiers and literals replaced by placeholders, import lines left out (spec/metrics.md). */
function normalized(file: SourceInfo, ids: Map<string, number>): { id: number; line: number }[] {
  const list: { id: number; line: number }[] = [];
  for (const t of file.tokens) {
    if (file.importLines.has(t.line)) continue;
    let text = t.text;
    if (t.kind === ts.SyntaxKind.Identifier || t.kind === ts.SyntaxKind.PrivateIdentifier) text = "$id";
    else if (t.kind >= ts.SyntaxKind.FirstLiteralToken && t.kind <= ts.SyntaxKind.LastTemplateToken) text = "$lit";
    else if (t.kind === ts.SyntaxKind.JsxText) text = "$lit";
    let id = ids.get(text);
    if (id === undefined) {
      id = ids.size + 1;
      ids.set(text, id);
    }
    list.push({ id, line: t.line });
  }
  return list;
}

/** Deduplicates and orders findings by file, line, column, rule and message. */
export function sortFindings(list: Finding[]): Finding[] {
  const seen = new Set<string>();
  const unique = list.filter((f) => {
    const key = `${f.rule}|${JSON.stringify(f.place)}|${f.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique.sort((a, b) => ordinal(a.place.file, b.place.file) || a.place.startLine - b.place.startLine || a.place.startColumn - b.place.startColumn
    || ordinal(a.rule, b.rule) || ordinal(a.message, b.message));
}
