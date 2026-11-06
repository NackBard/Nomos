package nomos.java;

import com.sun.source.tree.AnnotatedTypeTree;
import com.sun.source.tree.ClassTree;
import com.sun.source.tree.ExpressionTree;
import com.sun.source.tree.IdentifierTree;
import com.sun.source.tree.ImportTree;
import com.sun.source.tree.MemberReferenceTree;
import com.sun.source.tree.MemberSelectTree;
import com.sun.source.tree.MethodInvocationTree;
import com.sun.source.tree.NewClassTree;
import com.sun.source.tree.ParameterizedTypeTree;
import com.sun.source.tree.Tree;
import com.sun.source.util.TreeScanner;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import javax.lang.model.element.Element;
import javax.lang.model.element.ElementKind;
import javax.lang.model.element.Modifier;
import javax.lang.model.element.PackageElement;
import javax.lang.model.element.TypeElement;
import javax.lang.model.type.TypeKind;
import nomos.java.Model.Module;
import nomos.java.Model.Place;
import nomos.java.Model.SourceFile;
import nomos.java.Model.TypeUnit;

/** Dependency edges by spec/metrics.md, the unit and module graphs, cycles and blast radius. */
final class Graph {
    /** One occurrence of a dependency between units, or an import between modules. Every Java edge is runtime. */
    record Edge(String from, String to, String kind, boolean external, boolean stdlib, boolean toType, Place place) {
    }

    final Map<String, Set<String>> next = new TreeMap<>();
    final Map<String, Set<String>> prev = new TreeMap<>();

    void node(String n) {
        next.computeIfAbsent(n, k -> new TreeSet<>());
        prev.computeIfAbsent(n, k -> new TreeSet<>());
    }

    void edge(String a, String b) {
        node(a);
        node(b);
        next.get(a).add(b);
        prev.get(b).add(a);
    }

    static final class Graphs {
        final Graph units = new Graph();
        final Graph modules = new Graph();
        final Map<String, Module> moduleOf = new HashMap<>();
        final Map<String, Integer> radius = new HashMap<>();
    }

    // Edges -------------------------------------------------------------------------------------------------------------

    static List<Edge> collect(Project p) {
        List<Edge> edges = new ArrayList<>();
        for (Module m : p.modules) {
            for (SourceFile f : m.files) if (f.unit != null) edges.addAll(importEdges(p, m, f));
            for (TypeUnit t : m.types) new Collector(p, t, edges).unit();
        }
        return edges;
    }

    /** The package of a JDK element or the name of an unresolved one: the id of an external target. */
    static String external(Project p, Element e, SourceFile f) {
        TypeElement type = e instanceof TypeElement te ? te : enclosingType(e);
        if (type == null) return null;
        if (type.asType().getKind() == TypeKind.ERROR) return imported(f, type.getSimpleName().toString(), type.getQualifiedName().toString());
        return type.getQualifiedName().toString();
    }

    static TypeElement enclosingType(Element e) {
        for (Element x = e; x != null; x = x.getEnclosingElement()) if (x instanceof TypeElement te) return te;
        return null;
    }

    /** An unresolved name as its single-type import names it: Bar with import org.foo.Bar is org.foo.Bar. */
    static String imported(SourceFile f, String simple, String written) {
        if (f != null && f.unit != null && written.indexOf('.') < 0) {
            for (ImportTree i : f.unit.getImports()) {
                String text = i.getQualifiedIdentifier().toString();
                if (!i.isStatic() && text.endsWith("." + simple)) return text;
            }
        }
        return written;
    }

    static boolean isStdlib(Element e) {
        TypeElement type = e instanceof TypeElement te ? te : enclosingType(e);
        return type != null && type.asType().getKind() != TypeKind.ERROR;
    }

    private static final class Collector extends TreeScanner<Void, Void> {
        final Project p;
        final TypeUnit unit;
        final List<Edge> edges;
        final SourceFile f;
        final ArrayDeque<String> kinds = new ArrayDeque<>();

        Collector(Project p, TypeUnit unit, List<Edge> edges) {
            this.p = p;
            this.unit = unit;
            this.edges = edges;
            this.f = unit.file;
        }

        void unit() {
            ClassTree c = unit.tree;
            scan(c.getModifiers(), null);
            scan(c.getTypeParameters(), null);
            List<Tree> bases = new ArrayList<>();
            if (c.getExtendsClause() != null) bases.add(c.getExtendsClause());
            bases.addAll(c.getImplementsClause());
            for (Tree base : bases) {
                Tree named = base;
                if (named instanceof AnnotatedTypeTree a) named = a.getUnderlyingType();
                if (named instanceof ParameterizedTypeTree pt) {
                    inheritance(pt.getType());
                    scan(pt.getTypeArguments(), null);
                } else {
                    inheritance(named);
                }
            }
            for (Tree permitted : permits(c)) scan(permitted, null);
            for (Tree member : c.getMembers()) scan(member, null);
        }

        private List<? extends Tree> permits(ClassTree c) {
            try {
                return c.getPermitsClause();
            } catch (UnsupportedOperationException | NoSuchMethodError e) {
                return List.of();
            }
        }

        void inheritance(Tree named) {
            Element e = p.elements.get(named);
            if (e instanceof TypeElement) record(e, "inheritance", named);
            else if (named instanceof MemberSelectTree s) scan(s.getExpression(), null);
        }

        void record(Element e, String kind, Tree where) {
            Place place = p.place(f, where);
            TypeUnit target = p.unitOfElement(e);
            if (target != null) {
                if (target != unit) edges.add(new Edge(unit.id, target.id, kind, false, false, true, place));
                return;
            }
            String id = external(p, e, f);
            if (id != null) edges.add(new Edge(unit.id, id, kind, true, isStdlib(e), true, place));
        }

        private static boolean isMemberOfType(Element e) {
            ElementKind k = e.getKind();
            return k == ElementKind.METHOD || k == ElementKind.CONSTRUCTOR || k == ElementKind.FIELD || k == ElementKind.ENUM_CONSTANT;
        }

        /** Whether an expression names a type: the qualifier of a static member, which gives no edge of its own. */
        private boolean namesType(ExpressionTree e) {
            return p.elements.get(e) instanceof TypeElement;
        }

        private String memberKind(Element e) {
            ElementKind k = e.getKind();
            if (Metrics.memberOf(p, e) != null && k == ElementKind.METHOD) return "type-ref"; // a record component read through its accessor
            if (k == ElementKind.METHOD || k == ElementKind.CONSTRUCTOR || k == ElementKind.ENUM_CONSTANT) return "call";
            return e.getModifiers().contains(Modifier.STATIC) ? "call" : "type-ref";
        }

        @Override
        public Void visitClass(ClassTree node, Void unused) {
            TypeUnit own = p.typeOfTree.get(node);
            if (own != null && own != unit) return null; // a member type is a unit of its own
            return super.visitClass(node, unused);
        }

        @Override
        public Void visitIdentifier(IdentifierTree node, Void unused) {
            Element e = p.elements.get(node);
            if (e == null) return null;
            if (e instanceof TypeElement) {
                record(e, "type-ref", node);
            } else if (isMemberOfType(e)) {
                if (node.getName().contentEquals("super") || node.getName().contentEquals("this")) {
                    if (isGeneratedCall(node)) return null;
                }
                record(e, memberKind(e), node);
            }
            return null;
        }

        /** javac adds super() to a constructor that does not call this() or super() itself; the source has no such call. */
        private boolean isGeneratedCall(IdentifierTree node) {
            long start = p.start(f, node);
            return start < 0 || !f.text.startsWith(node.getName().toString(), (int) start);
        }

        @Override
        public Void visitMemberSelect(MemberSelectTree node, Void unused) {
            Element e = p.elements.get(node);
            if (e instanceof PackageElement) return null;
            if (e instanceof TypeElement && e.asType().getKind() == TypeKind.ERROR && !(p.elements.get(node.getExpression()) instanceof PackageElement)
                && !namesType(node.getExpression())) {
                // A member of a value whose type is not resolved: javac names it as a type; it belongs to the receiver's type.
                javax.lang.model.type.TypeMirror receiver = p.typesOf.get(node.getExpression());
                Element owner = receiver != null ? p.typeUtils.asElement(receiver) : null;
                Tree parent = p.parents.get(node);
                if (owner != null) record(owner, parent instanceof MethodInvocationTree ? "call" : "type-ref", node);
                return scan(node.getExpression(), null);
            }
            if (e instanceof TypeElement) {
                record(e, "type-ref", node);
                return null; // the qualifier is a package or an outer type, not a dependency of its own
            }
            if (e != null && isMemberOfType(e)) {
                record(e, memberKind(e), node);
                if (namesType(node.getExpression())) return null;
            } else if (node.getIdentifier().contentEquals("class")) {
                return scan(node.getExpression(), null);
            }
            return scan(node.getExpression(), null);
        }

        @Override
        public Void visitNewClass(NewClassTree node, Void unused) {
            Element constructor = p.elements.get(node);
            Tree type = node.getIdentifier();
            if (type instanceof AnnotatedTypeTree a) type = a.getUnderlyingType();
            Tree name = type instanceof ParameterizedTypeTree pt ? pt.getType() : type;
            Element target = constructor != null && constructor.getKind() == ElementKind.CONSTRUCTOR ? constructor : p.elements.get(name);
            if (target != null) record(target, "call", name);
            if (type instanceof ParameterizedTypeTree pt) scan(pt.getTypeArguments(), null);
            if (name instanceof MemberSelectTree s && !(p.elements.get(s.getExpression()) instanceof PackageElement) && !namesType(s.getExpression())) {
                scan(s.getExpression(), null);
            }
            scan(node.getEnclosingExpression(), null);
            scan(node.getTypeArguments(), null);
            scan(node.getArguments(), null);
            scan(node.getClassBody(), null);
            return null;
        }

        @Override
        public Void visitMemberReference(MemberReferenceTree node, Void unused) {
            Element e = p.elements.get(node);
            ExpressionTree qualifier = node.getQualifierExpression();
            if (e != null && isMemberOfType(e)) record(e, "call", node);
            else if (p.elements.get(qualifier) instanceof TypeElement t) record(t, "call", node);
            if (!namesType(qualifier) && !(qualifier instanceof ParameterizedTypeTree)) scan(qualifier, null);
            scan(node.getTypeArguments(), null);
            return null;
        }

        @Override
        public Void visitMethodInvocation(MethodInvocationTree node, Void unused) {
            return super.visitMethodInvocation(node, unused);
        }
    }

    // Imports -----------------------------------------------------------------------------------------------------------

    private static List<Edge> importEdges(Project p, Module m, SourceFile f) {
        List<Edge> edges = new ArrayList<>();
        for (ImportTree i : f.unit.getImports()) {
            Tree q = i.getQualifiedIdentifier();
            String text = q.toString();
            boolean wildcard = text.endsWith(".*");
            String target = null;
            boolean external = true;
            boolean stdlib = false;
            Tree named = q;
            if (wildcard && q instanceof MemberSelectTree s) named = s.getExpression();
            if (i.isStatic() && !wildcard && q instanceof MemberSelectTree s) named = s.getExpression();
            Element e = p.elements.get(named);
            if (e instanceof TypeElement te && te.asType().getKind() != TypeKind.ERROR) {
                TypeUnit own = p.typeOf.get(te);
                if (own != null) {
                    target = own.module.id;
                    external = false;
                } else {
                    target = packageOf(te);
                    stdlib = true;
                }
            } else if (e instanceof PackageElement pe) {
                String name = pe.getQualifiedName().toString();
                if (p.byId.containsKey(name)) {
                    target = name;
                    external = false;
                } else {
                    target = name;
                    stdlib = !pe.getEnclosedElements().isEmpty();
                }
            }
            if (target == null) {
                String written = wildcard ? text.substring(0, text.length() - 2) : text;
                target = packageOfName(written, wildcard && !i.isStatic());
                if (p.byId.containsKey(target)) external = false;
            }
            if (target.equals(m.id) || target.isEmpty()) continue;
            edges.add(new Edge(m.id, target, "import", external, stdlib, false, p.place(f, i)));
        }
        return edges;
    }

    private static String packageOf(Element e) {
        for (Element x = e; x != null; x = x.getEnclosingElement()) if (x instanceof PackageElement pe) return pe.getQualifiedName().toString();
        return "";
    }

    /** The package of an unresolved name: the segments before the first that starts with a capital (Java naming). */
    static String packageOfName(String name, boolean isPackage) {
        if (isPackage) return name;
        String[] parts = name.split("\\.");
        List<String> kept = new ArrayList<>();
        for (String part : parts) {
            if (!part.isEmpty() && Character.isUpperCase(part.charAt(0))) break;
            kept.add(part);
        }
        if (kept.size() == parts.length && parts.length > 1) kept.remove(kept.size() - 1);
        return String.join(".", kept);
    }

    // Graphs ------------------------------------------------------------------------------------------------------------

    static Graphs build(Project p, List<Edge> edges) {
        Graphs g = new Graphs();
        for (Module m : p.modules) {
            g.modules.node(m.id);
            for (TypeUnit t : m.types) {
                g.moduleOf.put(t.id, m);
                g.units.node(t.id);
            }
        }
        for (Edge e : edges) {
            if (e.external()) continue;
            if (e.kind().equals("import")) {
                g.modules.edge(e.from(), e.to());
                continue;
            }
            g.units.edge(e.from(), e.to());
            Module a = g.moduleOf.get(e.from());
            Module b = g.moduleOf.get(e.to());
            if (a != null && b != null && a != b) g.modules.edge(a.id, b.id);
        }
        for (String unit : g.units.next.keySet()) g.radius.put(unit, reach(g.units, unit));
        return g;
    }

    private static int reach(Graph g, String start) {
        Set<String> seen = new HashSet<>();
        seen.add(start);
        ArrayDeque<String> queue = new ArrayDeque<>();
        queue.add(start);
        while (!queue.isEmpty()) {
            String current = queue.poll();
            for (String dependent : g.prev.getOrDefault(current, Set.of())) {
                if (seen.add(dependent)) queue.add(dependent);
            }
        }
        return seen.size() - 1;
    }

    /** Strongly connected components with two or more members (Tarjan), iteratively. */
    static List<List<String>> components(Graph g) {
        Map<String, Integer> index = new HashMap<>();
        Map<String, Integer> low = new HashMap<>();
        Set<String> onStack = new HashSet<>();
        ArrayDeque<String> stack = new ArrayDeque<>();
        List<List<String>> result = new ArrayList<>();
        int[] counter = {0};
        for (String start : g.next.keySet()) {
            if (index.containsKey(start)) continue;
            ArrayDeque<Object[]> work = new ArrayDeque<>();
            java.util.function.Consumer<String> enter = n -> {
                index.put(n, counter[0]);
                low.put(n, counter[0]);
                counter[0]++;
                stack.push(n);
                onStack.add(n);
                work.push(new Object[] {n, new ArrayDeque<>(g.next.get(n))});
            };
            enter.accept(start);
            while (!work.isEmpty()) {
                Object[] top = work.peek();
                String node = (String) top[0];
                @SuppressWarnings("unchecked")
                ArrayDeque<String> successors = (ArrayDeque<String>) top[1];
                if (!successors.isEmpty()) {
                    String successor = successors.poll();
                    if (!index.containsKey(successor)) enter.accept(successor);
                    else if (onStack.contains(successor)) low.put(node, Math.min(low.get(node), index.get(successor)));
                    continue;
                }
                work.pop();
                if (!work.isEmpty()) {
                    String parent = (String) work.peek()[0];
                    low.put(parent, Math.min(low.get(parent), low.get(node)));
                }
                if (!low.get(node).equals(index.get(node))) continue;
                List<String> component = new ArrayList<>();
                while (true) {
                    String member = stack.pop();
                    onStack.remove(member);
                    component.add(member);
                    if (member.equals(node)) break;
                }
                if (component.size() > 1) {
                    component.sort(null);
                    result.add(component);
                }
            }
        }
        result.sort((a, b) -> a.get(0).compareTo(b.get(0)));
        return result;
    }

    static String simpleName(String id) {
        return id.substring(id.lastIndexOf('.') + 1);
    }
}
