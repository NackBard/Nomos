package nomos.java;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import nomos.java.Estimate.Growth;
import nomos.java.Graph.Edge;
import nomos.java.Graph.Graphs;
import nomos.java.Model.Fn;
import nomos.java.Model.Module;
import nomos.java.Model.SourceFile;
import nomos.java.Model.TypeUnit;
import nomos.java.Rules.Finding;
import nomos.java.Rules.Run;

/** The manifest, facts and SARIF of one run. */
final class Facts {
    static final String NAME = "nomos-java";
    static final String VERSION = "0.1.0";
    static final String FACTS_VERSION = "1.3.0";
    static final String MANIFEST_VERSION = "1.2.0";

    private Facts() {
    }

    static Map<String, Map<String, Object>> rulesById() {
        Map<String, Map<String, Object>> byId = new HashMap<>();
        for (Map<String, Object> r : Config.specRules()) byId.put((String) r.get("id"), r);
        return byId;
    }

    static List<String> sortedParadigms(Map<String, Object> rule) {
        List<String> list = new ArrayList<>(Config.strings(rule.get("paradigms")));
        list.sort(null);
        return list;
    }

    static Map<String, Object> manifest() {
        Map<String, Map<String, Object>> byId = rulesById();
        List<Object> rules = new ArrayList<>();
        for (String id : Rules.SUPPORTED) {
            Map<String, Object> r = byId.get(id);
            rules.add(Json.obj("id", id, "category", r.get("category"), "paradigms", sortedParadigms(r), "title", r.get("title")));
        }
        return Json.obj(
            "name", NAME, "language", Config.LANGUAGE, "version", VERSION, "schemaVersion", MANIFEST_VERSION,
            "paradigms", List.of("functional", "oop", "structural"),
            "files", List.of("**/*.java"),
            "capabilities", Json.obj("semantic", true, "supportedRules", Rules.SUPPORTED, "partialAnalysis", false, "sarif", true),
            "rules", rules);
    }

    private static String notApplicable(String paradigm) {
        return switch (paradigm) {
            case "oop" -> "OOP rule not applicable: module has no classes";
            case "functional" -> "Functional rule not applicable: module shows no functional style";
            case "structural" -> "Structural rule not applicable: module has no free functions or branching";
            default -> "Rule for paradigm '" + paradigm + "' not applicable: no evidence of it in the module";
        };
    }

    private static String level(String severity) {
        return severity.equals("critical") ? "error" : severity.equals("info") ? "note" : "warning";
    }

    private static Map<String, Object> score(Config config, int loc, List<Finding> findings, List<String> categories) {
        double totalWeight = 0;
        for (String c : categories) totalWeight += weight(config, c);
        double kloc = Math.max(loc / 1000.0, config.minKloc);
        double total = 0;
        List<Object> result = new ArrayList<>();
        for (String category : categories) {
            double penalty = 0;
            int own = 0;
            for (Finding f : findings) {
                if (!f.category.equals(category)) continue;
                own++;
                penalty += config.severityPenalties.getOrDefault(f.severity, 0.0) * config.confidenceFactors.getOrDefault(f.confidence, 0.0);
            }
            double value = 100 * Math.exp(-penalty / kloc / config.decayPerKloc);
            double share = totalWeight > 0 ? weight(config, category) / totalWeight : 0;
            total += value * share;
            result.add(Json.obj("category", category, "score", Text.round(value, 1), "weight", Text.round(share, 3), "penalty", Text.round(penalty, 2), "findingCount", own));
        }
        return Json.obj("score", total, "categories", result,
            "explanation", List.of("Weighted mean over " + categories.size() + " categories, normalized by " + String.format(java.util.Locale.ROOT, "%.3f", kloc) + " KLOC."));
    }

    private static double weight(Config config, String category) {
        Object w = config.categoryWeights.get(category);
        return w instanceof Number n ? n.doubleValue() : 1;
    }

    static final class Result {
        String facts;
        boolean partial;
    }

    static Result analyze(Project p, String sarifFile, Set<String> selected, Config config) throws IOException {
        List<Edge> edges = Graph.collect(p);
        Graphs graphs = Graph.build(p, edges);
        Map<String, Growth> estimates = Estimate.all(p);
        Run run = new Run(p, config, edges, graphs, estimates);
        Set<Fn> pure = Paradigms.pure(p);
        Set<String> enabled = config.enabledParadigms();
        Object report = Json.object(config.rule("MNT004").get("threshold")).get("report");
        if (report instanceof String s && !s.isEmpty()) {
            try {
                run.coverage = Coverage.load(p.root.resolve(s));
            } catch (IOException e) {
                run.coverage = null;
            }
        }
        Map<String, List<Map<String, Object>>> evidence = new HashMap<>();
        Map<String, List<String>> shown = new HashMap<>();
        for (Module m : p.modules) {
            evidence.put(m.id, Paradigms.evidence(p, m, pure));
            shown.put(m.id, Paradigms.active(evidence.get(m.id)));
            Set<String> active = new TreeSet<>();
            for (String x : shown.get(m.id)) if (enabled.contains(x)) active.add(x);
            run.active.put(m.id, active);
        }

        List<Map<String, Object>> rules = Config.specRules();
        Set<String> supported = new TreeSet<>(Rules.SUPPORTED);
        Map<String, String> outside = config.outsidePractices();
        List<Map<String, Object>> skips = new ArrayList<>();
        Set<String> categories = new TreeSet<>();
        Map<String, Boolean> inputs = Map.of("layer-config", !config.layers.isEmpty(), "coverage-report", run.coverage != null);
        for (Map<String, Object> rule : rules) {
            String id = (String) rule.get("id");
            if (!supported.contains(id)) {
                if (!id.contains(".")) skips.add(skip(id, null, "not-supported", id.equals("STR001") ? "Java has no goto" : "Rule is not implemented for Java"));
                continue;
            }
            Object explicit = config.rule(id).get("enabled");
            boolean byConfig = Boolean.FALSE.equals(explicit) || (selected != null && !selected.contains(id));
            String practiceMessage = outside != null && explicit == null ? outside.get(id) : null;
            List<String> paradigms = Config.strings(rule.get("paradigms"));
            boolean anyEnabled = paradigms.isEmpty() || paradigms.stream().anyMatch(enabled::contains);
            if (!anyEnabled) {
                List<String> sorted = new ArrayList<>(paradigms);
                sorted.sort(null);
                skips.add(skip(id, null, "disabled-by-config", "Rule needs paradigm " + String.join(" or ", sorted) + ", which is off for this language; 'paradigms' in nomos.json selects them"));
            } else if (byConfig) {
                skips.add(skip(id, null, "disabled-by-config", "Rule is off by nomos.json or by --rules"));
            } else if (practiceMessage != null) {
                skips.add(skip(id, null, "disabled-by-config", practiceMessage));
            }
            if (byConfig || practiceMessage != null || !anyEnabled) continue;
            run.rule = rule;
            run.ran.put(id, rule);
            categories.add((String) rule.get("category"));
            Rules.DETECTORS.get(id).accept(run);
            for (String needed : Config.strings(rule.get("requires"))) {
                if (!inputs.getOrDefault(needed, false)) skips.add(skip(id, null, "missing-input", "Rule not applied: no " + needed + " in the configuration"));
            }
        }
        for (Map<String, Object> rule : rules) {
            String id = (String) rule.get("id");
            List<String> paradigms = Config.strings(rule.get("paradigms"));
            if (!supported.contains(id) || paradigms.isEmpty()) continue;
            boolean ran = run.ran.containsKey(id);
            for (Module m : p.modules) {
                List<String> own = shown.get(m.id);
                boolean applies = paradigms.stream().anyMatch(own::contains);
                boolean active = paradigms.stream().anyMatch(x -> own.contains(x) && enabled.contains(x));
                if (!applies) skips.add(skip(id, m.id, "paradigm-not-detected", notApplicable(paradigms.get(0))));
                else if (ran && !active) skips.add(skip(id, m.id, "disabled-by-config", "Rule not applied: every paradigm the module shows for it is off for this language"));
            }
        }
        skips.sort((a, b) -> {
            int c = ((String) a.get("ruleId")).compareTo((String) b.get("ruleId"));
            if (c != 0) return c;
            c = ((String) a.getOrDefault("module", "")).compareTo((String) b.getOrDefault("module", ""));
            return c != 0 ? c : ((String) a.get("reason")).compareTo((String) b.get("reason"));
        });

        Map<String, SourceFile> byFile = new HashMap<>();
        for (SourceFile f : p.files) byFile.put(f.path, f);
        List<Finding> ordered = Rules.sort(run.findings);
        List<Finding> findings = new ArrayList<>();
        for (Finding f : ordered) {
            SourceFile file = byFile.get(f.place.file());
            if (file != null && file.directives.covers(f.rule, f.place.startLine())) continue;
            findings.add(f);
        }
        int suppressed = ordered.size() - findings.size();
        for (Finding f : findings) {
            if (f.module.isEmpty() && byFile.containsKey(f.place.file())) f.module = byFile.get(f.place.file()).module.id;
        }
        List<String> categoryList = new ArrayList<>(categories);

        List<Object> diagnostics = new ArrayList<>(p.notes);
        boolean partial = false;
        List<Object> files = new ArrayList<>();
        for (SourceFile f : p.files) {
            Map<String, Object> entry = Json.obj("path", f.path, "lines", f.lines, "loc", f.loc);
            if (run.coverage != null) {
                Double percent = run.coverage.percent(f.path);
                if (percent != null) entry.put("coverage", percent);
            }
            entry.put("module", f.module.id);
            entry.put("parsed", !f.broken);
            if (f.broken) {
                partial = true;
                diagnostics.add(Json.obj("level", "warning", "message", "Syntax errors: the declarations of this file may be incomplete in the facts.", "file", f.path,
                    "code", "syntax-error"));
            }
            files.add(entry);
        }
        if (p.unresolved > 0) {
            diagnostics.add(Json.obj("level", "info", "message", p.unresolved
                + " reference(s) could not be resolved without the build class path; dependencies on them are named as written.", "code", "unresolved"));
        }
        if (suppressed > 0) diagnostics.add(Json.obj("level", "info", "message", suppressed + " finding(s) suppressed by directives.", "code", "suppressed"));
        if (p.files.isEmpty()) {
            diagnostics.add(Json.obj("level", "info", "message", "No Java files under the root outside build, dependency and hidden folders.", "code", "no-files"));
        }

        double total = 0;
        int totalLoc = 0;
        List<Object> modules = new ArrayList<>();
        for (Module m : p.modules) {
            int loc = m.loc();
            List<Finding> own = new ArrayList<>();
            for (Finding f : findings) if (f.module.equals(m.id)) own.add(f);
            Map<String, Object> health = score(config, loc, own, categoryList);
            double value = (Double) health.get("score");
            total += value * loc;
            totalLoc += loc;
            health.put("score", Text.round(value, 1));
            List<String> paths = new ArrayList<>();
            for (SourceFile f : m.files) paths.add(f.path);
            modules.add(Json.obj("id", m.id, "name", m.id, "files", paths, "loc", loc, "metrics", run.martin(m), "paradigmEvidence", evidence.get(m.id),
                "activeParadigms", shown.get(m.id), "health", health));
        }
        double projectScore = totalLoc > 0 ? total / totalLoc : 100;
        List<Object> projectCategories = new ArrayList<>();
        for (String c : categoryList) {
            List<Finding> own = new ArrayList<>();
            for (Finding f : findings) if (f.category.equals(c)) own.add(f);
            projectCategories.add(((List<?>) score(config, Math.max(totalLoc, 1), own, List.of(c)).get("categories")).get(0));
        }

        List<Object> types = new ArrayList<>();
        for (TypeUnit t : p.allTypes()) {
            Map<String, Object> metrics = Json.obj("lines", t.place.lines(), "memberCount", Rules.memberCount(t), "methodCount", t.methods.size(),
                "blastRadius", graphs.radius.getOrDefault(t.id, 0));
            if (t.isClassLike()) {
                metrics.put("dit", Metrics.dit(t));
                metrics.put("cbo", run.cbo(t));
                metrics.put("lcom4", Metrics.lcom4(p, t));
                metrics.put("wmc", Metrics.wmc(t));
                metrics.put("atfd", Metrics.atfd(p, t));
                metrics.put("tcc", Metrics.tcc(p, t));
            }
            Map<String, Object> entry = Json.obj("id", t.id, "name", t.name, "module", t.module.id, "kind", t.kind, "isAbstract", t.isAbstract, "location", t.place.json());
            if (!t.typeParameters.isEmpty()) entry.put("typeParameters", t.typeParameters);
            List<Map<String, Object>> members = Structure.members(p, t);
            if (!members.isEmpty()) entry.put("members", members);
            entry.put("metrics", metrics);
            types.add(entry);
        }

        List<Object> functions = new ArrayList<>();
        for (Fn f : p.allFunctions()) {
            Map<String, Object> metrics = new LinkedHashMap<>();
            metrics.put("cyclomatic", Metrics.cyclomatic(f));
            metrics.put("maxNesting", Metrics.maxNesting(f));
            metrics.put("parameterCount", Metrics.parameterCount(f));
            metrics.put("lines", f.place.lines());
            metrics.put("hofOrder", Metrics.hofOrder(p, f));
            metrics.put("lambdaNesting", Metrics.lambdaNesting(f));
            metrics.put("typeTests", Metrics.testedTypes(p, f).size());
            metrics.put("blastRadius", graphs.radius.getOrDefault(f.owner.id, 0));
            for (String key : List.of("timeDegree", "timeLogFactor", "timeExponential", "spaceDegree", "allocationDepth", "foreignMembers", "ownMembers", "halsteadVolume",
                "maintainabilityIndex")) {
                metrics.put(key, null);
            }
            if (f.hasBody()) {
                Double volume = Metrics.halsteadVolume(f);
                if (volume != null) {
                    metrics.put("halsteadVolume", Text.round(volume, 4));
                    metrics.put("maintainabilityIndex", Text.round(Metrics.maintainabilityIndex(f), 4));
                }
                Growth growth = estimates.get(f.id);
                if (growth != null) {
                    metrics.put("timeExponential", growth.exponential() ? 1 : 0);
                    if (!growth.exponential()) {
                        metrics.put("timeDegree", growth.degree());
                        metrics.put("timeLogFactor", growth.log());
                    }
                    metrics.put("spaceDegree", Metrics.spaceDegree(p, f, Estimate.selfCalls(p, f).size()));
                    metrics.put("allocationDepth", Metrics.allocationDepth(f));
                }
            }
            if (f.isInstanceMethod()) {
                metrics.put("foreignMembers", Metrics.mostUsedForeign(p, f).getValue().size());
                metrics.put("ownMembers", Metrics.memberUse(p, f).own().size());
            }
            Map<String, Object> entry = Json.obj("id", f.id, "name", f.name, "module", f.module.id, "type", f.owner.id, "kind", f.kind, "visibility", f.visibility,
                "location", f.place.json(), "parameters", Structure.parameters(p, f));
            String result = Structure.returnTypeName(p, f);
            if (result != null) entry.put("returnTypeName", result);
            if (f.isStatic) entry.put("isStatic", true);
            if (f.isAbstract) entry.put("isAbstract", true);
            entry.put("metrics", metrics);
            functions.add(entry);
        }

        Map<String, Map<String, Object>> merged = new TreeMap<>();
        for (Edge e : edges) {
            String key = e.from() + "\0" + e.to() + "\0" + e.kind() + "\0" + "runtime";
            Map<String, Object> known = merged.get(key);
            if (known != null) {
                known.put("count", (Integer) known.get("count") + 1);
            } else {
                merged.put(key, Json.obj("from", e.from(), "to", e.to(), "kind", e.kind(), "phase", "runtime", "external", e.external(), "stdlib", e.stdlib(), "count", 1,
                    "location", e.place().json()));
            }
        }
        List<Object> cycles = new ArrayList<>();
        for (List<String> c : Graph.components(graphs.units)) cycles.add(Json.obj("level", "type", "members", c));
        for (List<String> c : Graph.components(graphs.modules)) cycles.add(Json.obj("level", "module", "members", c));

        Map<String, Object> document = Json.obj(
            "schemaVersion", FACTS_VERSION,
            "analyzer", Json.obj("name", NAME, "version", VERSION, "language", Config.LANGUAGE, "semantic", true),
            "files", files, "modules", modules, "types", types, "functions", functions, "dependencies", new ArrayList<>(merged.values()), "cycles", cycles,
            "health", Json.obj("score", Text.round(projectScore, 1), "categories", projectCategories,
                "explanation", List.of("Mean of " + modules.size() + " module score(s), weighted by lines of code (" + totalLoc + " total).")),
            "skippedRules", skips,
            "diagnostics", diagnostics);
        if (sarifFile != null) {
            Files.writeString(Path.of(sarifFile), sarif(findings), StandardCharsets.UTF_8);
            document.put("checks", Json.obj("sarifFile", sarifFile, "resultCount", findings.size()));
        }
        Result result = new Result();
        result.facts = Json.write(document);
        result.partial = partial;
        return result;
    }

    private static Map<String, Object> skip(String rule, String module, String reason, String message) {
        Map<String, Object> s = new LinkedHashMap<>();
        s.put("ruleId", rule);
        if (module != null) s.put("module", module);
        s.put("reason", reason);
        s.put("message", message);
        return s;
    }

    private static String keyOf(Map<String, Object> rule, String template) {
        if (rule == null) return null;
        Map<String, Object> messages = Json.object(rule.get("messages"));
        TreeSet<String> keys = new TreeSet<>();
        messages.forEach((k, m) -> {
            if (template.equals(Json.object(m).get("text"))) keys.add(k);
        });
        return keys.isEmpty() ? null : keys.first();
    }

    private static String sarif(List<Finding> findings) {
        Map<String, Map<String, Object>> byId = rulesById();
        List<String> ids = new ArrayList<>(Rules.SUPPORTED);
        ids.sort(null);
        Map<String, Integer> index = new HashMap<>();
        for (int i = 0; i < ids.size(); i++) index.put(ids.get(i), i);
        List<Object> rules = new ArrayList<>();
        for (String id : ids) {
            Map<String, Object> rule = byId.get(id);
            Map<String, Object> entry = Json.obj("id", id, "name", rule.get("title"), "shortDescription", Json.obj("text", rule.get("description")),
                "fullDescription", Json.obj("text", rule.get("rationale")), "defaultConfiguration", Json.obj("level", level((String) rule.get("severity"))),
                "properties", Json.obj("category", rule.get("category"), "paradigms", sortedParadigms(rule)));
            Map<String, Object> messages = Json.object(rule.get("messages"));
            if (!messages.isEmpty()) {
                Map<String, Object> strings = new TreeMap<>();
                messages.forEach((k, m) -> strings.put(k, Json.obj("text", Json.object(m).get("text"))));
                entry.put("messageStrings", new LinkedHashMap<>(strings));
            }
            rules.add(entry);
        }
        List<Object> results = new ArrayList<>();
        for (Finding f : findings) {
            Map<String, Object> rule = byId.get(f.rule);
            Map<String, Object> properties = Json.obj("severity", f.severity, "confidence", f.confidence, "explanation", f.explanation);
            if (!f.module.isEmpty()) properties.put("module", f.module);
            if (!f.entity.isEmpty()) properties.put("entity", f.entity);
            if (f.measured != null) properties.put("measured", f.measured);
            String explanationKey = keyOf(rule, f.explanationText.template());
            if (explanationKey != null) properties.put("explanationMessage", Json.obj("id", explanationKey, "arguments", f.explanationText.args()));
            Map<String, Object> message = Json.obj("text", f.message);
            String messageKey = keyOf(rule, f.messageText.template());
            if (messageKey != null) {
                message.put("id", messageKey);
                message.put("arguments", f.messageText.args());
            }
            results.add(Json.obj("ruleId", f.rule, "ruleIndex", index.get(f.rule), "level", level(f.severity), "message", message,
                "locations", List.of(Json.obj("physicalLocation", Json.obj("artifactLocation", Json.obj("uri", f.place.file()),
                    "region", Json.obj("startLine", f.place.startLine(), "startColumn", f.place.startColumn(), "endLine", f.place.endLine(), "endColumn", f.place.endColumn())))),
                "partialFingerprints", Json.obj("nomos/v1", Rules.fingerprint(f)),
                "properties", properties));
        }
        Map<String, Object> document = Json.obj("$schema", "https://json.schemastore.org/sarif-2.1.0.json", "version", "2.1.0",
            "runs", List.of(Json.obj("tool", Json.obj("driver", Json.obj("name", NAME, "version", VERSION, "semanticVersion", VERSION, "rules", rules)), "results", results)));
        return Json.write(document);
    }
}
