package nomos.java;

import com.sun.source.tree.BinaryTree;
import com.sun.source.tree.BlockTree;
import com.sun.source.tree.CaseTree;
import com.sun.source.tree.DoWhileLoopTree;
import com.sun.source.tree.EnhancedForLoopTree;
import com.sun.source.tree.ExpressionTree;
import com.sun.source.tree.ForLoopTree;
import com.sun.source.tree.IdentifierTree;
import com.sun.source.tree.IfTree;
import com.sun.source.tree.InstanceOfTree;
import com.sun.source.tree.LambdaExpressionTree;
import com.sun.source.tree.LiteralTree;
import com.sun.source.tree.MemberSelectTree;
import com.sun.source.tree.MethodInvocationTree;
import com.sun.source.tree.NewArrayTree;
import com.sun.source.tree.NewClassTree;
import com.sun.source.tree.Tree;
import com.sun.source.tree.UnaryTree;
import com.sun.source.tree.VariableTree;
import com.sun.source.tree.WhileLoopTree;
import com.sun.source.util.TreeScanner;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.function.BiConsumer;
import javax.lang.model.element.Element;
import javax.lang.model.element.ElementKind;
import javax.lang.model.element.ExecutableElement;
import javax.lang.model.element.Modifier;
import javax.lang.model.element.TypeElement;
import javax.lang.model.type.ArrayType;
import javax.lang.model.type.DeclaredType;
import javax.lang.model.type.TypeKind;
import javax.lang.model.type.TypeMirror;
import javax.lang.model.type.WildcardType;
import nomos.java.Model.Fn;
import nomos.java.Model.Member;
import nomos.java.Model.TypeUnit;

/** Metrics of spec/metrics.md over the javac syntax tree with its attribution. */
final class Metrics {
    private Metrics() {
    }

    /** Every tree below a root in source order, the root included. */
    static List<Tree> walk(Tree root) {
        List<Tree> result = new ArrayList<>();
        if (root == null) return result;
        new TreeScanner<Void, Void>() {
            @Override
            public Void scan(Tree tree, Void unused) {
                if (tree == null) return null;
                result.add(tree);
                return super.scan(tree, unused);
            }
        }.scan(root, null);
        return result;
    }

    /** The trees of a function's body, lambdas and local and anonymous classes included: they belong to it. */
    static List<Tree> body(Fn f) {
        return walk(f.tree.getBody());
    }

    /** Direct children of a tree. */
    static List<Tree> children(Tree root) {
        List<Tree> result = new ArrayList<>();
        if (root == null) return result;
        new TreeScanner<Void, Void>() {
            boolean top = true;

            @Override
            public Void scan(Tree tree, Void unused) {
                if (tree == null) return null;
                if (top) {
                    top = false;
                    return super.scan(tree, unused);
                }
                result.add(tree);
                return null;
            }
        }.scan(root, null);
        return result;
    }

    // Case labels: getLabels() exists from Java 21, getExpressions() since Java 12. Reflection keeps --release 17.
    private static final Method LABELS = method(CaseTree.class, "getLabels");

    private static Method method(Class<?> type, String name) {
        try {
            return type.getMethod(name);
        } catch (NoSuchMethodException e) {
            return null;
        }
    }

    /** The labels of a case that are not default: one decision point each. */
    static int caseLabels(CaseTree c) {
        if (LABELS != null) {
            try {
                List<?> labels = (List<?>) LABELS.invoke(c);
                int count = 0;
                for (Object label : labels) {
                    String kind = ((Tree) label).getKind().name();
                    if (kind.equals("DEFAULT_CASE_LABEL")) return 0;
                    count++;
                }
                return count;
            } catch (ReflectiveOperationException e) {
                // fall back to the expressions below
            }
        }
        @SuppressWarnings("deprecation")
        List<? extends ExpressionTree> expressions = c.getExpressions();
        return expressions.size();
    }

    static boolean isLoop(Tree t) {
        return t instanceof ForLoopTree || t instanceof EnhancedForLoopTree || t instanceof WhileLoopTree || t instanceof DoWhileLoopTree;
    }

    static boolean isShortCircuit(Tree t) {
        return t.getKind() == Tree.Kind.CONDITIONAL_AND || t.getKind() == Tree.Kind.CONDITIONAL_OR;
    }

    /** 1 + decision points: if, case labels, loops, catch, ?:, && and ||. */
    static int cyclomatic(Fn f) {
        int count = 1;
        for (Tree n : body(f)) {
            switch (n.getKind()) {
                case IF, CONDITIONAL_EXPRESSION, FOR_LOOP, ENHANCED_FOR_LOOP, WHILE_LOOP, DO_WHILE_LOOP, CATCH, CONDITIONAL_AND, CONDITIONAL_OR -> count++;
                case CASE -> count += caseLabels((CaseTree) n);
                default -> {
                }
            }
        }
        return count;
    }

    static boolean isNesting(Tree t) {
        switch (t.getKind()) {
            case SWITCH, FOR_LOOP, ENHANCED_FOR_LOOP, WHILE_LOOP, DO_WHILE_LOOP, TRY, SYNCHRONIZED:
                return true;
            default:
                return t.getKind().name().equals("SWITCH_EXPRESSION");
        }
    }

    /** Deepest number of enclosing if, switch, loop, try and synchronized statements; else if stays on its if's level. */
    static int maxNesting(Fn f) {
        if (!f.hasBody()) return 0;
        int[] deepest = {0};
        new Object() {
            void visit(Tree n, int d) {
                deepest[0] = Math.max(deepest[0], d);
                if (n instanceof IfTree s) {
                    visitIf(s, d);
                    return;
                }
                if (isNesting(n)) {
                    deepest[0] = Math.max(deepest[0], d + 1);
                    for (Tree c : children(n)) visit(c, d + 1);
                    return;
                }
                for (Tree c : children(n)) visit(c, d);
            }

            void visitIf(IfTree s, int d) {
                visit(s.getCondition(), d);
                visit(s.getThenStatement(), d + 1);
                Tree other = s.getElseStatement();
                if (other instanceof IfTree elseIf) visitIf(elseIf, d);
                else if (other != null) visit(other, d + 1);
            }
        }.visit(f.tree.getBody(), 0);
        return deepest[0];
    }

    static int parameterCount(Fn f) {
        return f.tree.getParameters().size();
    }

    // Style -------------------------------------------------------------------------------------------------------------

    /** Depth of functional interfaces in a type: Function<A, B> is 1 + the deepest of A and B. */
    static int functionDepth(Project p, TypeMirror type, int depth) {
        if (type == null || depth > 10) return 0;
        if (type instanceof WildcardType w) {
            return Math.max(functionDepth(p, w.getExtendsBound(), depth + 1), functionDepth(p, w.getSuperBound(), depth + 1));
        }
        if (type instanceof ArrayType a) return functionDepth(p, a.getComponentType(), depth + 1);
        if (type.getKind() != TypeKind.DECLARED) return 0;
        DeclaredType declared = (DeclaredType) type;
        int inner = 0;
        for (TypeMirror argument : declared.getTypeArguments()) inner = Math.max(inner, functionDepth(p, argument, depth + 1));
        Element e = declared.asElement();
        if (e instanceof TypeElement te && te.getKind() == ElementKind.INTERFACE && isFunctional(p, te)) return 1 + inner;
        return inner;
    }

    static boolean isFunctional(Project p, TypeElement e) {
        try {
            return p.elementUtils.isFunctionalInterface(e);
        } catch (RuntimeException ex) {
            return false;
        }
    }

    /** 1 + the deepest functional interface in the parameters and the result. */
    static int hofOrder(Project p, Fn f) {
        int depth = 0;
        for (VariableTree parameter : f.tree.getParameters()) depth = Math.max(depth, functionDepth(p, p.typesOf.get(parameter), 0));
        if (f.element != null) depth = Math.max(depth, functionDepth(p, f.element.getReturnType(), 0));
        return 1 + depth;
    }

    static int lambdaNesting(Fn f) {
        if (!f.hasBody()) return 0;
        return new Object() {
            int depth(Tree n) {
                int deepest = 0;
                for (Tree c : children(n)) deepest = Math.max(deepest, c instanceof LambdaExpressionTree ? 1 + depth(c) : depth(c));
                return deepest;
            }
        }.depth(f.tree.getBody());
    }

    /** Distinct project types a function tests at run time: instanceof and type patterns. */
    static List<String> testedTypes(Project p, Fn f) {
        Set<String> seen = new TreeSet<>();
        for (Tree n : body(f)) {
            Tree type = null;
            if (n instanceof InstanceOfTree i) {
                type = i.getType();
                if (type == null && i.getPattern() != null) type = patternType(i.getPattern());
            } else if (n.getKind().name().equals("BINDING_PATTERN")) {
                type = patternType(n);
            }
            if (type == null) continue;
            TypeUnit t = p.unitOfType(type);
            if (t == null) t = p.unitOfMirror(p.typeOfTypeTree(type));
            if (t != null) seen.add(t.id);
        }
        return new ArrayList<>(seen);
    }

    private static Tree patternType(Tree pattern) {
        if (pattern instanceof com.sun.source.tree.BindingPatternTree b) return b.getVariable().getType();
        return null;
    }

    // Loops -------------------------------------------------------------------------------------------------------------

    /** Visits every tree with the number of loops whose body holds it; loop headers that run once are outside. */
    static void walkLoops(Fn f, BiConsumer<Tree, Integer> visit) {
        if (!f.hasBody()) return;
        new Object() {
            void go(Tree n, int depth) {
                if (n == null) return;
                visit.accept(n, depth);
                if (n instanceof ForLoopTree loop) {
                    for (Tree t : loop.getInitializer()) go(t, depth);
                    go(loop.getCondition(), depth + 1);
                    for (Tree t : loop.getUpdate()) go(t, depth + 1);
                    go(loop.getStatement(), depth + 1);
                    return;
                }
                if (n instanceof EnhancedForLoopTree loop) {
                    go(loop.getVariable(), depth + 1);
                    go(loop.getExpression(), depth);
                    go(loop.getStatement(), depth + 1);
                    return;
                }
                if (n instanceof WhileLoopTree loop) {
                    go(loop.getCondition(), depth + 1);
                    go(loop.getStatement(), depth + 1);
                    return;
                }
                if (n instanceof DoWhileLoopTree loop) {
                    go(loop.getStatement(), depth + 1);
                    go(loop.getCondition(), depth + 1);
                    return;
                }
                for (Tree c : children(n)) go(c, depth);
            }
        }.go(f.tree.getBody(), 0);
    }

    /** Creates an object on the heap: new, an array or a lambda. */
    static boolean allocates(Tree n) {
        return n instanceof NewClassTree || n instanceof NewArrayTree || n instanceof LambdaExpressionTree;
    }

    static int allocationDepth(Fn f) {
        int[] deepest = {0};
        walkLoops(f, (n, depth) -> {
            if (allocates(n)) deepest[0] = Math.max(deepest[0], depth);
        });
        return deepest[0];
    }

    static final Set<String> GROWING = Set.of("add", "addAll", "put", "putAll", "push", "offer", "addFirst", "addLast", "offerFirst", "offerLast", "append",
        "insert", "putIfAbsent", "computeIfAbsent");

    static boolean isLiteralNumber(Tree n) {
        if (n instanceof UnaryTree u && (u.getKind() == Tree.Kind.UNARY_MINUS || u.getKind() == Tree.Kind.UNARY_PLUS)) n = u.getExpression();
        return n instanceof LiteralTree l && l.getValue() instanceof Number;
    }

    /** The callee of a call inside the project, or null. */
    static Fn callee(Project p, MethodInvocationTree call) {
        Element e = p.elements.get(call);
        if (e == null) e = p.elements.get(call.getMethodSelect());
        return e != null ? p.fnOf.get(e) : null;
    }

    static String methodName(MethodInvocationTree call) {
        ExpressionTree select = call.getMethodSelect();
        if (select instanceof MemberSelectTree s) return s.getIdentifier().toString();
        if (select instanceof IdentifierTree i) return i.getName().toString();
        return "";
    }

    /** Collection growth in loops, arrays of non-literal size, direct recursion. */
    static int spaceDegree(Project p, Fn f, int selfCalls) {
        int[] degree = {0};
        walkLoops(f, (n, depth) -> {
            if (n instanceof MethodInvocationTree call && call.getMethodSelect() instanceof MemberSelectTree && GROWING.contains(methodName(call)) && callee(p, call) == null) {
                degree[0] = Math.max(degree[0], depth);
            }
            if (n instanceof NewArrayTree array) {
                int sized = 0;
                for (Tree d : array.getDimensions()) if (!isLiteralNumber(d)) sized++;
                if (sized > 0) degree[0] = Math.max(degree[0], depth + sized);
            }
        });
        if (selfCalls > 0) degree[0] = Math.max(degree[0], 1);
        return degree[0];
    }

    // Cohesion ----------------------------------------------------------------------------------------------------------

    /** The instance field or record component an element is, if it belongs to a project type. */
    static Member memberOf(Project p, Element e) {
        if (e == null) return null;
        Member m = p.memberOf.get(e);
        if (m != null) return m.kind.equals("field") || m.kind.equals("property") ? (m.isStatic ? null : m) : null;
        if (e instanceof ExecutableElement method && method.getParameters().isEmpty() && !p.fnOf.containsKey(method)) {
            TypeUnit owner = p.typeOf.get(method.getEnclosingElement());
            if (owner != null && owner.kind.equals("record")) {
                for (Member c : owner.members) if (c.kind.equals("property") && c.name.contentEquals(method.getSimpleName())) return c;
            }
        }
        return null;
    }

    record Use(Set<Member> own, Map<String, Set<String>> foreign) {
    }

    private static final Map<Fn, Use> USES = new HashMap<>();

    /** Fields of its own type a function touches and, by owner, those of other project types reached through a member (ATFD counts them all). */
    static Use memberUse(Project p, Fn f) {
        Use cached = USES.get(f);
        if (cached != null) return cached;
        Set<Member> own = new LinkedHashSet<>();
        Map<String, Set<String>> foreign = new TreeMap<>();
        for (Tree n : body(f)) {
            Element e;
            boolean selected;
            if (n instanceof IdentifierTree i) {
                e = p.elements.get(i);
                selected = false;
            } else if (n instanceof MemberSelectTree s) {
                e = p.elements.get(s);
                selected = true;
            } else if (n instanceof MethodInvocationTree call && call.getArguments().isEmpty()) {
                e = p.elements.get(call);
                selected = call.getMethodSelect() instanceof MemberSelectTree;
            } else {
                continue;
            }
            Member m = memberOf(p, e);
            if (m == null) continue;
            if (m.owner == f.owner) own.add(m);
            else if (selected) foreign.computeIfAbsent(m.owner.id, k -> new TreeSet<>()).add(m.name);
        }
        Use use = new Use(own, foreign);
        USES.put(f, use);
        return use;
    }

    static Map.Entry<String, List<String>> mostUsedForeign(Project p, Fn f) {
        Map<String, Set<String>> foreign = memberUse(p, f).foreign();
        String best = "";
        for (String owner : foreign.keySet()) {
            // Records and enums hold data meant to be read: foreignMembers counts classes only (spec/metrics.md).
            if (!p.types.get(owner).kind.equals("class")) continue;
            if (best.isEmpty() || foreign.get(owner).size() > foreign.get(best).size()) best = owner;
        }
        return Map.entry(best, best.isEmpty() ? List.of() : new ArrayList<>(foreign.get(best)));
    }

    static List<Fn> classMethods(TypeUnit t) {
        List<Fn> result = new ArrayList<>();
        for (Fn m : t.methods) if (m.kind.equals("method") && !m.isStatic && m.hasBody()) result.add(m);
        return result;
    }

    static int wmc(TypeUnit t) {
        int total = 0;
        for (Fn m : t.methods) total += cyclomatic(m);
        return total;
    }

    /** Longest chain of base classes; a base outside the project is one step, Object and interfaces do not count. */
    static int dit(TypeUnit t) {
        Set<TypeUnit> seen = new HashSet<>();
        int depth = 0;
        for (TypeUnit x = t; x != null && seen.add(x); x = x.superclass) {
            if (x.superclass != null) depth++;
            else if (x.externalSuperclass) depth++;
        }
        return depth;
    }

    static Set<Fn> calledFunctions(Project p, Fn f) {
        Set<Fn> result = new HashSet<>();
        for (Tree n : body(f)) {
            if (n instanceof MethodInvocationTree call) {
                Fn target = callee(p, call);
                if (target != null) result.add(target);
            }
        }
        return result;
    }

    static Integer lcom4(Project p, TypeUnit t) {
        List<Fn> methods = classMethods(t);
        if (methods.isEmpty()) return null;
        int[] parent = new int[methods.size()];
        for (int i = 0; i < parent.length; i++) parent[i] = i;
        List<Set<Member>> uses = new ArrayList<>();
        List<Set<Fn>> calls = new ArrayList<>();
        for (Fn m : methods) {
            uses.add(memberUse(p, m).own());
            calls.add(calledFunctions(p, m));
        }
        for (int i = 0; i < methods.size(); i++) {
            for (int j = i + 1; j < methods.size(); j++) {
                Set<Member> shared = new HashSet<>(uses.get(i));
                shared.retainAll(uses.get(j));
                if (!shared.isEmpty() || calls.get(i).contains(methods.get(j)) || calls.get(j).contains(methods.get(i))) parent[find(parent, i)] = find(parent, j);
            }
        }
        Set<Integer> roots = new HashSet<>();
        for (int i = 0; i < parent.length; i++) roots.add(find(parent, i));
        return roots.size();
    }

    private static int find(int[] parent, int i) {
        while (parent[i] != i) {
            parent[i] = parent[parent[i]];
            i = parent[i];
        }
        return i;
    }

    static Double tcc(Project p, TypeUnit t) {
        List<Fn> methods = new ArrayList<>();
        for (Fn m : classMethods(t)) if (!m.visibility.equals("private")) methods.add(m);
        if (methods.size() < 2) return null;
        int connected = 0;
        for (int i = 0; i < methods.size(); i++) {
            for (int j = i + 1; j < methods.size(); j++) {
                Set<Member> shared = new HashSet<>(memberUse(p, methods.get(i)).own());
                shared.retainAll(memberUse(p, methods.get(j)).own());
                if (!shared.isEmpty()) connected++;
            }
        }
        double pairs = methods.size() * (methods.size() - 1) / 2.0;
        return Text.round(connected / pairs, 4);
    }

    static int atfd(Project p, TypeUnit t) {
        Set<String> seen = new HashSet<>();
        for (Fn m : t.methods) memberUse(p, m).foreign().forEach((owner, names) -> names.forEach(n -> seen.add(owner + "." + n)));
        return seen.size();
    }

    // Halstead ----------------------------------------------------------------------------------------------------------

    static final Set<String> SEPARATORS = Set.of("(", ")", "{", "}", "[", "]", ";", ",");

    /** N log2 n over the tokens of the lines of a function, without separators. */
    static Double halsteadVolume(Fn f) {
        int total = 0;
        Set<String> distinct = new HashSet<>();
        for (Lexer.Token t : f.file.tokens) {
            if (t.line() < f.place.startLine() || t.line() > f.place.endLine()) continue;
            if (t.kind() == Lexer.Kind.OP && SEPARATORS.contains(t.text())) continue;
            total++;
            distinct.add(t.text());
        }
        if (distinct.size() < 2) return null;
        return total * (Math.log(distinct.size()) / Math.log(2));
    }

    static Double maintainabilityIndex(Fn f) {
        Double volume = halsteadVolume(f);
        int lines = f.place.lines();
        if (volume == null || lines == 0) return null;
        return Math.max(0.0, (171 - 5.2 * Math.log(volume) - 0.23 * cyclomatic(f) - 16.2 * Math.log(lines)) * 100 / 171);
    }

    static boolean isStatic(Element e) {
        return e != null && e.getModifiers().contains(Modifier.STATIC);
    }

    static boolean unused(BlockTree b) {
        return b == null;
    }

    static boolean isBinary(Tree t, Tree.Kind kind) {
        return t instanceof BinaryTree && t.getKind() == kind;
    }
}
