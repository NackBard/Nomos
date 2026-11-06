"""The manifest, facts and SARIF of one run."""
from __future__ import annotations

import json
import math
import os

from .config import Config, spec_rules
from .coverage import Coverage
from .estimate import self_calls, time_estimates
from .graph import build_graphs, collect_edges, components
from .metrics import (
    allocation_depth, atfd, cyclomatic, dit, halstead_volume, hof_order, is_instance_method, lambda_nesting, lcom4, line_span, maintainability_index,
    max_nesting, member_use, most_used_foreign, parameter_count, round_to, space_degree, tcc, tested_types, wmc,
)
from .paradigms import active_paradigms, collect_evidence, pure_functions
from .rules import DETECTORS, SUPPORTED, Run, fingerprint, member_count, sort_findings
from .structure import members, parameters, return_type_name, satisfies

NAME = "nomos-python"
VERSION = "0.1.0"
FACTS_VERSION = "1.3.0"
MANIFEST_VERSION = "1.2.0"
LANGUAGE = "python"


def manifest() -> dict:
    by_id = {r["id"]: r for r in spec_rules()}
    return {
        "name": NAME,
        "language": LANGUAGE,
        "version": VERSION,
        "schemaVersion": MANIFEST_VERSION,
        "paradigms": ["functional", "oop", "structural"],
        "files": ["**/*.py"],
        "capabilities": {"semantic": False, "supportedRules": SUPPORTED, "partialAnalysis": False, "sarif": True},
        "rules": [{"id": i, "category": by_id[i]["category"], "paradigms": sorted(by_id[i]["paradigms"]), "title": by_id[i]["title"]} for i in SUPPORTED],
    }


def _not_applicable(paradigm: str) -> str:
    return {
        "oop": "OOP rule not applicable: module has no classes",
        "functional": "Functional rule not applicable: module shows no functional style",
        "structural": "Structural rule not applicable: module has no free functions or branching",
    }.get(paradigm, f"Rule for paradigm '{paradigm}' not applicable: no evidence of it in the module")


def _level(severity: str) -> str:
    return "error" if severity == "critical" else "note" if severity == "info" else "warning"


def _score(config: Config, loc: int, findings: list, categories: list) -> dict:
    weight = lambda c: config.category_weights.get(c, 1)  # noqa: E731
    total_weight = sum(weight(c) for c in categories)
    kloc = max(loc / 1000, config.min_kloc)
    total = 0.0
    result = []
    for category in categories:
        penalty = 0.0
        own = 0
        for f in findings:
            if f.category != category:
                continue
            own += 1
            penalty += config.severity_penalties.get(f.severity, 0) * config.confidence_factors.get(f.confidence, 0)
        value = 100 * math.exp(-penalty / kloc / config.decay_per_kloc)
        share = weight(category) / total_weight if total_weight > 0 else 0
        total += value * share
        result.append({"category": category, "score": round_to(value, 1), "weight": round_to(share, 3), "penalty": round_to(penalty, 2), "findingCount": own})
    return {"score": total, "categories": result, "explanation": [f"Weighted mean over {len(categories)} categories, normalized by {kloc:.3f} KLOC."]}


def _number(value):
    """Integers stay integers in JSON; whole floats are written as integers, like JavaScript writes them."""
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value


def _clean(value):
    if isinstance(value, dict):
        return {k: _clean(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_clean(v) for v in value]
    if isinstance(value, float):
        return _number(value)
    return value


def analyze(p, root: str, sarif_file, selected, config: Config) -> tuple:
    edges = collect_edges(p)
    graphs = build_graphs(p, edges)
    estimates = time_estimates(p)
    run = Run(p, config, edges, graphs, estimates)
    pure = pure_functions(p)
    enabled = config.enabled_paradigms()
    report = ((config.rules.get("MNT004") or {}).get("threshold") or {}).get("report")
    if isinstance(report, str) and report:
        try:
            run.coverage = Coverage.load(os.path.join(root, report))
        except OSError:
            run.coverage = None
    evidence, shown = {}, {}
    for m in p.modules:
        evidence[m.id] = collect_evidence(p, m, pure)
        shown[m.id] = active_paradigms(evidence[m.id])
        run.active[m.id] = {x for x in shown[m.id] if x in enabled}

    rules = spec_rules()
    supported = set(SUPPORTED)
    outside = config.outside_practices()
    skips = []
    categories = set()
    inputs = {"layer-config": bool(config.layers), "coverage-report": run.coverage is not None}
    for rule in rules:
        rid = rule["id"]
        if rid not in supported:
            if "." not in rid:
                skips.append({"ruleId": rid, "reason": "not-supported", "message": "Python has no goto" if rid == "STR001" else "Rule is not implemented for Python"})
            continue
        explicit = (config.rules.get(rid) or {}).get("enabled")
        by_config = explicit is False or (selected is not None and rid not in selected)
        practice_message = outside.get(rid) if outside is not None and explicit is None else None
        any_enabled = not rule["paradigms"] or any(x in enabled for x in rule["paradigms"])
        if not any_enabled:
            skips.append({"ruleId": rid, "reason": "disabled-by-config",
                          "message": f"Rule needs paradigm {' or '.join(sorted(rule['paradigms']))}, which is off for this language; 'paradigms' in nomos.json selects them"})
        elif by_config:
            skips.append({"ruleId": rid, "reason": "disabled-by-config", "message": "Rule is off by nomos.json or by --rules"})
        elif practice_message:
            skips.append({"ruleId": rid, "reason": "disabled-by-config", "message": practice_message})
        if by_config or practice_message or not any_enabled:
            continue
        run.rule = rule
        run.ran[rid] = rule
        categories.add(rule["category"])
        DETECTORS[rid](run)
        for needed in rule.get("requires") or []:
            if not inputs.get(needed):
                skips.append({"ruleId": rid, "reason": "missing-input", "message": f"Rule not applied: no {needed} in the configuration"})
    for rule in rules:
        if rule["id"] not in supported or not rule["paradigms"]:
            continue
        ran = rule["id"] in run.ran
        for m in p.modules:
            own = shown[m.id]
            applies = any(x in own for x in rule["paradigms"])
            active = any(x in own and x in enabled for x in rule["paradigms"])
            if not applies:
                skips.append({"ruleId": rule["id"], "module": m.id, "reason": "paradigm-not-detected", "message": _not_applicable(rule["paradigms"][0])})
            elif ran and not active:
                skips.append({"ruleId": rule["id"], "module": m.id, "reason": "disabled-by-config",
                              "message": "Rule not applied: every paradigm the module shows for it is off for this language"})
    skips.sort(key=lambda s: (s["ruleId"], s.get("module", ""), s["reason"]))

    by_file = {f.path: f for f in p.files}
    ordered = sort_findings(run.findings)
    findings = [f for f in ordered if not (by_file.get(f.place.file) and by_file[f.place.file].directives.covers(f.rule, f.place.startLine))]
    suppressed = len(ordered) - len(findings)
    for f in findings:
        if not f.module and f.place.file in by_file:
            f.module = by_file[f.place.file].module.id
    category_list = sorted(categories)

    diagnostics = list(p.notes)
    partial = False
    files = []
    for f in p.files:
        entry = {"path": f.path, "lines": f.lines, "loc": f.loc}
        if run.coverage is not None:
            percent = run.coverage.percent(f.path)
            if percent is not None:
                entry["coverage"] = percent
        entry["module"] = f.module.id
        entry["parsed"] = not f.broken
        if f.broken:
            partial = True
            diagnostics.append({"level": "warning", "message": "Syntax errors: declarations in this file are missing from the facts.", "file": f.path, "code": "syntax-error"})
        files.append(entry)
    if suppressed > 0:
        diagnostics.append({"level": "info", "message": f"{suppressed} finding(s) suppressed by directives.", "code": "suppressed"})
    if not p.files:
        diagnostics.append({"level": "info", "message": "No Python files under the root outside dependency, build and virtual environment folders.", "code": "no-files"})

    total = 0.0
    total_loc = 0
    modules = []
    for m in p.modules:
        loc = m.file.loc
        own = [f for f in findings if f.module == m.id]
        health = _score(config, loc, own, category_list)
        total += health["score"] * loc
        total_loc += loc
        modules.append({
            "id": m.id, "name": m.name, "files": [m.file.path], "loc": loc, "metrics": run.martin(m),
            "paradigmEvidence": evidence[m.id], "activeParadigms": shown[m.id], "health": {**health, "score": round_to(health["score"], 1)},
        })
    project_score = total / total_loc if total_loc > 0 else 100
    project_categories = [_score(config, max(total_loc, 1), [f for f in findings if f.category == c], [c])["categories"][0] for c in category_list]

    all_types = p.all_types()
    types = []
    for t in all_types:
        metrics = {"lines": line_span(t.place), "memberCount": member_count(t),
                   "methodCount": len([m for m in t.methods if m.kind in ("method", "constructor")]), "blastRadius": graphs.radius.get(t.id, 0)}
        if t.kind == "class":
            metrics.update({"dit": dit(p, t), "cbo": run.cbo(t), "lcom4": lcom4(p, t), "wmc": wmc(t), "atfd": atfd(p, t), "tcc": tcc(p, t)})
        entry = {"id": t.id, "name": t.name, "module": t.module.id, "kind": t.kind, "isAbstract": t.is_abstract, "location": t.place.as_dict()}
        if t.type_parameters:
            entry["typeParameters"] = t.type_parameters
        own_members = members(p, t)
        if own_members:
            entry["members"] = own_members
        implicit = satisfies(p, t, all_types)
        if implicit:
            entry["satisfies"] = implicit
        entry["metrics"] = metrics
        types.append(entry)

    functions = []
    for f in p.all_functions():
        unit = f.owner.id if f.owner else f.id
        metrics = {
            "cyclomatic": cyclomatic(f), "maxNesting": max_nesting(f), "parameterCount": parameter_count(f), "lines": line_span(f.place),
            "hofOrder": hof_order(p, f), "lambdaNesting": lambda_nesting(f), "typeTests": len(tested_types(p, f)), "blastRadius": graphs.radius.get(unit, 0),
            "timeDegree": None, "timeLogFactor": None, "timeExponential": None, "spaceDegree": None, "allocationDepth": None, "foreignMembers": None,
            "ownMembers": None, "halsteadVolume": None, "maintainabilityIndex": None,
        }
        volume = halstead_volume(f)
        if volume is not None:
            metrics["halsteadVolume"] = round_to(volume, 4)
            metrics["maintainabilityIndex"] = round_to(maintainability_index(f), 4)
        growth = estimates.get(f.id)
        if growth is not None:
            metrics["timeExponential"] = 1 if growth.exponential else 0
            if not growth.exponential:
                metrics["timeDegree"] = growth.degree
                metrics["timeLogFactor"] = growth.log
            metrics["spaceDegree"] = space_degree(p, f, len(self_calls(p, f)))
            metrics["allocationDepth"] = allocation_depth(p, f)
        if is_instance_method(f):
            metrics["foreignMembers"] = len(most_used_foreign(p, f)[1])
            metrics["ownMembers"] = len(member_use(p, f)[0])
        entry = {"id": f.id, "name": f.name, "module": f.module.id}
        if f.owner:
            entry["type"] = f.owner.id
        entry["kind"] = f.kind
        entry["visibility"] = f.visibility
        entry["location"] = f.place.as_dict()
        entry["parameters"] = parameters(f)
        result = return_type_name(f)
        if result:
            entry["returnTypeName"] = result
        if f.is_static:
            entry["isStatic"] = True
        if f.is_abstract:
            entry["isAbstract"] = True
        entry["metrics"] = metrics
        functions.append(entry)

    merged = {}
    for e in edges:
        phase = "type-only" if e.type_only else "runtime"
        key = (e.source, e.to, e.kind, phase)
        if key in merged:
            merged[key]["count"] += 1
        else:
            merged[key] = {"from": e.source, "to": e.to, "kind": e.kind, "phase": phase, "external": e.external, "stdlib": e.stdlib, "count": 1,
                           "location": e.place.as_dict()}
    dependencies = [merged[k] for k in sorted(merged, key=lambda k: "\0".join(k))]
    cycles = [{"level": "type", "members": c} for c in components(graphs.runtime_units)] + [{"level": "module", "members": c} for c in components(graphs.runtime_modules)]

    document = {
        "schemaVersion": FACTS_VERSION,
        "analyzer": {"name": NAME, "version": VERSION, "language": LANGUAGE, "semantic": False},
        "files": files, "modules": modules, "types": types, "functions": functions, "dependencies": dependencies, "cycles": cycles,
        "health": {"score": round_to(project_score, 1), "categories": project_categories,
                   "explanation": [f"Mean of {len(modules)} module score(s), weighted by lines of code ({total_loc} total)."]},
        "skippedRules": skips,
        "diagnostics": diagnostics,
    }
    if sarif_file:
        with open(sarif_file, "w", encoding="utf-8", newline="\n") as out:
            out.write(_sarif(findings))
        document["checks"] = {"sarifFile": sarif_file, "resultCount": len(findings)}
    return json.dumps(_clean(document), indent=2, ensure_ascii=False) + "\n", partial


def _key_of(rule, template: str):
    keys = sorted(k for k, m in ((rule or {}).get("messages") or {}).items() if m["text"] == template)
    return keys[0] if keys else None


def _sarif(findings: list) -> str:
    by_id = {r["id"]: r for r in spec_rules()}
    ids = sorted(SUPPORTED)
    index = {rid: i for i, rid in enumerate(ids)}
    rules = []
    for rid in ids:
        rule = by_id[rid]
        entry = {"id": rid, "name": rule["title"], "shortDescription": {"text": rule["description"]}, "fullDescription": {"text": rule["rationale"]},
                 "defaultConfiguration": {"level": _level(rule["severity"])}, "properties": {"category": rule["category"], "paradigms": sorted(rule["paradigms"])}}
        if rule.get("messages"):
            entry["messageStrings"] = {k: {"text": rule["messages"][k]["text"]} for k in sorted(rule["messages"])}
        rules.append(entry)
    results = []
    for f in findings:
        rule = by_id.get(f.rule)
        properties = {"severity": f.severity, "confidence": f.confidence, "explanation": f.explanation}
        if f.module:
            properties["module"] = f.module
        if f.entity:
            properties["entity"] = f.entity
        if f.measured:
            properties["measured"] = f.measured
        explanation_key = _key_of(rule, f.explanation_text.template)
        if explanation_key:
            properties["explanationMessage"] = {"id": explanation_key, "arguments": list(f.explanation_text.args)}
        message = {"text": f.message}
        message_key = _key_of(rule, f.message_text.template)
        if message_key:
            message["id"] = message_key
            message["arguments"] = list(f.message_text.args)
        place = f.place
        results.append({
            "ruleId": f.rule, "ruleIndex": index[f.rule], "level": _level(f.severity), "message": message,
            "locations": [{"physicalLocation": {"artifactLocation": {"uri": place.file},
                                                "region": {"startLine": place.startLine, "startColumn": place.startColumn, "endLine": place.endLine, "endColumn": place.endColumn}}}],
            "partialFingerprints": {"nomos/v1": fingerprint(f)},
            "properties": properties,
        })
    document = {"$schema": "https://json.schemastore.org/sarif-2.1.0.json", "version": "2.1.0",
                "runs": [{"tool": {"driver": {"name": NAME, "version": VERSION, "semanticVersion": VERSION, "rules": rules}}, "results": results}]}
    return json.dumps(_clean(document), indent=2, ensure_ascii=False) + "\n"
