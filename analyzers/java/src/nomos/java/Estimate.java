package nomos.java;

import com.sun.source.tree.AssignmentTree;
import com.sun.source.tree.BinaryTree;
import com.sun.source.tree.BlockTree;
import com.sun.source.tree.CaseTree;
import com.sun.source.tree.ClassTree;
import com.sun.source.tree.CompoundAssignmentTree;
import com.sun.source.tree.ConditionalExpressionTree;
import com.sun.source.tree.DoWhileLoopTree;
import com.sun.source.tree.EnhancedForLoopTree;
import com.sun.source.tree.ExpressionStatementTree;
import com.sun.source.tree.ExpressionTree;
import com.sun.source.tree.ForLoopTree;
import com.sun.source.tree.IdentifierTree;
import com.sun.source.tree.IfTree;
import com.sun.source.tree.LambdaExpressionTree;
import com.sun.source.tree.LiteralTree;
import com.sun.source.tree.MemberSelectTree;
import com.sun.source.tree.MethodInvocationTree;
import com.sun.source.tree.NewArrayTree;
import com.sun.source.tree.StatementTree;
import com.sun.source.tree.SwitchTree;
import com.sun.source.tree.Tree;
import com.sun.source.tree.VariableTree;
import com.sun.source.tree.WhileLoopTree;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import javax.lang.model.element.Element;
import javax.lang.model.element.TypeElement;
import javax.lang.model.type.TypeKind;
import javax.lang.model.type.TypeMirror;
import nomos.java.Model.Fn;

/** Time estimates of spec/metrics.md: n^degree · log^l n, or exponential. */
final class Estimate {
    record Growth(int degree, int log, boolean exponential, boolean uncertain) {
        Growth uncertain(boolean value) {
            return new Growth(degree, log, exponential, value);
        }
    }

    static final Growth CONSTANT = new Growth(0, 0, false, false);
    static final Growth LINEAR = new Growth(1, 0, false, false);
    static final Growth LOGARITHMIC = new Growth(0, 1, false, false);

    static Growth times(Growth a, Growth b) {
        return new Growth(a.degree + b.degree, a.log + b.log, a.exponential || b.exponential, a.uncertain || b.uncertain);
    }

    static Growth larger(Growth a, Growth b) {
        boolean pickB = (b.exponential != a.exponential && b.exponential)
            || (b.exponential == a.exponential && (b.degree > a.degree || (b.degree == a.degree && b.log > a.log)));
        Growth winner = pickB ? b : a;
        return winner.uncertain(a.uncertain || b.uncertain);
    }

    static String text(Growth g) {
        if (g.exponential) return "O(2ⁿ)";
        List<String> parts = new ArrayList<>();
        if (g.degree == 1) parts.add("n");
        else if (g.degree == 2) parts.add("n²");
        else if (g.degree == 3) parts.add("n³");
        else if (g.degree > 3) parts.add("n^" + g.degree);
        if (g.log == 1) parts.add("log n");
        else if (g.log > 1) parts.add("log^" + g.log + " n");
        return parts.isEmpty() ? "O(1)" : "O(" + String.join(" ", parts) + ")";
    }

    static final Set<String> SORTS = Set.of("sort", "sorted", "parallelSort");
    static final Set<String> COLLECTION_LINEAR = Set.of("contains", "containsAll", "indexOf", "lastIndexOf", "remove", "removeAll", "retainAll", "removeIf",
        "forEach", "toArray", "containsValue", "equals", "hashCode", "toString");
    static final Set<String> STREAM_LINEAR = Set.of("filter", "map", "flatMap", "mapToInt", "mapToLong", "mapToDouble", "mapToObj", "reduce", "collect", "anyMatch",
        "allMatch", "noneMatch", "count", "sum", "min", "max", "average", "toList", "toArray", "distinct", "findFirst", "findAny", "forEach", "summaryStatistics");
    static final Set<String> HELPER_LINEAR = Set.of("max", "min", "frequency", "reverse", "shuffle", "fill", "copy", "copyOf", "equals", "join", "binarySearch",
        "nCopies", "disjoint", "rotate", "swap");

    private Estimate() {
    }

    static List<MethodInvocationTree> selfCalls(Project p, Fn f) {
        List<MethodInvocationTree> result = new ArrayList<>();
        for (Tree n : Metrics.body(f)) if (n instanceof MethodInvocationTree call && Metrics.callee(p, call) == f) result.add(call);
        return result;
    }

    /** Estimates every function with a body in ordinal id order: mutual recursion is cut at the function still being estimated. */
    static Map<String, Growth> all(Project p) {
        Estimator e = new Estimator(p);
        Map<String, Growth> result = new HashMap<>();
        for (Fn f : p.allFunctions()) if (f.hasBody()) result.put(f.id, e.estimate(f));
        return result;
    }

    static boolean dividesByTwo(Project p, Tree n) {
        for (Tree c : Metrics.walk(n)) {
            if (c instanceof BinaryTree b && b.getRightOperand() instanceof LiteralTree l && l.getValue() instanceof Number v) {
                if (b.getKind() == Tree.Kind.DIVIDE && v.doubleValue() == 2) return true;
                if ((b.getKind() == Tree.Kind.RIGHT_SHIFT || b.getKind() == Tree.Kind.UNSIGNED_RIGHT_SHIFT) && v.doubleValue() == 1) return true;
            }
        }
        return false;
    }

    /** A step that divides or multiplies a counter: /=, *=, >>=, >>>=, <<=, or i = i / 2. */
    static boolean isHalving(Project p, Tree n) {
        if (n instanceof ExpressionStatementTree s) n = s.getExpression();
        if (n instanceof CompoundAssignmentTree c) {
            return switch (c.getKind()) {
                case DIVIDE_ASSIGNMENT, MULTIPLY_ASSIGNMENT, RIGHT_SHIFT_ASSIGNMENT, UNSIGNED_RIGHT_SHIFT_ASSIGNMENT, LEFT_SHIFT_ASSIGNMENT -> true;
                default -> false;
            };
        }
        if (n instanceof AssignmentTree a) return dividesByTwo(p, a.getExpression());
        return false;
    }

    /** for (int i = 0; i < 10; i++): a literal start and a literal bound. */
    static boolean literalBounds(ForLoopTree loop) {
        if (loop.getInitializer().size() != 1 || !(loop.getInitializer().get(0) instanceof VariableTree v)) return false;
        if (!Metrics.isLiteralNumber(v.getInitializer())) return false;
        if (!(Project.strip(loop.getCondition()) instanceof BinaryTree b)) return false;
        String name = v.getName().toString();
        boolean left = b.getLeftOperand() instanceof IdentifierTree i && i.getName().contentEquals(name) && Metrics.isLiteralNumber(b.getRightOperand());
        boolean right = b.getRightOperand() instanceof IdentifierTree i && i.getName().contentEquals(name) && Metrics.isLiteralNumber(b.getLeftOperand());
        return left || right;
    }

    /** An array initializer or List.of, Set.of, Arrays.asList with literal elements: a collection of constant size. */
    static boolean constantCollection(ExpressionTree x) {
        x = Project.strip(x);
        if (x instanceof NewArrayTree a) return a.getDimensions().isEmpty() && a.getInitializers() != null;
        if (x instanceof LiteralTree l && l.getValue() instanceof String) return true;
        if (x instanceof MethodInvocationTree call) {
            String name = Metrics.methodName(call);
            String receiver = call.getMethodSelect() instanceof MemberSelectTree s ? s.getExpression().toString() : "";
            if ((name.equals("of") && (receiver.equals("List") || receiver.equals("Set") || receiver.equals("Stream"))) || (name.equals("asList") && receiver.equals("Arrays"))) {
                for (ExpressionTree a : call.getArguments()) if (!(Project.strip(a) instanceof LiteralTree)) return false;
                return true;
            }
        }
        return false;
    }

    static boolean canComplete(List<? extends StatementTree> body) {
        if (body.isEmpty()) return true;
        StatementTree last = body.get(body.size() - 1);
        if (last instanceof BlockTree b) return canComplete(b.getStatements());
        return switch (last.getKind()) {
            case RETURN, THROW, BREAK, CONTINUE -> false;
            default -> true;
        };
    }

    static List<? extends StatementTree> statements(StatementTree s) {
        if (s == null) return List.of();
        if (s instanceof BlockTree b) return b.getStatements();
        return List.of(s);
    }

    static boolean isSubtype(Project p, TypeMirror type, String name) {
        if (type == null || type.getKind() != TypeKind.DECLARED) return false;
        TypeElement target = p.elementUtils.getTypeElement(name);
        if (target == null) return false;
        return p.typeUtils.isAssignable(p.typeUtils.erasure(type), p.typeUtils.erasure(target.asType()));
    }

    /** The library operation a call is: "linear", "sort" or null. */
    static String library(Project p, MethodInvocationTree call) {
        if (Metrics.callee(p, call) != null) return null;
        String name = Metrics.methodName(call);
        if (!(call.getMethodSelect() instanceof MemberSelectTree select)) return null;
        ExpressionTree receiver = select.getExpression();
        Element named = p.elements.get(receiver);
        if (named instanceof TypeElement te) {
            String type = te.getQualifiedName().toString();
            if (SORTS.contains(name) && (type.equals("java.util.Collections") || type.equals("java.util.Arrays"))) return "sort";
            if (HELPER_LINEAR.contains(name) && (type.equals("java.util.Collections") || type.equals("java.util.Arrays"))) return "linear";
            if (name.equals("join") && type.equals("java.lang.String")) return "linear";
            if (name.equals("copyOf") && (type.equals("java.util.List") || type.equals("java.util.Set") || type.equals("java.util.Map"))) return "linear";
            return null;
        }
        TypeMirror type = p.typesOf.get(receiver);
        if (isSubtype(p, type, "java.util.stream.BaseStream")) {
            if (name.equals("sorted")) return "sort";
            return STREAM_LINEAR.contains(name) ? "linear" : null;
        }
        if (isSubtype(p, type, "java.util.Set") || isSubtype(p, type, "java.util.Map")) {
            return name.equals("forEach") || name.equals("containsValue") || name.equals("toArray") || name.equals("removeIf") ? "linear" : null;
        }
        if (isSubtype(p, type, "java.util.Collection") || isSubtype(p, type, "java.lang.Iterable")) {
            if (name.equals("sort")) return "sort";
            if (name.equals("remove") && call.getArguments().size() == 1 && isIndex(p, call.getArguments().get(0))) return null;
            return COLLECTION_LINEAR.contains(name) && !name.equals("hashCode") ? "linear" : null;
        }
        return null;
    }

    private static boolean isIndex(Project p, ExpressionTree argument) {
        TypeMirror t = p.typesOf.get(argument);
        if (t == null && argument instanceof IdentifierTree i) {
            Element e = p.elements.get(i);
            t = e != null ? e.asType() : null;
        }
        return t != null && t.getKind() == TypeKind.INT;
    }

    static final class Estimator {
        final Project p;
        final Map<Fn, Growth> memo = new HashMap<>();
        final Set<Fn> active = new HashSet<>();
        Set<String> elements = new HashSet<>();
        Fn current;

        Estimator(Project p) {
            this.p = p;
        }

        Growth estimate(Fn f) {
            Growth known = memo.get(f);
            if (known != null) return known;
            if (!f.hasBody() || active.contains(f)) return CONSTANT;
            active.add(f);
            Set<String> outerElements = elements;
            Fn outer = current;
            elements = new HashSet<>();
            current = f;
            Growth growth = combine(f, cost(f.tree.getBody()));
            elements = outerElements;
            current = outer;
            active.remove(f);
            memo.put(f, growth);
            return growth;
        }

        Growth block(List<? extends Tree> nodes) {
            Growth total = CONSTANT;
            for (Tree n : nodes) total = larger(total, cost(n));
            return total;
        }

        Growth children(Tree n) {
            return block(Metrics.children(n));
        }

        List<String> bind(VariableTree v) {
            List<String> added = new ArrayList<>();
            String name = v.getName().toString();
            if (elements.add(name)) added.add(name);
            return added;
        }

        Growth cost(Tree n) {
            if (n == null) return CONSTANT;
            if (n instanceof ClassTree) return CONSTANT;
            if (n instanceof ForLoopTree loop) {
                Growth header = block(loop.getInitializer());
                List<Tree> inner = new ArrayList<>();
                if (loop.getCondition() != null) inner.add(loop.getCondition());
                inner.addAll(loop.getUpdate());
                inner.add(loop.getStatement());
                Growth iteration = block(inner);
                boolean halves = false;
                for (Tree u : loop.getUpdate()) halves |= isHalving(p, u);
                Growth factor = literalBounds(loop) ? CONSTANT : halves ? LOGARITHMIC : LINEAR;
                return larger(header, times(factor, iteration));
            }
            if (n instanceof EnhancedForLoopTree loop) {
                Growth header = cost(loop.getExpression());
                boolean walk = isElementWalk(loop.getExpression()) || constantCollection(loop.getExpression());
                List<String> added = bind(loop.getVariable());
                Growth iteration = cost(loop.getStatement());
                elements.removeAll(added);
                return larger(header, times(walk ? CONSTANT : LINEAR, iteration));
            }
            if (n instanceof WhileLoopTree loop) {
                Growth iteration = larger(cost(loop.getStatement()), cost(loop.getCondition()));
                return times(whileFactor(loop.getStatement()), iteration);
            }
            if (n instanceof DoWhileLoopTree loop) {
                Growth iteration = larger(cost(loop.getStatement()), cost(loop.getCondition()));
                return times(whileFactor(loop.getStatement()), iteration);
            }
            if (n instanceof VariableTree v && v.getInitializer() != null && isElementWalk(v.getInitializer())) {
                elements.add(v.getName().toString());
                return cost(v.getInitializer());
            }
            if (n instanceof MethodInvocationTree call) return call(call);
            return children(n);
        }

        boolean isElementWalk(ExpressionTree x) {
            x = Project.strip(x);
            if (x instanceof IdentifierTree i) return elements.contains(i.getName().toString());
            if (x instanceof MemberSelectTree s) return isElementWalk(s.getExpression());
            if (x instanceof com.sun.source.tree.ArrayAccessTree a) return isElementWalk(a.getExpression());
            if (x instanceof MethodInvocationTree call) return isElementWalk(call.getMethodSelect());
            return false;
        }

        Growth call(MethodInvocationTree call) {
            Growth parts = CONSTANT;
            if (call.getMethodSelect() instanceof MemberSelectTree s) parts = cost(s.getExpression());
            Growth lambda = CONSTANT;
            for (ExpressionTree argument : call.getArguments()) {
                if (argument instanceof LambdaExpressionTree l) {
                    List<String> bound = new ArrayList<>();
                    for (VariableTree v : l.getParameters()) bound.addAll(bind(v));
                    lambda = larger(lambda, cost(l.getBody()));
                    elements.removeAll(bound);
                } else {
                    parts = larger(parts, cost(argument));
                }
            }
            Fn target = Metrics.callee(p, call);
            if (target != null) {
                Growth callee = estimate(target);
                if (callee.degree > 0 || callee.log > 0 || callee.exponential) callee = callee.uncertain(true);
                return larger(larger(parts, lambda), callee);
            }
            String kind = library(p, call);
            if ("sort".equals(kind)) return larger(parts, new Growth(1, 1, false, false));
            if ("linear".equals(kind)) return larger(parts, times(LINEAR, lambda));
            return larger(parts, lambda);
        }

        Growth whileFactor(Tree body) {
            boolean halves = false;
            for (Tree c : Metrics.walk(body)) halves |= isHalving(p, c);
            return (halves ? LOGARITHMIC : LINEAR).uncertain(true);
        }

        Growth combine(Fn f, Growth work) {
            List<MethodInvocationTree> own = selfCalls(p, f);
            if (own.isEmpty()) return work;
            Set<String> halfNames = new HashSet<>();
            boolean memoized = false;
            for (Tree n : Metrics.body(f)) {
                if (n instanceof VariableTree v && v.getInitializer() != null && dividesByTwo(p, v.getInitializer())) halfNames.add(v.getName().toString());
                if (n instanceof AssignmentTree a && a.getVariable() instanceof IdentifierTree i && dividesByTwo(p, a.getExpression())) halfNames.add(i.getName().toString());
                if (n instanceof MethodInvocationTree call) {
                    String name = Metrics.methodName(call);
                    if (name.equals("containsKey") || name.equals("computeIfAbsent")) memoized = true;
                    if (name.equals("get") && call.getMethodSelect() instanceof MemberSelectTree s && isSubtype(p, p.typesOf.get(s.getExpression()), "java.util.Map")) memoized = true;
                }
            }
            boolean halving = false;
            boolean decrements = false;
            for (MethodInvocationTree call : own) {
                for (ExpressionTree argument : call.getArguments()) {
                    for (Tree c : Metrics.walk(argument)) {
                        if (c instanceof IdentifierTree i && halfNames.contains(i.getName().toString())) halving = true;
                        if (c.getKind() == Tree.Kind.MINUS || c.getKind() == Tree.Kind.PLUS) decrements = true;
                    }
                    halving |= dividesByTwo(p, argument);
                }
            }
            int perPath = callsOnPathBlock(f, f.tree.getBody().getStatements());
            Growth recursion;
            if (perPath <= 1 && halving) recursion = LOGARITHMIC;
            else if (perPath <= 1) recursion = LINEAR;
            else if (halving) recursion = LINEAR;
            else if (memoized || !decrements) recursion = LINEAR;
            else recursion = new Growth(0, 0, true, false);
            Growth total;
            if (perPath > 1 && halving) total = times(larger(work, LINEAR), LOGARITHMIC);
            else if (!halving && !decrements) total = larger(work, LINEAR);
            else total = times(recursion, work);
            return total.uncertain(true);
        }

        int callsOnPath(Fn f, Tree n) {
            if (n == null) return 0;
            if (n instanceof BlockTree b) return callsOnPathBlock(f, b.getStatements());
            if (n instanceof IfTree s) {
                return callsOnPath(f, s.getCondition()) + Math.max(callsOnPathBlock(f, statements(s.getThenStatement())), callsOnPathBlock(f, statements(s.getElseStatement())));
            }
            if (n instanceof ConditionalExpressionTree c) {
                return callsOnPath(f, c.getCondition()) + Math.max(callsOnPath(f, c.getTrueExpression()), callsOnPath(f, c.getFalseExpression()));
            }
            if (n instanceof SwitchTree s) {
                int most = 0;
                for (CaseTree c : s.getCases()) most = Math.max(most, caseCalls(f, c));
                return callsOnPath(f, s.getExpression()) + most;
            }
            if (n.getKind().name().equals("SWITCH_EXPRESSION")) {
                List<Tree> parts = Metrics.children(n);
                int most = 0;
                int selector = 0;
                for (Tree c : parts) {
                    if (c instanceof CaseTree ct) most = Math.max(most, caseCalls(f, ct));
                    else selector += callsOnPath(f, c);
                }
                return selector + most;
            }
            if (n instanceof LambdaExpressionTree || n instanceof ClassTree) return 0;
            int count = n instanceof MethodInvocationTree call && Metrics.callee(p, call) == f ? 1 : 0;
            for (Tree c : Metrics.children(n)) count += callsOnPath(f, c);
            return count;
        }

        int caseCalls(Fn f, CaseTree c) {
            int count = 0;
            for (Tree part : Metrics.children(c)) count += callsOnPath(f, part);
            return count;
        }

        int callsOnPathBlock(Fn f, List<? extends StatementTree> statements) {
            if (statements.isEmpty()) return 0;
            StatementTree first = statements.get(0);
            List<? extends StatementTree> rest = statements.subList(1, statements.size());
            if (first instanceof IfTree s && s.getElseStatement() == null && !canComplete(statements(s.getThenStatement()))) {
                return callsOnPath(f, s.getCondition()) + Math.max(callsOnPathBlock(f, statements(s.getThenStatement())), callsOnPathBlock(f, rest));
            }
            return callsOnPath(f, first) + callsOnPathBlock(f, rest);
        }
    }
}
