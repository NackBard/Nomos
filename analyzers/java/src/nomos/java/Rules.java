package nomos.java;

import static nomos.java.Text.fixed;
import static nomos.java.Text.tx;

import com.sun.source.tree.AssignmentTree;
import com.sun.source.tree.BinaryTree;
import com.sun.source.tree.CatchTree;
import com.sun.source.tree.CompoundAssignmentTree;
import com.sun.source.tree.ConditionalExpressionTree;
import com.sun.source.tree.DoWhileLoopTree;
import com.sun.source.tree.ExpressionTree;
import com.sun.source.tree.ForLoopTree;
import com.sun.source.tree.IdentifierTree;
import com.sun.source.tree.IfTree;
import com.sun.source.tree.LambdaExpressionTree;
import com.sun.source.tree.LiteralTree;
import com.sun.source.tree.MemberSelectTree;
import com.sun.source.tree.MethodInvocationTree;
import com.sun.source.tree.NewClassTree;
import com.sun.source.tree.ParameterizedTypeTree;
import com.sun.source.tree.Tree;
import com.sun.source.tree.VariableTree;
import com.sun.source.tree.WhileLoopTree;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Consumer;
import java.util.regex.Pattern;
import javax.lang.model.element.Element;
import javax.lang.model.element.VariableElement;
import javax.lang.model.type.TypeMirror;
import nomos.java.Estimate.Growth;
import nomos.java.Graph.Edge;
import nomos.java.Graph.Graphs;
import nomos.java.Model.Fn;
import nomos.java.Model.Member;
import nomos.java.Model.Module;
import nomos.java.Model.Place;
import nomos.java.Model.SourceFile;
import nomos.java.Model.TypeUnit;

/** The detectors. Every finding text is a template of its rule in spec/rules (checked by TextTest). */
final class Rules {
    /** The rules implemented for Java. STR001: the language has no goto; the others are not written (D-058). */
    static final List<String> SUPPORTED = List.of(
        "ALG001", "ALG002", "ALG003", "ALG004", "CC001", "CC002", "CC003", "CC004", "CC009", "DSN001", "DSN002", "DSN003", "DSN004", "DSN005", "DSN006",
        "FUN005", "MNT001", "MNT002", "MNT003", "MNT004", "OOP001", "OOP002", "OOP003", "OOP004", "OOP005", "PRN007", "SEC001", "SEC003", "STR002", "STR003");

    static final class Finding {
        String rule;
        String severity;
        String confidence;
        String category;
        Place place;
        String message;
        String explanation;
        String module;
        String entity;
        Text messageText;
        Text explanationText;
        Map<String, Object> measured;
    }

    /** Does not depend on the line (contracts/sarif-profile.md). */
    static String fingerprint(Finding f) {
        try {
            byte[] hash = MessageDigest.getInstance("SHA-256").digest((f.rule + "|" + f.place.file() + "|" + f.entity + "|" + f.message).getBytes(StandardCharsets.UTF_8));
            StringBuilder b = new StringBuilder();
            for (int i = 0; i < 8; i++) b.append(String.format("%02x", hash[i]));
            return b.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    /** State of one analysis shared by the detectors. */
    static final class Run {
        final Project p;
        final Config config;
        final List<Edge> edges;
        final Graphs graphs;
        final Map<String, Growth> estimates;
        final List<Finding> findings = new ArrayList<>();
        Map<String, Object> rule;
        final Map<String, Map<String, Object>> ran = new LinkedHashMap<>();
        final Map<String, Set<String>> active = new HashMap<>();
        Coverage coverage;

        Run(Project p, Config config, List<Edge> edges, Graphs graphs, Map<String, Growth> estimates) {
            this.p = p;
            this.config = config;
            this.edges = edges;
            this.graphs = graphs;
            this.estimates = estimates;
        }

        @SuppressWarnings("unchecked")
        List<String> paradigms() {
            return (List<String>) (List<?>) Json.array(rule.get("paradigms"));
        }

        boolean applies(Module m) {
            List<String> paradigms = paradigms();
            if (paradigms.isEmpty()) return true;
            Set<String> own = active.getOrDefault(m.id, Set.of());
            for (String x : paradigms) if (own.contains(x)) return true;
            return false;
        }

        double number(String name) {
            return config.number(rule, name);
        }

        /** A threshold as JSON writes it: an integer stays an integer. */
        Object threshold(String name) {
            double v = number(name);
            return v == Math.rint(v) ? (Object) (long) v : (Object) v;
        }

        String limit(String name) {
            double v = number(name);
            return v == Math.rint(v) ? Long.toString((long) v) : Json.number(v);
        }

        void report(String confidence, Place place, String module, String entity, Text message, Text explanation, Map<String, Object> measured, String severity) {
            Finding f = new Finding();
            f.rule = (String) rule.get("id");
            Object own = config.rule(f.rule).get("severity");
            f.severity = own instanceof String s ? s : severity != null ? severity : (String) rule.get("severity");
            f.confidence = confidence;
            f.category = (String) rule.get("category");
            f.place = place;
            f.message = message.render();
            f.explanation = explanation.render();
            f.module = module;
            f.entity = entity;
            f.messageText = message;
            f.explanationText = explanation;
            f.measured = measured;
            findings.add(f);
        }

        void report(String confidence, Place place, String module, String entity, Text message, Text explanation) {
            report(confidence, place, module, entity, message, explanation, null, null);
        }

        List<Fn> functions() {
            List<Fn> result = new ArrayList<>();
            for (Module m : p.modules) if (applies(m)) result.addAll(p.moduleFunctions(m));
            return result;
        }

        List<TypeUnit> types() {
            List<TypeUnit> result = new ArrayList<>();
            for (Module m : p.modules) if (applies(m)) result.addAll(m.types);
            return result;
        }

        Map<String, Object> martin(Module m) {
            Set<String> inside = new HashSet<>();
            for (TypeUnit t : m.types) inside.add(t.id);
            Set<String> incoming = new HashSet<>();
            Set<String> outgoing = new HashSet<>();
            for (String unit : inside) {
                for (String o : graphs.units.prev.getOrDefault(unit, Set.of())) if (!inside.contains(o)) incoming.add(o);
                for (String o : graphs.units.next.getOrDefault(unit, Set.of())) if (!inside.contains(o)) outgoing.add(o);
            }
            int ca = incoming.size();
            int ce = outgoing.size();
            Double instability = ca + ce > 0 ? Text.round((double) ce / (ca + ce), 4) : null;
            Double abstractness = null;
            if (!m.types.isEmpty()) {
                long abs = m.types.stream().filter(t -> t.isAbstract).count();
                abstractness = Text.round((double) abs / m.types.size(), 4);
            }
            Double distance = instability != null && abstractness != null ? Text.round(Math.abs(abstractness + instability - 1), 4) : null;
            return Json.obj("ca", ca, "ce", ce, "instability", instability, "abstractness", abstractness, "distance", distance);
        }

        int cbo(TypeUnit t) {
            Set<String> targets = new HashSet<>();
            for (Edge e : edges) if (e.from().equals(t.id) && !e.kind().equals("import") && e.toType() && !e.stdlib()) targets.add(e.to());
            return targets.size();
        }
    }

    static Map<String, Object> measured(String metric, Object value, Object threshold) {
        return Json.obj("metric", metric, "value", value, "threshold", threshold);
    }

    static Place filePlace(String path) {
        return new Place(path, 1, 1, 1, 1);
    }

    static int memberCount(TypeUnit t) {
        return t.members.size() + t.methods.size() + t.nested.size();
    }

    static final Map<String, Consumer<Run>> DETECTORS = new LinkedHashMap<>();

    static {
        DETECTORS.put("ALG001", Rules::alg001);
        DETECTORS.put("ALG002", Rules::alg002);
        DETECTORS.put("ALG003", Rules::alg003);
        DETECTORS.put("ALG004", Rules::alg004);
        DETECTORS.put("CC001", Rules::cc001);
        DETECTORS.put("CC002", Rules::cc002);
        DETECTORS.put("CC003", Rules::cc003);
        DETECTORS.put("CC004", Rules::cc004);
        DETECTORS.put("CC009", Rules::cc009);
        DETECTORS.put("DSN001", Rules::dsn001);
        DETECTORS.put("DSN002", Rules::dsn002);
        DETECTORS.put("DSN003", Rules::dsn003);
        DETECTORS.put("DSN004", Rules::dsn004);
        DETECTORS.put("DSN005", Rules::dsn005);
        DETECTORS.put("DSN006", Rules::dsn006);
        DETECTORS.put("FUN005", Rules::fun005);
        DETECTORS.put("MNT001", Rules::mnt001);
        DETECTORS.put("MNT002", Rules::mnt002);
        DETECTORS.put("MNT003", Rules::mnt003);
        DETECTORS.put("MNT004", Rules::mnt004);
        DETECTORS.put("OOP001", Rules::oop001);
        DETECTORS.put("OOP002", Rules::oop002);
        DETECTORS.put("OOP003", Rules::oop003);
        DETECTORS.put("OOP004", Rules::oop004);
        DETECTORS.put("OOP005", Rules::oop005);
        DETECTORS.put("PRN007", Rules::prn007);
        DETECTORS.put("SEC001", Rules::sec001);
        DETECTORS.put("SEC003", Rules::sec003);
        DETECTORS.put("STR002", Rules::str002);
        DETECTORS.put("STR003", Rules::str003);
    }

    // Clean code ----------------------------------------------------------------------------------------------------------

    private static void cc001(Run r) {
        double limit = r.number("maxLines");
        for (Fn f : r.functions()) {
            int lines = f.place.lines();
            if (!f.hasBody() || lines <= limit) continue;
            r.report("high", f.place, f.module.id, f.id, tx("{0} spans {1} lines", f.name, lines),
                tx("The line count is exact; the limit of {0} is a readability convention.", r.limit("maxLines")),
                measured("lines", lines, r.threshold("maxLines")), lines > limit * 2 ? "major" : null);
        }
    }

    private static void cc002(Run r) {
        double maxLines = r.number("maxLines");
        double maxMembers = r.number("maxMembers");
        for (TypeUnit t : r.types()) {
            int lines = t.place.lines();
            int count = memberCount(t);
            if (lines <= maxLines && count <= maxMembers) continue;
            Map<String, Object> m = lines > maxLines ? measured("lines", lines, r.threshold("maxLines")) : null;
            r.report("high", t.place, t.module.id, t.id, tx("{0} has {1} lines and {2} members", t.name, lines, count),
                tx("The counts are exact; the limits ({0} lines, {1} members) are conventions.", r.limit("maxLines"), r.limit("maxMembers")), m, null);
        }
    }

    private static void cc003(Run r) {
        for (Fn f : r.functions()) {
            int count = Metrics.parameterCount(f);
            String name = f.kind.equals("constructor") ? "maxConstructorParameters" : "maxParameters";
            if (count > r.number(name)) {
                r.report("high", f.place, f.module.id, f.id, tx("{0} takes {1} parameters", f.name, count),
                    tx("The limit is {0}. Long lists are easy to misorder; a parameter object groups what belongs together.", r.limit(name)),
                    measured("parameterCount", count, r.threshold(name)), null);
            }
        }
    }

    private static void cc004(Run r) {
        double limit = r.number("maxDepth");
        for (Fn f : r.functions()) {
            int depth = Metrics.maxNesting(f);
            if (depth > limit) {
                r.report("high", f.place, f.module.id, f.id, tx("{0} nests {1} levels deep", f.name, depth),
                    tx("The limit is {0}. Guard clauses or extracted methods flatten the flow.", r.limit("maxDepth")), measured("maxNesting", depth, r.threshold("maxDepth")), null);
            }
        }
    }

    private static void cc009(Run r) {
        for (Fn f : r.functions()) {
            for (Tree n : Metrics.body(f)) {
                if (!(n instanceof CatchTree c) || !c.getBlock().getStatements().isEmpty()) continue;
                // A comment in the handler says why ignoring is safe.
                if (f.file.hasComment(r.p.start(f.file, c.getBlock()), r.p.end(f.file, c.getBlock()))) continue;
                r.report("high", r.p.place(f.file, c), f.module.id, f.id, tx("Empty catch in {0}", f.name),
                    tx("The exception disappears without handling, logging or a comment saying why that is safe."));
            }
        }
    }

    // Algorithms ----------------------------------------------------------------------------------------------------------

    private static void alg001(Run r) {
        double reportFrom = r.number("reportFromDegree");
        for (Fn f : r.functions()) {
            Growth g = r.estimates.get(f.id);
            if (g == null || (!g.exponential() && g.degree() < reportFrom)) continue;
            Text explanation = g.uncertain()
                ? tx("Estimated from recursion, a while loop or a callee; loop bounds and call counts are not known exactly.")
                : tx("Estimated from nested loops over inputs of unknown size. Small inputs may make this irrelevant.");
            Map<String, Object> m = g.exponential() ? measured("timeExponential", 1, 1) : measured("timeDegree", g.degree(), r.threshold("reportFromDegree"));
            r.report(g.uncertain() ? "low" : "medium", f.place, f.module.id, f.id, tx("{0} is likely {1}", f.name, Estimate.text(g)), explanation, m,
                g.exponential() ? "major" : null);
        }
    }

    static TypeMirror typeOf(Run r, ExpressionTree e) {
        TypeMirror t = r.p.typesOf.get(e);
        if (t == null) {
            Element x = r.p.elements.get(Project.strip(e));
            if (x != null) t = x.asType();
        }
        return t;
    }

    private static void alg002(Run r) {
        for (Fn f : r.functions()) {
            List<Object[]> found = new ArrayList<>();
            Metrics.walkLoops(f, (n, depth) -> {
                if (depth == 0) return;
                if (n instanceof MethodInvocationTree call && call.getMethodSelect() instanceof MemberSelectTree s && Metrics.callee(r.p, call) == null
                    && Estimate.isSubtype(r.p, typeOf(r, s.getExpression()), "java.util.List")) {
                    String method = s.getIdentifier().toString();
                    if (method.equals("contains") || method.equals("indexOf") || method.equals("lastIndexOf")) found.add(new Object[] {n, "search", method});
                    if (method.equals("add") && call.getArguments().size() == 2 && call.getArguments().get(0) instanceof LiteralTree l && Integer.valueOf(0).equals(l.getValue())) {
                        found.add(new Object[] {n, "front", method});
                    }
                }
                if (n instanceof CompoundAssignmentTree a && a.getKind() == Tree.Kind.PLUS_ASSIGNMENT) {
                    TypeMirror t = typeOf(r, a.getVariable());
                    if (t != null && t.toString().equals("java.lang.String")) found.add(new Object[] {n, "concat", ""});
                }
            });
            for (Object[] x : found) {
                Place place = r.p.place(f.file, (Tree) x[0]);
                switch ((String) x[1]) {
                    case "search" -> r.report("medium", place, f.module.id, f.id, tx("Likely quadratic: {0} on a sequence inside a loop", x[2]),
                        tx("Each iteration scans the list. A HashSet or HashMap built once makes the lookup constant-time."));
                    case "front" -> r.report("medium", place, f.module.id, f.id, tx("Likely quadratic: {0}(0) inside a loop", x[2]),
                        tx("Every element shifts on each call. A Queue, a Stack or iterating from the end avoids this."));
                    default -> r.report("medium", place, f.module.id, f.id, tx("Likely quadratic: String concatenation inside a loop"),
                        tx("Each step copies the whole string so far. StringBuilder grows in amortized constant time."));
                }
            }
        }
    }

    static final Set<String> MATERIALIZING = Set.of("toList", "toArray", "collect", "copyOf");

    /** The name of a call that builds a new collection from another one, or null. */
    static String materialization(Run r, MethodInvocationTree call) {
        if (Metrics.callee(r.p, call) != null || !(call.getMethodSelect() instanceof MemberSelectTree s)) return null;
        String name = s.getIdentifier().toString();
        if (!MATERIALIZING.contains(name)) return null;
        Element named = r.p.elements.get(s.getExpression());
        if (named instanceof javax.lang.model.element.TypeElement te) {
            String type = te.getQualifiedName().toString();
            return name.equals("copyOf") && (type.equals("java.util.List") || type.equals("java.util.Set") || type.equals("java.util.Map") || type.equals("java.util.Arrays"))
                ? name + "()" : null;
        }
        TypeMirror receiver = typeOf(r, s.getExpression());
        if (Estimate.isSubtype(r.p, receiver, "java.util.stream.BaseStream") || Estimate.isSubtype(r.p, receiver, "java.util.Collection")) {
            return name.equals("copyOf") ? null : name + "()";
        }
        return null;
    }

    private static void alg003(Run r) {
        double limit = r.number("minDepthForObjects");
        for (Fn f : r.functions()) {
            int[] deepest = {0};
            List<Object[]> items = new ArrayList<>();
            Metrics.walkLoops(f, (n, depth) -> {
                if (Metrics.allocates(n)) deepest[0] = Math.max(deepest[0], depth);
                items.add(new Object[] {n, depth});
            });
            List<Tree> reported = new ArrayList<>();
            for (Object[] item : items) {
                Tree n = (Tree) item[0];
                int depth = (Integer) item[1];
                if (depth >= 1 && n instanceof MethodInvocationTree call) {
                    String name = materialization(r, call);
                    if (name != null) {
                        r.report("medium", r.p.place(f.file, n), f.module.id, f.id, tx("{0} allocates on each loop iteration", name),
                            tx("A new collection is built per iteration; moving it out of the loop or reusing a buffer reduces GC pressure."));
                    }
                }
                if (depth < limit || !Metrics.allocates(n) || within(r, f, n, reported)) continue;
                reported.add(n);
                Place place = r.p.place(f.file, n);
                Map<String, Object> m = measured("allocationDepth", deepest[0], r.threshold("minDepthForObjects"));
                if (n instanceof LambdaExpressionTree) {
                    r.report("low", place, f.module.id, f.id, tx("Lambda in a nested loop"),
                        tx("A capturing lambda allocates a closure per iteration; a non-capturing one is cached."), m, null);
                } else if (n instanceof NewClassTree creation) {
                    Tree type = creation.getIdentifier();
                    if (type instanceof ParameterizedTypeTree pt) type = pt.getType();
                    r.report("low", place, f.module.id, f.id, tx("Allocation of {0} in a nested loop", type.toString()),
                        tx("Runs once per inner iteration. Whether it matters depends on how hot the loop really is, which static analysis cannot tell."), m, null);
                } else {
                    r.report("low", place, f.module.id, f.id, tx("Allocation in a nested loop"),
                        tx("Runs once per inner iteration. Whether it matters depends on how hot the loop really is, which static analysis cannot tell."), m, null);
                }
            }
        }
    }

    private static boolean within(Run r, Fn f, Tree node, List<Tree> outers) {
        long s = r.p.start(f.file, node);
        long e = r.p.end(f.file, node);
        for (Tree outer : outers) if (outer == node || (r.p.start(f.file, outer) <= s && e <= r.p.end(f.file, outer))) return true;
        return false;
    }

    private static void alg004(Run r) {
        double reportFrom = r.number("reportFromDegree");
        for (Fn f : r.functions()) {
            if (!f.hasBody()) continue;
            int degree = Metrics.spaceDegree(r.p, f, Estimate.selfCalls(r.p, f).size());
            if (degree >= reportFrom) {
                r.report("low", f.place, f.module.id, f.id, tx("{0} likely uses {1} extra memory", f.name, Estimate.text(new Growth(degree, 0, false, false))),
                    tx("Estimated from collection growth under nested loops or multi-dimensional allocation sizes."), measured("spaceDegree", degree, r.threshold("reportFromDegree")), null);
            }
        }
    }

    // Design ------------------------------------------------------------------------------------------------------------

    private static void dsn001(Run r) {
        double limit = r.number("maxDistance");
        double coupling = r.number("minCoupling");
        for (Module m : r.p.modules) {
            Map<String, Object> x = r.martin(m);
            Double distance = (Double) x.get("distance");
            if (distance == null || distance <= limit || (Integer) x.get("ca") + (Integer) x.get("ce") < coupling || m.types.isEmpty()) continue;
            double instability = (Double) x.get("instability");
            String a = fixed((Double) x.get("abstractness"), 2);
            String i = fixed(instability, 2);
            Text explanation = instability < 0.5
                ? tx("A = {0}, I = {1}, so it sits near the zone of pain: concrete and heavily depended upon.", a, i)
                : tx("A = {0}, I = {1}, so it sits near the zone of uselessness: abstract and unused.", a, i);
            r.report("medium", m.types.get(0).place, m.id, "", tx("Module {0} is far from the main sequence (D = {1})", m.id, fixed(distance, 2)), explanation,
                measured("distance", distance, r.threshold("maxDistance")), null);
        }
    }

    private static void dsn002(Run r) {
        for (List<String> cycle : Graph.components(r.graphs.modules)) {
            Module m = r.p.byId.get(cycle.get(0));
            if (m != null && !m.files.isEmpty()) {
                r.report("high", filePlace(m.files.get(0).path), m.id, "", tx("Module cycle: {0}", String.join(" <-> ", cycle)),
                    tx("These modules depend on each other, directly or transitively, so none can be built, tested or released alone."));
            }
        }
        for (List<String> cycle : Graph.components(r.graphs.units)) {
            TypeUnit t = r.p.types.get(cycle.get(0));
            if (t == null) continue;
            List<String> names = new ArrayList<>();
            for (String c : cycle) names.add(Graph.simpleName(c));
            r.report("high", t.place, t.module.id, cycle.get(0), tx("Type cycle of {0}: {1}", cycle.size(), String.join(" <-> ", names)),
                tx("These types reference each other, so a change to one can ripple through all of them."), null, "minor");
        }
    }

    private static void dsn003(Run r) {
        if (r.config.layers.isEmpty()) return;
        for (Edge e : r.edges) {
            if (e.external() || e.kind().equals("import")) continue;
            Module sm = r.graphs.moduleOf.get(e.from());
            Module tm = r.graphs.moduleOf.get(e.to());
            if (sm == null || tm == null || sm == tm) continue;
            Map<String, Object> source = r.config.layerOf(sm.id);
            Map<String, Object> target = r.config.layerOf(tm.id);
            if (source == null || target == null) continue;
            String sourceName = (String) source.get("name");
            String targetName = (String) target.get("name");
            List<String> allowed = Config.strings(source.get("mayDependOn"));
            if (sourceName.equals(targetName) || allowed.contains(targetName)) continue;
            Text explanation = allowed.isEmpty()
                ? tx("{0} ({1}) uses {2} ({3}); allowed: none.", Graph.simpleName(e.from()), sm.id, Graph.simpleName(e.to()), tm.id)
                : tx("{0} ({1}) uses {2} ({3}); allowed: {4}.", Graph.simpleName(e.from()), sm.id, Graph.simpleName(e.to()), tm.id, String.join(", ", allowed));
            r.report("high", e.place(), sm.id, e.from(), tx("{0} must not depend on {1}", sourceName, targetName), explanation);
        }
    }

    private static void dsn004(Run r) {
        double minWmc = r.number("minWmc");
        double minAtfd = r.number("minAtfd");
        double maxTcc = r.number("maxTcc");
        for (TypeUnit t : r.types()) {
            if (!t.isClassLike()) continue;
            int w = Metrics.wmc(t);
            int a = Metrics.atfd(r.p, t);
            Double c = Metrics.tcc(r.p, t);
            if (w >= minWmc && a >= minAtfd && c != null && c < maxTcc) {
                r.report("low", t.place, t.module.id, t.id, tx("{0} looks like a god class", t.name),
                    tx("WMC = {0} (>= {1}), ATFD = {2} (>= {3}), TCC = {4} (< {5}): it does much, uses others' data, and its methods share little.",
                        w, r.limit("minWmc"), a, r.limit("minAtfd"), fixed(c, 2), fixed(maxTcc, 2)), measured("wmc", w, r.threshold("minWmc")), null);
            }
        }
    }

    private static void dsn005(Run r) {
        double limit = r.number("minForeignMembers");
        for (Fn f : r.functions()) {
            if (!f.isInstanceMethod()) continue;
            Map.Entry<String, List<String>> best = Metrics.mostUsedForeign(r.p, f);
            int own = Metrics.memberUse(r.p, f).own().size();
            List<String> names = best.getValue();
            if (names.size() >= limit && names.size() > own) {
                r.report("low", f.place, f.module.id, f.id, tx("{0} is more interested in {1} than in {2}", f.name, Graph.simpleName(best.getKey()), f.owner.name),
                    tx("It uses {0} members of {1} ({2}) and {3} of its own.", names.size(), best.getKey(), String.join(", ", names), own),
                    measured("foreignMembers", names.size(), r.threshold("minForeignMembers")), null);
            }
        }
    }

    private static void dsn006(Run r) {
        double limit = r.number("maxDependents");
        for (TypeUnit t : r.p.allTypes()) {
            int radius = r.graphs.radius.getOrDefault(t.id, 0);
            if (radius > limit) {
                r.report("medium", t.place, t.module.id, t.id, tx("Changing {0} can reach {1} units", t.name, radius),
                    tx("Stable abstractions at such points limit the spread. Static dependencies overstate real impact when a change keeps the contract."),
                    measured("blastRadius", radius, r.threshold("maxDependents")), null);
            }
        }
    }

    // Paradigm ----------------------------------------------------------------------------------------------------------

    private static void fun005(Run r) {
        double maxOrder = r.number("maxOrder");
        double maxLambdas = r.number("maxLambdaNesting");
        for (Fn f : r.functions()) {
            int order = Metrics.hofOrder(r.p, f);
            if (order > maxOrder) {
                r.report("medium", f.place, f.module.id, f.id, tx("{0} has order {1}", f.name, order), tx("The signature nests function types beyond order {0}.", r.limit("maxOrder")),
                    measured("hofOrder", order, r.threshold("maxOrder")), null);
            }
            int nesting = Metrics.lambdaNesting(f);
            if (nesting > maxLambdas) {
                r.report("medium", f.place, f.module.id, f.id, tx("{0} nests lambdas {1} levels deep", f.name, nesting),
                    tx("Beyond {0} levels, captured variables are hard to trace; named functions help.", r.limit("maxLambdaNesting")),
                    measured("lambdaNesting", nesting, r.threshold("maxLambdaNesting")), null);
            }
        }
    }

    private static void oop001(Run r) {
        for (TypeUnit t : r.types()) {
            if (!t.kind.equals("class")) continue;
            for (Member m : t.members) {
                if (m.kind.equals("field") && m.visibility.equals("public") && !m.isFinal && !m.isStatic) {
                    r.report("medium", m.place, t.module.id, t.id, tx("Public mutable field {0}.{1}", t.name, m.name),
                        tx("Any caller can change this field, so the type cannot protect its invariants. A property or a method can."));
                }
            }
        }
    }

    private static void oop002(Run r) {
        double limit = r.number("maxDepth");
        for (TypeUnit t : r.types()) {
            if (!t.isClassLike()) continue;
            int depth = Metrics.dit(t);
            if (depth > limit) {
                r.report("medium", t.place, t.module.id, t.id, tx("{0} sits {1} levels deep", t.name, depth),
                    tx("The depth counts base classes in the project; a base outside it is one step. Beyond {0} levels, behavior is spread over many classes. Composition often reads better.",
                        r.limit("maxDepth")), measured("dit", depth, r.threshold("maxDepth")), null);
            }
        }
    }

    private static void oop003(Run r) {
        double limit = r.number("minTypeTests");
        for (Fn f : r.functions()) {
            List<String> tested = Metrics.testedTypes(r.p, f);
            if (tested.size() >= limit) {
                List<String> names = new ArrayList<>();
                for (String x : tested) names.add(Graph.simpleName(x));
                r.report("medium", f.place, f.module.id, f.id, tx("{0} branches on {1} runtime types", f.name, tested.size()),
                    tx("It tests for {0}. A virtual member on their common base would dispatch without the checks.", String.join(", ", names)),
                    measured("typeTests", tested.size(), r.threshold("minTypeTests")), null);
            }
        }
    }

    private static void oop004(Run r) {
        double maxLcom = r.number("maxLcom");
        double minMethods = r.number("minMethods");
        for (TypeUnit t : r.types()) {
            if (!t.isClassLike()) continue;
            Integer lcom = Metrics.lcom4(r.p, t);
            if (lcom != null && lcom > maxLcom && Metrics.classMethods(t).size() >= minMethods) {
                r.report("medium", t.place, t.module.id, t.id, tx("{0} splits into {1} unrelated method groups", t.name, lcom),
                    tx("LCOM4 finds method groups that share no field and do not call each other; each may be a separate class."), measured("lcom4", lcom, r.threshold("maxLcom")), null);
            }
        }
    }

    private static void oop005(Run r) {
        double limit = r.number("maxCoupling");
        for (TypeUnit t : r.types()) {
            if (!t.isClassLike()) continue;
            int coupling = r.cbo(t);
            if (coupling > limit) {
                r.report("low", t.place, t.module.id, t.id, tx("{0} depends on {1} types", t.name, coupling),
                    tx("Beyond {0} collaborators, changes elsewhere are likely to reach this class.", r.limit("maxCoupling")), measured("cbo", coupling, r.threshold("maxCoupling")), null);
            }
        }
    }

    // Principles ----------------------------------------------------------------------------------------------------------

    private static void prn007(Run r) {
        double limit = r.number("maxBooleanOperators");
        for (Fn f : r.functions()) {
            Set<Tree> counted = java.util.Collections.newSetFromMap(new IdentityHashMap<>());
            for (Tree n : Metrics.body(f)) {
                if (n instanceof ConditionalExpressionTree c
                    && (Project.strip(c.getTrueExpression()) instanceof ConditionalExpressionTree || Project.strip(c.getFalseExpression()) instanceof ConditionalExpressionTree)) {
                    r.report("medium", r.p.place(f.file, n), f.module.id, f.id, tx("Nested ternary expression"),
                        tx("A ternary inside a ternary hides the branching; an if or a switch expression shows it."));
                }
                ExpressionTree condition = null;
                if (n instanceof IfTree s) condition = s.getCondition();
                else if (n instanceof WhileLoopTree s) condition = s.getCondition();
                else if (n instanceof DoWhileLoopTree s) condition = s.getCondition();
                else if (n instanceof ForLoopTree s) condition = s.getCondition();
                else if (n instanceof ConditionalExpressionTree s) condition = s.getCondition();
                if (condition == null) continue;
                condition = Project.strip(condition);
                if (!counted.add(condition)) continue;
                int operators = booleanOperators(condition);
                if (operators > limit) {
                    r.report("medium", r.p.place(f.file, condition), f.module.id, f.id, tx("Condition combines {0} boolean operators", operators),
                        tx("More than {0} operators in one condition; named intermediate values or a predicate method would state the intent.", r.limit("maxBooleanOperators")));
                }
            }
        }
    }

    private static int booleanOperators(Tree node) {
        if (node instanceof LambdaExpressionTree) return 0;
        int count = Metrics.isShortCircuit(node) ? 1 : 0;
        for (Tree c : Metrics.children(node)) count += booleanOperators(c);
        return count;
    }

    // Security ----------------------------------------------------------------------------------------------------------

    static final Pattern SECRET_NAME = Pattern.compile("password|passwd|pwd|secret|api_?key|apikey|access_?token|auth_?token|private_?key", Pattern.CASE_INSENSITIVE);
    static final Pattern KNOWN_CREDENTIAL = Pattern.compile("AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|sk-[A-Za-z0-9]{32,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[baprs]-[A-Za-z0-9-]{10,}");
    static final Pattern SQL_TEXT = Pattern.compile("\\b(SELECT\\s[\\s\\S]+\\sFROM|INSERT\\s+INTO|UPDATE\\s[\\s\\S]+\\sSET|DELETE\\s+FROM|DROP\\s+TABLE)\\b", Pattern.CASE_INSENSITIVE);

    /** The function whose declaration holds an offset, or an empty entity. */
    private static String ownerOf(Run r, Module m, SourceFile f, Tree node) {
        long at = r.p.start(f, node);
        Fn best = null;
        for (Fn fn : r.p.moduleFunctions(m)) {
            if (fn.file != f) continue;
            if (r.p.start(f, fn.tree) <= at && at <= r.p.end(f, fn.tree) && (best == null || r.p.start(f, fn.tree) >= r.p.start(f, best.tree))) best = fn;
        }
        return best != null ? best.id : "";
    }

    private static void sec001(Run r) {
        for (Module m : r.p.modules) {
            for (SourceFile f : m.files) {
                if (f.unit == null) continue;
                for (Tree n : Metrics.walk(f.unit)) {
                    if (n instanceof VariableTree v && v.getInitializer() != null) {
                        checkSecret(r, m, f, v.getName().toString(), v.getInitializer(), ownerOf(r, m, f, n));
                    } else if (n instanceof AssignmentTree a) {
                        ExpressionTree target = Project.strip(a.getVariable());
                        String name = target instanceof IdentifierTree i ? i.getName().toString() : target instanceof MemberSelectTree s ? s.getIdentifier().toString() : "";
                        if (!name.isEmpty()) checkSecret(r, m, f, name, a.getExpression(), ownerOf(r, m, f, n));
                    } else if (n instanceof MethodInvocationTree call && Metrics.methodName(call).equals("put") && call.getArguments().size() == 2
                        && Project.strip(call.getArguments().get(0)) instanceof LiteralTree key && key.getValue() instanceof String k) {
                        checkSecret(r, m, f, k, call.getArguments().get(1), ownerOf(r, m, f, n));
                    }
                }
            }
        }
    }

    private static void checkSecret(Run r, Module m, SourceFile f, String name, ExpressionTree value, String entity) {
        if (!(Project.strip(value) instanceof LiteralTree literal) || !(literal.getValue() instanceof String text) || text.length() < 6) return;
        Place place = r.p.place(f, literal);
        if (KNOWN_CREDENTIAL.matcher(text).find()) {
            r.report("high", place, m.id, entity, tx("{0} holds what looks like a real credential", name),
                tx("Heuristic: the literal matches the format of a known key or token. Rotate it if it is real, and load it from a secret store."), null, "critical");
        } else if (SECRET_NAME.matcher(name).find() && !Pattern.compile("[ {]").matcher(text).find()) {
            r.report("medium", place, m.id, entity, tx("{0} looks like a hardcoded secret", name),
                tx("Heuristic: the name suggests a secret and the value is a literal. It may be a placeholder or a non-secret value."));
        }
    }

    private static boolean isConstant(Run r, ExpressionTree e) {
        e = Project.strip(e);
        if (e instanceof LiteralTree) return true;
        Element x = r.p.elements.get(e);
        return x instanceof VariableElement v && v.getConstantValue() != null;
    }

    private static String constantText(Run r, ExpressionTree e) {
        e = Project.strip(e);
        if (e instanceof LiteralTree l) return l.getValue() instanceof String s ? s : "";
        Element x = r.p.elements.get(e);
        if (x instanceof VariableElement v && v.getConstantValue() instanceof String s) return s;
        return "";
    }

    private static void plusParts(ExpressionTree e, List<ExpressionTree> out) {
        ExpressionTree x = Project.strip(e);
        if (x instanceof BinaryTree b && b.getKind() == Tree.Kind.PLUS) {
            plusParts(b.getLeftOperand(), out);
            plusParts(b.getRightOperand(), out);
        } else {
            out.add(x);
        }
    }

    private static void sec003(Run r) {
        for (Module m : r.p.modules) {
            for (Fn f : r.p.moduleFunctions(m)) {
                Set<Tree> inner = java.util.Collections.newSetFromMap(new IdentityHashMap<>());
                for (Tree n : Metrics.body(f)) {
                    if (inner.contains(n)) continue;
                    String text = null;
                    boolean dynamic = false;
                    if (n instanceof BinaryTree b && b.getKind() == Tree.Kind.PLUS) {
                        List<ExpressionTree> parts = new ArrayList<>();
                        plusParts(b, parts);
                        StringBuilder constant = new StringBuilder();
                        boolean anyString = false;
                        for (ExpressionTree part : parts) {
                            if (isConstant(r, part)) {
                                String s = constantText(r, part);
                                anyString |= !s.isEmpty();
                                constant.append(s);
                            } else {
                                dynamic = true;
                            }
                        }
                        if (!anyString) continue;
                        text = constant.toString();
                        for (Tree x : Metrics.walk(b)) if (x != b) inner.add(x);
                    } else if (n instanceof MethodInvocationTree call && call.getMethodSelect() instanceof MemberSelectTree s) {
                        String name = s.getIdentifier().toString();
                        if (name.equals("format") && s.getExpression().toString().equals("String") && !call.getArguments().isEmpty() && isConstant(r, call.getArguments().get(0))) {
                            text = constantText(r, call.getArguments().get(0));
                            dynamic = call.getArguments().size() > 1;
                        } else if (name.equals("formatted") && isConstant(r, s.getExpression())) {
                            text = constantText(r, s.getExpression());
                            dynamic = !call.getArguments().isEmpty();
                        }
                    }
                    if (text != null && dynamic && SQL_TEXT.matcher(text).find()) {
                        r.report("medium", r.p.place(f.file, n), m.id, f.id, tx("SQL built from non-constant values"),
                            tx("Heuristic: if any value comes from a user, this allows injection. Parameterized queries keep data out of the statement."));
                    }
                }
            }
        }
    }

    // Structural --------------------------------------------------------------------------------------------------------

    private static void str002(Run r) {
        for (Module m : r.p.modules) {
            if (!r.applies(m)) continue;
            for (TypeUnit t : m.types) {
                for (Member x : t.members) {
                    if (!x.kind.equals("field") || !x.isStatic || x.isFinal || x.visibility.equals("private")) continue;
                    r.report("high", x.place, m.id, t.id, tx("Global mutable field {0}.{1}", t.name, x.name), tx("A non-private static mutable field is shared by all code and threads."));
                }
            }
        }
    }

    private static void str003(Run r) {
        double maxModule = r.number("maxModuleLines");
        double maxFile = r.number("maxFileLines");
        for (Module m : r.p.modules) {
            if (!r.applies(m)) continue;
            if (m.loc() > maxModule && !m.files.isEmpty()) {
                r.report("high", filePlace(m.files.get(0).path), m.id, "", tx("Module {0} has {1} lines of code", m.id, m.loc()),
                    tx("The limit is {0}; a smaller module is easier to understand as a unit.", r.limit("maxModuleLines")), measured("loc", m.loc(), r.threshold("maxModuleLines")), null);
            }
            for (SourceFile f : m.files) {
                if (f.lines > maxFile) {
                    r.report("high", filePlace(f.path), "", "", tx("{0} has {1} lines", f.path, f.lines), tx("The limit is {0}.", r.limit("maxFileLines")),
                        measured("lines", f.lines, r.threshold("maxFileLines")), null);
                }
            }
        }
    }

    // Maintainability ---------------------------------------------------------------------------------------------------

    private static void mnt001(Run r) {
        double limit = r.number("maxComplexity");
        for (Fn f : r.functions()) {
            int complexity = Metrics.cyclomatic(f);
            if (!f.hasBody() || complexity <= limit) continue;
            r.report("high", f.place, f.module.id, f.id, tx("{0} has cyclomatic complexity {1}", f.name, complexity),
                tx("The count is exact; above {0}, the number of paths to test and to understand grows quickly.", r.limit("maxComplexity")),
                measured("cyclomatic", complexity, r.threshold("maxComplexity")), complexity > limit * 2 ? "major" : null);
        }
    }

    private static void mnt002(Run r) {
        double limit = r.number("minIndex");
        for (Fn f : r.functions()) {
            Double index = Metrics.maintainabilityIndex(f);
            if (!f.hasBody() || index == null || index >= limit) continue;
            r.report("medium", f.place, f.module.id, f.id, tx("{0} has a maintainability index of {1}", f.name, fixed(index, 0)),
                tx("Below {0}. The formula is an empirical blend of size and complexity, useful for ranking rather than as a measure of quality.", r.limit("minIndex")),
                measured("maintainabilityIndex", Text.round(index, 4), r.threshold("minIndex")), null);
        }
    }

    private static List<int[]> normalized(SourceFile f, Map<String, Integer> ids) {
        List<int[]> result = new ArrayList<>();
        for (Lexer.Token t : f.tokens) {
            if (f.importLines.contains(t.line())) continue;
            String text = switch (t.kind()) {
                case NAME -> "$id";
                case LITERAL -> "$lit";
                default -> t.text();
            };
            Integer id = ids.get(text);
            if (id == null) {
                id = ids.size() + 1;
                ids.put(text, id);
            }
            result.add(new int[] {id, t.line()});
        }
        return result;
    }

    private static void mnt003(Run r) {
        int window = (int) r.number("minTokens");
        long base = 1000003;
        long modulus = 1000000007;
        Map<String, Integer> ids = new HashMap<>();
        List<SourceFile> files = new ArrayList<>();
        List<List<int[]>> streams = new ArrayList<>();
        for (SourceFile f : r.p.files) {
            List<int[]> tokens = normalized(f, ids);
            if (tokens.size() >= window && window > 0) {
                files.add(f);
                streams.add(tokens);
            }
        }
        long power = 1;
        for (int i = 1; i < window; i++) power = power * base % modulus;
        Map<Long, List<int[]>> seen = new HashMap<>();
        for (int index = 0; index < files.size(); index++) {
            List<int[]> tokens = streams.get(index);
            long h = 0;
            for (int i = 0; i < window; i++) h = (h * base + tokens.get(i)[0]) % modulus;
            int skipUntil = 0;
            for (int at = 0; at + window <= tokens.size(); at++) {
                if (at > 0) {
                    h = (h - tokens.get(at - 1)[0] * power % modulus + modulus) % modulus;
                    h = (h * base + tokens.get(at + window - 1)[0]) % modulus;
                }
                if (at >= skipUntil) {
                    for (int[] earlier : seen.getOrDefault(h, List.of())) {
                        List<int[]> other = streams.get(earlier[0]);
                        int length = 0;
                        while (earlier[1] + length < other.size() && at + length < tokens.size() && other.get(earlier[1] + length)[0] == tokens.get(at + length)[0]) length++;
                        if (length < window || (earlier[0] == index && earlier[1] + length > at)) continue;
                        skipUntil = at + length;
                        Place place = new Place(files.get(index).path, tokens.get(at)[1], 1, tokens.get(at + length - 1)[1], 1);
                        r.report("high", place, "", "", tx("{0} tokens duplicate {1}:{2}", length, files.get(earlier[0]).path, other.get(earlier[1])[1]),
                            tx("The token sequences are identical after replacing identifiers and literals with placeholders."), measured("cloneTokens", length, r.threshold("minTokens")), null);
                        break;
                    }
                }
                seen.computeIfAbsent(h, k -> new ArrayList<>()).add(new int[] {index, at});
            }
        }
    }

    private static void mnt004(Run r) {
        if (r.coverage == null) return;
        double limit = r.number("minCoverage");
        Object report = r.config.threshold(r.rule, "report");
        for (SourceFile f : r.p.files) {
            Double percent = r.coverage.percent(f.path);
            if (percent != null && percent < limit) {
                r.report("high", filePlace(f.path), "", "", tx("{0} has {1}% line coverage", f.path, fixed(percent, 0)),
                    tx("Measured from {0}; below the {1}% minimum. Coverage shows what ran, not what was verified.", report == null ? "" : report.toString(), r.limit("minCoverage")),
                    measured("coverage", percent, r.threshold("minCoverage")), null);
            }
        }
    }

    // Order ---------------------------------------------------------------------------------------------------------------

    static List<Finding> sort(List<Finding> findings) {
        Set<String> seen = new HashSet<>();
        List<Finding> unique = new ArrayList<>();
        for (Finding f : findings) {
            String key = f.rule + "\0" + f.place.file() + "\0" + f.place.startLine() + "\0" + f.place.startColumn() + "\0" + f.place.endLine() + "\0" + f.place.endColumn() + "\0" + f.message;
            if (seen.add(key)) unique.add(f);
        }
        unique.sort(Comparator.comparing((Finding f) -> f.place.file()).thenComparingInt(f -> f.place.startLine()).thenComparingInt(f -> f.place.startColumn())
            .thenComparing(f -> f.rule).thenComparing(f -> f.message));
        return unique;
    }
}
