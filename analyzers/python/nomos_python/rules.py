"""The detectors. Every finding text is a template of its rule in spec/rules (checked by tests/test_text.py)."""
from __future__ import annotations

import ast
import hashlib
import re
from dataclasses import dataclass, field

from .estimate import Growth, growth_text, self_calls
from .graph import components, simple_name
from .metrics import (
    allocates, atfd, class_instantiation, cyclomatic, dit, hof_order, is_instance_method, lambda_nesting, lcom4, line_span, maintainability_index,
    max_nesting, member_use, most_used_foreign, parameter_count, round_to, space_degree, tcc, tested_types, walk_body, walk_loops, wmc,
)
from .paradigms import module_functions
from .project import Fn, FnRef, Place, TypeRef, dotted
from .text import Text, fixed, render, tx


@dataclass
class Finding:
    rule: str
    severity: str
    confidence: str
    category: str
    place: Place
    message: str
    explanation: str
    module: str
    entity: str
    message_text: Text
    explanation_text: Text
    measured: dict = None


def fingerprint(f: Finding) -> str:
    """Does not depend on the line (contracts/sarif-profile.md)."""
    return hashlib.sha256(f"{f.rule}|{f.place.file}|{f.entity}|{f.message}".encode("utf-8")).hexdigest()[:16]


# The rules implemented for Python. STR001: the language has no goto; the others are not written (D-057).
SUPPORTED = [
    "ALG001", "ALG002", "ALG003", "ALG004", "CC001", "CC002", "CC003", "CC004", "CC009", "DSN001", "DSN002", "DSN003", "DSN004", "DSN005", "DSN006",
    "FUN005", "MNT001", "MNT002", "MNT003", "MNT004", "OOP001", "OOP002", "OOP003", "OOP004", "OOP005", "PRN007", "SEC001", "SEC003", "STR002", "STR003",
]


class Run:
    """State of one analysis shared by the detectors."""

    def __init__(self, p, config, edges, graphs, estimates) -> None:
        self.p = p
        self.config = config
        self.edges = edges
        self.graphs = graphs
        self.estimates = estimates
        self.findings: list = []
        self.rule = None
        self.ran: dict = {}
        self.active: dict = {}
        self.coverage = None

    def applies(self, m) -> bool:
        paradigms = self.rule["paradigms"]
        return not paradigms or any(x in self.active.get(m.id, set()) for x in paradigms)

    def number(self, name: str):
        return self.config.number(self.rule, name)

    def report(self, confidence, place, module, entity, message: Text, explanation: Text, measured=None, severity=None) -> None:
        level = (self.config.rules.get(self.rule["id"]) or {}).get("severity") or severity or self.rule["severity"]
        self.findings.append(Finding(self.rule["id"], level, confidence, self.rule["category"], place, render(message), render(explanation),
                                     module, entity, message, explanation, measured))

    def functions(self):
        for m in self.p.modules:
            if self.applies(m):
                yield from module_functions(m)

    def types(self):
        for m in self.p.modules:
            if self.applies(m):
                yield from m.types

    def martin(self, m) -> dict:
        inside = {u.id for u in m.types} | {f.id for f in m.functions}
        incoming, outgoing = set(), set()
        for unit in inside:
            incoming |= {o for o in self.graphs.units.prev.get(unit, ()) if o not in inside}
            outgoing |= {o for o in self.graphs.units.next.get(unit, ()) if o not in inside}
        ca, ce = len(incoming), len(outgoing)
        instability = round_to(ce / (ca + ce), 4) if ca + ce > 0 else None
        abstractness = round_to(sum(1 for t in m.types if t.is_abstract) / len(m.types), 4) if m.types else None
        distance = round_to(abs(abstractness + instability - 1), 4) if instability is not None and abstractness is not None else None
        return {"ca": ca, "ce": ce, "instability": instability, "abstractness": abstractness, "distance": distance}

    def cbo(self, t) -> int:
        return len({e.to for e in self.edges if e.source == t.id and e.kind != "import" and e.to_type and not e.stdlib})


def node_place(r: Run, f_or_module, node: ast.AST) -> Place:
    info = f_or_module.file
    return r.p.place(info, node)


def file_place(path: str) -> Place:
    return Place(path, 1, 1, 1, 1)


def value_kind(r: Run, f: Fn, node: ast.AST):
    value = r.p.resolver.value_of(node, r.p.resolver.scope_of(f))
    return value.builtin if value is not None else None


MATERIALIZING = {"list", "tuple", "set", "dict", "sorted"}


def _cc001(r: Run) -> None:
    limit = r.number("maxLines")
    for f in r.functions():
        lines = line_span(f.place)
        if not f.has_body or lines <= limit:
            continue
        r.report("high", f.place, f.module.id, f.id, tx("{0} spans {1} lines", f.name, lines),
                 tx("The line count is exact; the limit of {0} is a readability convention.", limit),
                 {"metric": "lines", "value": lines, "threshold": limit}, "major" if lines > limit * 2 else None)


def _cc002(r: Run) -> None:
    max_lines = r.number("maxLines")
    max_members = r.number("maxMembers")
    for t in r.types():
        lines = line_span(t.place)
        count = member_count(t)
        if lines <= max_lines and count <= max_members:
            continue
        measured = {"metric": "lines", "value": lines, "threshold": max_lines} if lines > max_lines else None
        r.report("high", t.place, t.module.id, t.id, tx("{0} has {1} lines and {2} members", t.name, lines, count),
                 tx("The counts are exact; the limits ({0} lines, {1} members) are conventions.", max_lines, max_members), measured)


def member_count(t) -> int:
    return len(t.members) + len([m for m in t.methods if m.kind != "accessor"]) + len(t.nested)


def _cc003(r: Run) -> None:
    limit = r.number("maxParameters")
    constructors = r.number("maxConstructorParameters")
    for f in r.functions():
        count = parameter_count(f)
        own = constructors if f.kind == "constructor" else limit
        if count > own:
            r.report("high", f.place, f.module.id, f.id, tx("{0} takes {1} parameters", f.name, count),
                     tx("The limit is {0}. Long lists are easy to misorder; a parameter object groups what belongs together.", own),
                     {"metric": "parameterCount", "value": count, "threshold": own})


def _cc004(r: Run) -> None:
    limit = r.number("maxDepth")
    for f in r.functions():
        depth = max_nesting(f)
        if depth > limit:
            r.report("high", f.place, f.module.id, f.id, tx("{0} nests {1} levels deep", f.name, depth),
                     tx("The limit is {0}. Guard clauses or extracted functions flatten the flow.", limit), {"metric": "maxNesting", "value": depth, "threshold": limit})


def _cc009(r: Run) -> None:
    for f in r.functions():
        info = f.file
        for n in walk_body(f):
            if not isinstance(n, ast.ExceptHandler) or not all(isinstance(s, ast.Pass) or (isinstance(s, ast.Expr) and isinstance(s.value, ast.Constant) and s.value.value is Ellipsis) for s in n.body):
                continue
            # A comment in the handler says why ignoring is safe.
            if any(n.lineno <= line <= n.end_lineno for line in info.comment_lines):
                continue
            r.report("high", r.p.place(info, n), f.module.id, f.id, tx("Empty catch in {0}", f.name),
                     tx("The exception disappears without handling, logging or a comment saying why that is safe."))


def _alg001(r: Run) -> None:
    report_from = r.number("reportFromDegree")
    for f in r.functions():
        growth = r.estimates.get(f.id)
        if growth is None or (not growth.exponential and growth.degree < report_from):
            continue
        if growth.uncertain:
            explanation = tx("Estimated from recursion, a while loop or a callee; loop bounds and call counts are not known exactly.")
        else:
            explanation = tx("Estimated from nested loops over inputs of unknown size. Small inputs may make this irrelevant.")
        measured = {"metric": "timeExponential", "value": 1, "threshold": 1} if growth.exponential else {"metric": "timeDegree", "value": growth.degree, "threshold": report_from}
        r.report("low" if growth.uncertain else "medium", f.place, f.module.id, f.id, tx("{0} is likely {1}", f.name, growth_text(growth)), explanation, measured,
                 "major" if growth.exponential else None)


def _alg002(r: Run) -> None:
    for f in r.functions():
        found = []

        def visit(n, depth, f=f, found=found):
            if depth == 0:
                return
            if isinstance(n, ast.Compare) and any(isinstance(op, (ast.In, ast.NotIn)) for op in n.ops) and not isinstance(n.comparators[-1], (ast.List, ast.Tuple)) \
                    and value_kind(r, f, n.comparators[-1]) in ("list", "tuple"):
                found.append((n, "search", "in"))
            if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and value_kind(r, f, n.func.value) == "list":
                method = n.func.attr
                if method in ("index", "count"):
                    found.append((n, "search", method))
                if method == "insert" and n.args and isinstance(n.args[0], ast.Constant) and n.args[0].value == 0:
                    found.append((n, "front", method))
            if isinstance(n, ast.AugAssign) and isinstance(n.op, ast.Add) and isinstance(n.target, ast.Name) and value_kind(r, f, n.target) == "str":
                found.append((n, "concat", ""))

        walk_loops(f, visit)
        for n, kind, method in found:
            place = r.p.place(f.file, n)
            if kind == "search":
                r.report("medium", place, f.module.id, f.id, tx("Likely quadratic: {0} on a sequence inside a loop", method),
                         tx("Each iteration scans the list. A set or dict built once makes the lookup constant-time."))
            elif kind == "front":
                r.report("medium", place, f.module.id, f.id, tx("Likely quadratic: front insertion inside a loop"),
                         tx("Every element shifts on each call. Appending and reversing once avoids this."))
            else:
                r.report("medium", place, f.module.id, f.id, tx("Likely quadratic: String concatenation inside a loop"),
                         tx("Each step copies the whole string so far. Collecting the parts in a list and joining once avoids this."))


def _alg003(r: Run) -> None:
    limit = r.number("minDepthForObjects")
    for f in r.functions():
        measured = {"metric": "allocationDepth", "value": 0, "threshold": limit}
        reported = []
        materialized = []

        def depth_of(n, depth, measured=measured, f=f):
            if allocates(r.p, f, n):
                measured["value"] = max(measured["value"], depth)

        walk_loops(f, depth_of)
        items = []

        def collect(n, depth, items=items):
            items.append((n, depth))

        walk_loops(f, collect)
        scope = r.p.resolver.scope_of(f)
        for n, depth in items:
            if depth >= 1 and isinstance(n, ast.Call):
                name = None
                if isinstance(n.func, ast.Name) and n.func.id in MATERIALIZING and r.p.resolver.is_builtin(n.func.id, scope):
                    name = n.func.id
                elif isinstance(n.func, ast.Attribute) and n.func.attr == "copy" and not n.args and not isinstance(r.p.resolver.resolve(n.func, scope), FnRef):
                    name = "copy"
                if name:
                    materialized.append(n)
                    r.report("medium", r.p.place(f.file, n), f.module.id, f.id, tx("{0} allocates on each loop iteration", f"{name}()"),
                             tx("A new collection is built per iteration; moving it out of the loop or reusing a buffer reduces GC pressure."))
            if depth < limit or not allocates(r.p, f, n) or any(_within(n, outer) for outer in reported):
                continue
            reported.append(n)
            place = r.p.place(f.file, n)
            if isinstance(n, ast.Lambda):
                r.report("low", place, f.module.id, f.id, tx("Lambda in a nested loop"), tx("Every evaluation of a lambda creates a new function object."), dict(measured))
            elif isinstance(n, ast.Call):
                r.report("low", place, f.module.id, f.id, tx("Allocation of {0} in a nested loop", class_instantiation(r.p, f, n)),
                         tx("Runs once per inner iteration. Whether it matters depends on how hot the loop really is, which static analysis cannot tell."), dict(measured))
            else:
                r.report("low", place, f.module.id, f.id, tx("Allocation in a nested loop"),
                         tx("Runs once per inner iteration. Whether it matters depends on how hot the loop really is, which static analysis cannot tell."), dict(measured))


def _within(node: ast.AST, outer: ast.AST) -> bool:
    if node is outer:
        return True
    start = (node.lineno, node.col_offset)
    end = (node.end_lineno, node.end_col_offset)
    return (outer.lineno, outer.col_offset) <= start and end <= (outer.end_lineno, outer.end_col_offset)


def _alg004(r: Run) -> None:
    report_from = r.number("reportFromDegree")
    for f in r.functions():
        if not f.has_body:
            continue
        degree = space_degree(r.p, f, len(self_calls(r.p, f)))
        if degree >= report_from:
            r.report("low", f.place, f.module.id, f.id, tx("{0} likely uses {1} extra memory", f.name, growth_text(Growth(degree))),
                     tx("Estimated from collection growth under nested loops or multi-dimensional allocation sizes."),
                     {"metric": "spaceDegree", "value": degree, "threshold": report_from})


def _dsn001(r: Run) -> None:
    limit = r.number("maxDistance")
    coupling = r.number("minCoupling")
    for m in r.p.modules:
        x = r.martin(m)
        if x["distance"] is None or x["distance"] <= limit or x["ca"] + x["ce"] < coupling or not m.types:
            continue
        a, i = fixed(x["abstractness"], 2), fixed(x["instability"], 2)
        if x["instability"] < 0.5:
            explanation = tx("A = {0}, I = {1}, so it sits near the zone of pain: concrete and heavily depended upon.", a, i)
        else:
            explanation = tx("A = {0}, I = {1}, so it sits near the zone of uselessness: abstract and unused.", a, i)
        r.report("medium", m.types[0].place, m.id, "", tx("Module {0} is far from the main sequence (D = {1})", m.id, fixed(x["distance"], 2)), explanation,
                 {"metric": "distance", "value": x["distance"], "threshold": limit})


def _dsn002(r: Run) -> None:
    by_id = {m.id: m for m in r.p.modules}
    for cycle in components(r.graphs.runtime_modules):
        m = by_id.get(cycle[0])
        if m is not None:
            r.report("high", file_place(m.file.path), m.id, "", tx("Module cycle: {0}", " <-> ".join(cycle)),
                     tx("These modules depend on each other, directly or transitively, so none can be built, tested or released alone."))
    for cycle in components(r.graphs.runtime_units):
        unit = r.p.types.get(cycle[0]) or r.p.functions.get(cycle[0])
        if unit is None:
            continue
        r.report("high", unit.place, unit.module.id, cycle[0], tx("Type cycle of {0}: {1}", len(cycle), " <-> ".join(simple_name(c) for c in cycle)),
                 tx("These units reference each other, so a change to one can ripple through all of them."), None, "minor")


def _dsn003(r: Run) -> None:
    if not r.config.layers:
        return
    for e in r.edges:
        if e.external or e.kind == "import":
            continue
        source_module = r.graphs.module_of.get(e.source)
        target_module = r.graphs.module_of.get(e.to)
        if source_module is None or target_module is None or source_module is target_module:
            continue
        source = r.config.layer_of(source_module.id)
        target = r.config.layer_of(target_module.id)
        if source is None or target is None or source["name"] == target["name"] or target["name"] in (source.get("mayDependOn") or []):
            continue
        allowed = source.get("mayDependOn") or []
        if allowed:
            explanation = tx("{0} ({1}) uses {2} ({3}); allowed: {4}.", simple_name(e.source), source_module.id, simple_name(e.to), target_module.id, ", ".join(allowed))
        else:
            explanation = tx("{0} ({1}) uses {2} ({3}); allowed: none.", simple_name(e.source), source_module.id, simple_name(e.to), target_module.id)
        r.report("high", e.place, source_module.id, e.source, tx("{0} must not depend on {1}", source["name"], target["name"]), explanation)


def _dsn004(r: Run) -> None:
    min_wmc = r.number("minWmc")
    min_atfd = r.number("minAtfd")
    max_tcc = r.number("maxTcc")
    for t in r.types():
        if t.kind != "class":
            continue
        w, a, c = wmc(t), atfd(r.p, t), tcc(r.p, t)
        if w >= min_wmc and a >= min_atfd and c is not None and c < max_tcc:
            r.report("low", t.place, t.module.id, t.id, tx("{0} looks like a god class", t.name),
                     tx("WMC = {0} (>= {1}), ATFD = {2} (>= {3}), TCC = {4} (< {5}): it does much, uses others' data, and its methods share little.",
                        w, min_wmc, a, min_atfd, fixed(c, 2), fixed(max_tcc, 2)), {"metric": "wmc", "value": w, "threshold": min_wmc})


def _dsn005(r: Run) -> None:
    limit = r.number("minForeignMembers")
    for f in r.functions():
        if not is_instance_method(f):
            continue
        owner, names = most_used_foreign(r.p, f)
        own = len(member_use(r.p, f)[0])
        if len(names) >= limit and len(names) > own:
            r.report("low", f.place, f.module.id, f.id, tx("{0} is more interested in {1} than in {2}", f.name, simple_name(owner), f.owner.name),
                     tx("It uses {0} members of {1} ({2}) and {3} of its own.", len(names), owner, ", ".join(names), own),
                     {"metric": "foreignMembers", "value": len(names), "threshold": limit})


def _dsn006(r: Run) -> None:
    limit = r.number("maxDependents")
    for t in r.p.all_types():
        radius = r.graphs.radius.get(t.id, 0)
        if radius > limit:
            r.report("medium", t.place, t.module.id, t.id, tx("Changing {0} can reach {1} units", t.name, radius),
                     tx("Stable abstractions at such points limit the spread. Static dependencies overstate real impact when a change keeps the contract."),
                     {"metric": "blastRadius", "value": radius, "threshold": limit})


def _fun005(r: Run) -> None:
    max_order = r.number("maxOrder")
    max_lambdas = r.number("maxLambdaNesting")
    for f in r.functions():
        order = hof_order(r.p, f)
        if order > max_order:
            r.report("medium", f.place, f.module.id, f.id, tx("{0} has order {1}", f.name, order), tx("The signature nests function types beyond order {0}.", max_order),
                     {"metric": "hofOrder", "value": order, "threshold": max_order})
        nesting = lambda_nesting(f)
        if nesting > max_lambdas:
            r.report("medium", f.place, f.module.id, f.id, tx("{0} nests lambdas {1} levels deep", f.name, nesting),
                     tx("Beyond {0} levels, captured variables are hard to trace; named functions help.", max_lambdas),
                     {"metric": "lambdaNesting", "value": nesting, "threshold": max_lambdas})


def _mnt001(r: Run) -> None:
    limit = r.number("maxComplexity")
    for f in r.functions():
        complexity = cyclomatic(f)
        if not f.has_body or complexity <= limit:
            continue
        r.report("high", f.place, f.module.id, f.id, tx("{0} has cyclomatic complexity {1}", f.name, complexity),
                 tx("The count is exact; above {0}, the number of paths to test and to understand grows quickly.", limit),
                 {"metric": "cyclomatic", "value": complexity, "threshold": limit}, "major" if complexity > limit * 2 else None)


def _mnt002(r: Run) -> None:
    limit = r.number("minIndex")
    for f in r.functions():
        index = maintainability_index(f)
        if not f.has_body or index is None or index >= limit:
            continue
        r.report("medium", f.place, f.module.id, f.id, tx("{0} has a maintainability index of {1}", f.name, fixed(index, 0)),
                 tx("Below {0}. The formula is an empirical blend of size and complexity, useful for ranking rather than as a measure of quality.", limit),
                 {"metric": "maintainabilityIndex", "value": round_to(index, 4), "threshold": limit})


def _mnt003(r: Run) -> None:
    window = r.number("minTokens")
    base = 1000003
    modulus = 1000000007
    ids: dict = {}
    files = [(file, normalized(file, ids)) for file in r.p.files]
    files = [x for x in files if len(x[1]) >= window]
    power = 1
    for _ in range(1, window):
        power = power * base % modulus
    seen: dict = {}
    for index, (file, tokens) in enumerate(files):
        h = 0
        for i in range(window):
            h = (h * base + tokens[i][0]) % modulus
        skip_until = 0
        at = 0
        while at + window <= len(tokens):
            if at > 0:
                h = (h - tokens[at - 1][0] * power % modulus + modulus) % modulus
                h = (h * base + tokens[at + window - 1][0]) % modulus
            if at >= skip_until:
                for earlier_file, earlier_at in seen.get(h, []):
                    other = files[earlier_file][1]
                    length = 0
                    while earlier_at + length < len(other) and at + length < len(tokens) and other[earlier_at + length][0] == tokens[at + length][0]:
                        length += 1
                    if length < window or (earlier_file == index and earlier_at + length > at):
                        continue
                    skip_until = at + length
                    place = Place(file.path, tokens[at][1], 1, tokens[at + length - 1][1], 1)
                    r.report("high", place, "", "", tx("{0} tokens duplicate {1}:{2}", length, files[earlier_file][0].path, other[earlier_at][1]),
                             tx("The token sequences are identical after replacing identifiers and literals with placeholders."),
                             {"metric": "cloneTokens", "value": length, "threshold": window})
                    break
            seen.setdefault(h, []).append((index, at))
            at += 1


def normalized(file, ids: dict) -> list:
    result = []
    for t in file.tokens:
        if t.line in file.import_lines:
            continue
        text = t.text
        if t.kind == "name":
            text = "$id"
        elif t.kind in ("number", "string"):
            text = "$lit"
        if text not in ids:
            ids[text] = len(ids) + 1
        result.append((ids[text], t.line))
    return result


def _mnt004(r: Run) -> None:
    if r.coverage is None:
        return
    limit = r.number("minCoverage")
    report = str(r.config.threshold(r.rule, "report") or "")
    for f in r.p.files:
        percent = r.coverage.percent(f.path)
        if percent is not None and percent < limit:
            r.report("high", file_place(f.path), "", "", tx("{0} has {1}% line coverage", f.path, fixed(percent, 0)),
                     tx("Measured from {0}; below the {1}% minimum. Coverage shows what ran, not what was verified.", report, limit),
                     {"metric": "coverage", "value": percent, "threshold": limit})


def _oop001(r: Run) -> None:
    for t in r.types():
        if t.kind != "class" or t.record:
            continue
        for member in t.members:
            if member.kind == "field" and member.visibility == "public" and member.mutable and not member.is_static:
                r.report("medium", r.p.place(t.module.file, member.node), t.module.id, t.id, tx("Public mutable field {0}.{1}", t.name, member.name),
                         tx("Any caller can change this field, so the type cannot protect its invariants. A property or a method can."))


def _oop002(r: Run) -> None:
    limit = r.number("maxDepth")
    for t in r.types():
        if t.kind != "class":
            continue
        depth = dit(r.p, t)
        if depth > limit:
            r.report("medium", t.place, t.module.id, t.id, tx("{0} sits {1} levels deep", t.name, depth),
                     tx("The depth counts base classes in the project; a base outside it is one step. Beyond {0} levels, behavior is spread over many classes. Composition often reads better.", limit),
                     {"metric": "dit", "value": depth, "threshold": limit})


def _oop003(r: Run) -> None:
    limit = r.number("minTypeTests")
    for f in r.functions():
        tested = tested_types(r.p, f)
        if len(tested) >= limit:
            r.report("medium", f.place, f.module.id, f.id, tx("{0} branches on {1} runtime types", f.name, len(tested)),
                     tx("It tests for {0}. A virtual member on their common base would dispatch without the checks.", ", ".join(simple_name(x) for x in tested)),
                     {"metric": "typeTests", "value": len(tested), "threshold": limit})


def _oop004(r: Run) -> None:
    max_lcom = r.number("maxLcom")
    min_methods = r.number("minMethods")
    for t in r.types():
        if t.kind != "class":
            continue
        lcom = lcom4(r.p, t)
        methods = [m for m in t.methods if m.kind == "method" and not m.is_static and m.has_body]
        if lcom is not None and lcom > max_lcom and len(methods) >= min_methods:
            r.report("medium", t.place, t.module.id, t.id, tx("{0} splits into {1} unrelated method groups", t.name, lcom),
                     tx("LCOM4 finds method groups that share no field and do not call each other; each may be a separate class."),
                     {"metric": "lcom4", "value": lcom, "threshold": max_lcom})


def _oop005(r: Run) -> None:
    limit = r.number("maxCoupling")
    for t in r.types():
        if t.kind != "class":
            continue
        coupling = r.cbo(t)
        if coupling > limit:
            r.report("low", t.place, t.module.id, t.id, tx("{0} depends on {1} types", t.name, coupling),
                     tx("Beyond {0} collaborators, changes elsewhere are likely to reach this class.", limit), {"metric": "cbo", "value": coupling, "threshold": limit})


def _prn007(r: Run) -> None:
    limit = r.number("maxBooleanOperators")
    for f in r.functions():
        counted = set()
        for n in walk_body(f):
            if isinstance(n, ast.IfExp) and (isinstance(n.body, ast.IfExp) or isinstance(n.orelse, ast.IfExp)):
                r.report("medium", r.p.place(f.file, n), f.module.id, f.id, tx("Nested ternary expression"),
                         tx("A ternary inside a ternary hides the branching; an if or a switch expression shows it."))
            condition = n.test if isinstance(n, (ast.If, ast.While, ast.IfExp)) else None
            if condition is None or id(condition) in counted:
                continue
            counted.add(id(condition))
            operators = _boolean_operators(condition)
            if operators > limit:
                r.report("medium", r.p.place(f.file, condition), f.module.id, f.id, tx("Condition combines {0} boolean operators", operators),
                         tx("More than {0} operators in one condition; named intermediate values or a predicate method would state the intent.", limit))


def _boolean_operators(node: ast.AST) -> int:
    if isinstance(node, ast.Lambda):
        return 0
    count = len(node.values) - 1 if isinstance(node, ast.BoolOp) else 0
    return count + sum(_boolean_operators(c) for c in ast.iter_child_nodes(node))


SECRET_NAME = re.compile(r"password|passwd|pwd|secret|api_?key|apikey|access_?token|auth_?token|private_?key", re.IGNORECASE)
KNOWN_CREDENTIAL = re.compile(r"AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|sk-[A-Za-z0-9]{32,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[baprs]-[A-Za-z0-9-]{10,}")
SQL_TEXT = re.compile(r"\b(SELECT\s[\s\S]+\sFROM|INSERT\s+INTO|UPDATE\s[\s\S]+\sSET|DELETE\s+FROM|DROP\s+TABLE)\b", re.IGNORECASE)


def _owner_of(r: Run, m, node: ast.AST) -> str:
    best = None
    for f in module_functions(m):
        if f.node.lineno <= node.lineno <= f.node.end_lineno and (best is None or f.node.lineno >= best.node.lineno):
            best = f
    return best.id if best else ""


def _sec001(r: Run) -> None:
    for m in r.p.modules:
        tree = m.file.tree
        if tree is None:
            continue
        for n in ast.walk(tree):
            if isinstance(n, (ast.Assign, ast.AnnAssign)):
                targets = n.targets if isinstance(n, ast.Assign) else [n.target]
                for target in targets:
                    name = target.id if isinstance(target, ast.Name) else target.attr if isinstance(target, ast.Attribute) else ""
                    if name and n.value is not None:
                        check_secret(r, m, name, n.value, _owner_of(r, m, n))
            elif isinstance(n, ast.Dict):
                for key, value in zip(n.keys, n.values):
                    if isinstance(key, ast.Constant) and isinstance(key.value, str):
                        check_secret(r, m, key.value, value, _owner_of(r, m, n))
            elif isinstance(n, ast.keyword) and n.arg:
                check_secret(r, m, n.arg, n.value, _owner_of(r, m, n.value))


def check_secret(r: Run, m, name: str, value: ast.AST, entity: str) -> None:
    if not (isinstance(value, ast.Constant) and isinstance(value.value, str)) or len(value.value) < 6:
        return
    text = value.value
    place = r.p.place(m.file, value)
    if KNOWN_CREDENTIAL.search(text):
        r.report("high", place, m.id, entity, tx("{0} holds what looks like a real credential", name),
                 tx("Heuristic: the literal matches the format of a known key or token. Rotate it if it is real, and load it from a secret store."), None, "critical")
    elif SECRET_NAME.search(name) and not re.search(r"[ {]", text):
        r.report("medium", place, m.id, entity, tx("{0} looks like a hardcoded secret", name),
                 tx("Heuristic: the name suggests a secret and the value is a literal. It may be a placeholder or a non-secret value."))


def _sql_parts(node: ast.AST):
    """The constant text of a string built at run time and whether any part is not constant, or None."""
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        text, dynamic = "", False
        for part in _plus_parts(node):
            if isinstance(part, ast.Constant) and isinstance(part.value, str):
                text += part.value
            elif isinstance(part, ast.JoinedStr):
                inner = _sql_parts(part)
                text += inner[0]
                dynamic = True
            else:
                dynamic = True
        return text, dynamic
    if isinstance(node, ast.JoinedStr):
        text = " ".join(v.value for v in node.values if isinstance(v, ast.Constant) and isinstance(v.value, str))
        return text, any(isinstance(v, ast.FormattedValue) for v in node.values)
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Mod) and isinstance(node.left, ast.Constant) and isinstance(node.left.value, str):
        return node.left.value, not isinstance(node.right, ast.Constant)
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "format" and isinstance(node.func.value, ast.Constant) \
            and isinstance(node.func.value.value, str):
        return node.func.value.value, bool(node.args or node.keywords)
    return None


def _plus_parts(node: ast.AST):
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        yield from _plus_parts(node.left)
        yield from _plus_parts(node.right)
    else:
        yield node


def _sec003(r: Run) -> None:
    for m in r.p.modules:
        for f in module_functions(m):
            inner = set()
            for n in walk_body(f):
                if id(n) in inner:
                    continue
                parts = _sql_parts(n)
                if parts is None:
                    continue
                if isinstance(n, ast.BinOp) and isinstance(n.op, ast.Add):
                    for x in ast.walk(n):
                        if x is not n:
                            inner.add(id(x))
                text, dynamic = parts
                if dynamic and SQL_TEXT.search(text):
                    r.report("medium", r.p.place(f.file, n), m.id, f.id, tx("SQL built from non-constant values"),
                             tx("Heuristic: if any value comes from a user, this allows injection. Parameterized queries keep data out of the statement."))


def _str002(r: Run) -> None:
    for m in r.p.modules:
        if not r.applies(m):
            continue
        for g in m.globals:
            r.report("high", g.place, m.id, "", tx("Global variable {0}", g.name), tx("Any function can change it, so its value depends on the call history."))
        for t in m.types:
            for member in t.members:
                if not member.is_static or not member.mutable or member.visibility == "private":
                    continue
                r.report("high", r.p.place(m.file, member.node), m.id, t.id, tx("Global mutable field {0}.{1}", t.name, member.name),
                         tx("A non-private static mutable field is shared by all code and threads."))


def _str003(r: Run) -> None:
    max_module = r.number("maxModuleLines")
    max_file = r.number("maxFileLines")
    for m in r.p.modules:
        if not r.applies(m):
            continue
        if m.file.loc > max_module:
            r.report("high", file_place(m.file.path), m.id, "", tx("Module {0} has {1} lines of code", m.id, m.file.loc),
                     tx("The limit is {0}; a smaller module is easier to understand as a unit.", max_module), {"metric": "loc", "value": m.file.loc, "threshold": max_module})
        if m.file.lines > max_file:
            r.report("high", file_place(m.file.path), "", "", tx("{0} has {1} lines", m.file.path, m.file.lines), tx("The limit is {0}.", max_file),
                     {"metric": "lines", "value": m.file.lines, "threshold": max_file})


DETECTORS = {
    "ALG001": _alg001, "ALG002": _alg002, "ALG003": _alg003, "ALG004": _alg004, "CC001": _cc001, "CC002": _cc002, "CC003": _cc003, "CC004": _cc004,
    "CC009": _cc009, "DSN001": _dsn001, "DSN002": _dsn002, "DSN003": _dsn003, "DSN004": _dsn004, "DSN005": _dsn005, "DSN006": _dsn006, "FUN005": _fun005,
    "MNT001": _mnt001, "MNT002": _mnt002, "MNT003": _mnt003, "MNT004": _mnt004, "OOP001": _oop001, "OOP002": _oop002, "OOP003": _oop003, "OOP004": _oop004,
    "OOP005": _oop005, "PRN007": _prn007, "SEC001": _sec001, "SEC003": _sec003, "STR002": _str002, "STR003": _str003,
}


def sort_findings(findings: list) -> list:
    seen = set()
    unique = []
    for f in findings:
        key = (f.rule, f.place.file, f.place.startLine, f.place.startColumn, f.place.endLine, f.place.endColumn, f.message)
        if key in seen:
            continue
        seen.add(key)
        unique.append(f)
    return sorted(unique, key=lambda f: (f.place.file, f.place.startLine, f.place.startColumn, f.rule, f.message))
