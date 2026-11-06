package nomos.java;

import com.sun.source.tree.AssignmentTree;
import com.sun.source.tree.CompoundAssignmentTree;
import com.sun.source.tree.ConditionalExpressionTree;
import com.sun.source.tree.ExpressionTree;
import com.sun.source.tree.IdentifierTree;
import com.sun.source.tree.LambdaExpressionTree;
import com.sun.source.tree.MemberSelectTree;
import com.sun.source.tree.MethodInvocationTree;
import com.sun.source.tree.NewClassTree;
import com.sun.source.tree.Tree;
import com.sun.source.tree.UnaryTree;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import javax.lang.model.element.Element;
import javax.lang.model.element.ElementKind;
import javax.lang.model.element.ExecutableElement;
import javax.lang.model.element.Modifier;
import javax.lang.model.element.TypeElement;
import javax.lang.model.type.TypeKind;
import nomos.java.Model.Fn;
import nomos.java.Model.Member;
import nomos.java.Model.Module;
import nomos.java.Model.TypeUnit;

/** Paradigm evidence of spec/paradigms.md and the conservative definition of a pure function. */
final class Paradigms {
    static final Set<String> ACTIVATING = Set.of("oop.classes", "str.free-functions", "str.control-flow", "fp.higher-order", "fp.pure-functions");

    private Paradigms() {
    }

    static List<String> active(List<Map<String, Object>> evidence) {
        Set<String> result = new TreeSet<>();
        for (Map<String, Object> e : evidence) if (ACTIVATING.contains((String) e.get("kind"))) result.add((String) e.get("paradigm"));
        return new ArrayList<>(result);
    }

    private static void add(List<Map<String, Object>> result, String paradigm, String kind, String description, List<String> ids, Integer count) {
        int n = count != null ? count : ids.size();
        if (n == 0) return;
        List<String> examples = new ArrayList<>(new TreeSet<>(ids));
        if (examples.size() > 5) examples = examples.subList(0, 5);
        result.add(Json.obj("paradigm", paradigm, "kind", kind, "count", n, "description", description, "examples", examples));
    }

    static boolean hasMutableInstanceState(TypeUnit t) {
        for (Member m : t.members) if (m.kind.equals("field") && !m.isStatic && !m.isFinal) return true;
        return false;
    }

    static boolean isImmutable(TypeUnit t) {
        int state = 0;
        for (Member m : t.members) if ((m.kind.equals("field") || m.kind.equals("property")) && !m.isStatic) state++;
        return state > 0 && !hasMutableInstanceState(t);
    }

    static boolean hasControlFlow(Fn f) {
        for (Tree n : Metrics.body(f)) {
            if (n.getKind() == Tree.Kind.IF || Metrics.isLoop(n) || n.getKind() == Tree.Kind.SWITCH || n instanceof ConditionalExpressionTree
                || n.getKind().name().equals("SWITCH_EXPRESSION")) return true;
        }
        return false;
    }

    static List<Map<String, Object>> evidence(Project p, Module m, Set<Fn> pure) {
        List<Map<String, Object>> result = new ArrayList<>();
        List<String> classes = new ArrayList<>();
        List<String> mutable = new ArrayList<>();
        List<String> inheriting = new ArrayList<>();
        List<String> abstractions = new ArrayList<>();
        List<String> immutable = new ArrayList<>();
        List<String> shared = new ArrayList<>();
        for (TypeUnit t : m.types) {
            if (t.isClassLike()) {
                if (!t.members.isEmpty() || !t.methods.isEmpty()) classes.add(t.id);
                if (hasMutableInstanceState(t)) mutable.add(t.id);
                if (isImmutable(t)) immutable.add(t.id);
                if (t.superclass != null) inheriting.add(t.id);
            }
            if (t.isAbstract) abstractions.add(t.id);
            for (Member x : t.members) if (x.kind.equals("field") && x.isStatic && !x.isFinal) shared.add(t.id + "." + x.name);
        }
        add(result, "oop", "oop.classes", "classes with methods or fields", classes, null);
        add(result, "oop", "oop.mutable-state-classes", "classes with mutable instance state", mutable, null);
        add(result, "oop", "oop.inheritance", "project types inheriting project types", inheriting, null);
        add(result, "oop", "oop.abstractions", "interfaces and abstract classes", abstractions, null);

        List<String> flow = new ArrayList<>();
        List<String> higher = new ArrayList<>();
        List<String> pureIds = new ArrayList<>();
        List<String> lambdaOwners = new ArrayList<>();
        for (Fn f : p.moduleFunctions(m)) {
            if (f.hasBody() && hasControlFlow(f)) flow.add(f.id);
            if (Metrics.hofOrder(p, f) > 1) higher.add(f.id);
            if (pure.contains(f)) pureIds.add(f.id);
            for (Tree n : Metrics.body(f)) {
                if (n instanceof MethodInvocationTree call) for (ExpressionTree a : call.getArguments()) if (a instanceof LambdaExpressionTree) lambdaOwners.add(f.id);
                if (n instanceof NewClassTree creation) for (ExpressionTree a : creation.getArguments()) if (a instanceof LambdaExpressionTree) lambdaOwners.add(f.id);
            }
        }
        add(result, "structural", "str.control-flow", "functions with branches or loops", flow, null);
        add(result, "structural", "str.global-state", "static mutable fields", shared, null);
        add(result, "functional", "fp.lambdas", "lambdas passed as arguments", lambdaOwners, lambdaOwners.size());
        add(result, "functional", "fp.higher-order", "functions taking or returning functions", higher, null);
        add(result, "functional", "fp.pure-functions", "functions that provably have no effects (conservative)", pureIds, null);
        add(result, "functional", "fp.immutable-types", "types without mutable state", immutable, null);
        result.sort((a, b) -> ((String) a.get("kind")).compareTo((String) b.get("kind")));
        return result;
    }

    // Pure functions ----------------------------------------------------------------------------------------------------

    /** The conservative definition of spec/paradigms.md as a greatest fixed point. */
    static Set<Fn> pure(Project p) {
        Map<Fn, List<Fn>> candidates = new HashMap<>();
        for (Fn f : p.allFunctions()) {
            if (!f.hasBody() || !f.kind.equals("method")) continue;
            List<Fn> callees = new ArrayList<>();
            if (locallyPure(p, f, callees)) candidates.put(f, callees);
        }
        boolean changed = true;
        while (changed) {
            changed = false;
            for (Fn f : new ArrayList<>(candidates.keySet())) {
                if (candidates.get(f).stream().allMatch(candidates::containsKey)) continue;
                candidates.remove(f);
                changed = true;
            }
        }
        return candidates.keySet();
    }

    private static boolean isOwnVariable(Project p, ExpressionTree target) {
        target = Project.strip(target);
        if (!(target instanceof IdentifierTree)) return false;
        Element e = p.elements.get(target);
        return e != null && (e.getKind() == ElementKind.LOCAL_VARIABLE || e.getKind() == ElementKind.PARAMETER || e.getKind().name().equals("BINDING_VARIABLE")
            || e.getKind() == ElementKind.RESOURCE_VARIABLE || e.getKind() == ElementKind.EXCEPTION_PARAMETER);
    }

    private static boolean isMath(TypeElement owner) {
        String name = owner.getQualifiedName().toString();
        return name.equals("java.lang.Math") || name.equals("java.lang.StrictMath");
    }

    /** A constant, a final field or an enum constant of the project, or a static member of Math. */
    private static boolean isReadOnly(Project p, Element e) {
        Member m = p.memberOf.get(e);
        if (m != null) return m.isFinal || m.kind.equals("constant") || m.kind.equals("literal") || m.kind.equals("property");
        TypeElement owner = Graph.enclosingType(e);
        if (owner == null || p.typeOf.containsKey(owner)) return false;
        return e.getModifiers().contains(Modifier.STATIC) && isMath(owner);
    }

    private static boolean isField(Element e) {
        return e != null && (e.getKind() == ElementKind.FIELD || e.getKind() == ElementKind.ENUM_CONSTANT);
    }

    private static boolean locallyPure(Project p, Fn f, List<Fn> callees) {
        for (Tree n : Metrics.body(f)) {
            switch (n.getKind()) {
                case SYNCHRONIZED, CLASS, ERRONEOUS:
                    return false;
                default:
                    break;
            }
            if (n instanceof AssignmentTree a && !isOwnVariable(p, a.getVariable())) return false;
            if (n instanceof CompoundAssignmentTree a && !isOwnVariable(p, a.getVariable())) return false;
            if (n instanceof UnaryTree u && isMutation(u) && !isOwnVariable(p, u.getExpression())) return false;
            if (n instanceof IdentifierTree i && !i.getName().contentEquals("this") && !i.getName().contentEquals("super")) {
                Element e = p.elements.get(i);
                if (e == null && !i.getName().contentEquals("length")) return false;
                if (isField(e) && !isReadOnly(p, e)) return false;
            }
            if (n instanceof MemberSelectTree s) {
                Element e = p.elements.get(s);
                if (isField(e) && !mayRead(p, s, e)) return false;
            }
            if (n instanceof MethodInvocationTree call && !callAllowed(p, call, callees)) return false;
            if (n instanceof NewClassTree creation && !creationAllowed(p, creation)) return false;
        }
        return true;
    }

    private static boolean isMutation(UnaryTree u) {
        return switch (u.getKind()) {
            case PREFIX_INCREMENT, PREFIX_DECREMENT, POSTFIX_INCREMENT, POSTFIX_DECREMENT -> true;
            default -> false;
        };
    }

    /** Reading a member of an argument or a local is fine; anything else must be a constant or read-only member. */
    private static boolean mayRead(Project p, MemberSelectTree access, Element e) {
        if (isReadOnly(p, e)) return true;
        if (e.getModifiers().contains(Modifier.STATIC)) return false;
        ExpressionTree root = access.getExpression();
        while (Project.strip(root) instanceof MemberSelectTree inner) root = inner.getExpression();
        return isOwnVariable(p, root);
    }

    private static boolean callAllowed(Project p, MethodInvocationTree call, List<Fn> callees) {
        Element e = p.elements.get(call);
        if (!(e instanceof ExecutableElement method) || method.asType().getKind() == TypeKind.ERROR) return false;
        Fn target = p.fnOf.get(method);
        if (target != null) {
            callees.add(target);
            return true;
        }
        TypeElement owner = Graph.enclosingType(method);
        if (owner == null || p.typeOf.containsKey(owner) || owner.asType().getKind() == TypeKind.ERROR) return false;
        return isMath(owner) || owner.getQualifiedName().contentEquals("java.lang.String");
    }

    private static boolean creationAllowed(Project p, NewClassTree creation) {
        if (creation.getClassBody() != null) return false;
        Element e = p.elements.get(creation);
        TypeElement owner = e != null ? Graph.enclosingType(e) : null;
        if (owner == null) return false;
        if (owner.getQualifiedName().contentEquals("java.lang.String")) return true;
        TypeUnit t = p.typeOf.get(owner);
        if (t == null) return false;
        for (Fn m : t.methods) if (m.kind.equals("constructor")) return false;
        return true;
    }
}
