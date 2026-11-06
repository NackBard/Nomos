package nomos.java;

import com.sun.source.tree.MethodTree;
import com.sun.source.tree.Tree;
import com.sun.source.tree.VariableTree;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import javax.lang.model.element.TypeElement;
import javax.lang.model.type.ArrayType;
import javax.lang.model.type.DeclaredType;
import javax.lang.model.type.TypeKind;
import javax.lang.model.type.TypeMirror;
import nomos.java.Model.Fn;
import nomos.java.Model.Member;
import nomos.java.Model.SourceFile;
import nomos.java.Model.TypeUnit;

/** Structure of types and functions for facts 1.3.0, as spec/structure.md defines it for Java. */
final class Structure {
    private Structure() {
    }

    /** A type as written, line breaks and runs of spaces collapsed. */
    static String typeText(Project p, SourceFile f, Tree type, long until) {
        if (type == null) return null;
        long start = p.start(f, type);
        long end = until > start ? until : p.end(f, type);
        if (start < 0 || end <= start || end > f.text.length()) return null;
        String text = f.text.substring((int) start, (int) end).replaceAll("\\s+", " ").strip();
        return text.isEmpty() ? null : text;
    }

    /** The start of the name of a variable: the type of a parameter ends before it, which keeps a vararg's "...". */
    static long nameStart(Project p, SourceFile f, VariableTree v) {
        long typeEnd = p.end(f, v.getType());
        String name = v.getName().toString();
        int at = f.text.indexOf(name, (int) Math.max(0, typeEnd));
        long end = p.end(f, v);
        return at >= 0 && at < end ? at : typeEnd;
    }

    static String variableType(Project p, SourceFile f, VariableTree v) {
        if (v.getType() == null || p.start(f, v.getType()) < 0) return null;
        return typeText(p, f, v.getType(), nameStart(p, f, v));
    }

    /** The project type a member is about and whether it holds a collection of it. */
    static Object[] target(Project p, TypeMirror type) {
        if (type == null) return new Object[] {null, false};
        if (type instanceof ArrayType a) {
            TypeUnit element = p.unitOfMirror(a.getComponentType());
            return new Object[] {element != null ? element.id : null, true};
        }
        if (type.getKind() != TypeKind.DECLARED) return new Object[] {null, false};
        DeclaredType declared = (DeclaredType) type;
        TypeElement e = (TypeElement) declared.asElement();
        String name = e.getQualifiedName().toString();
        List<? extends TypeMirror> arguments = declared.getTypeArguments();
        if (name.equals("java.util.Optional") && !arguments.isEmpty()) return target(p, arguments.get(0));
        boolean collection = !arguments.isEmpty() && (Estimate.isSubtype(p, type, "java.util.Collection") || Estimate.isSubtype(p, type, "java.util.Map")
            || name.equals("java.lang.Iterable") || Estimate.isSubtype(p, type, "java.util.stream.BaseStream"));
        if (collection) {
            TypeMirror last = arguments.get(arguments.size() - 1);
            if (last.getKind() == TypeKind.WILDCARD) last = ((javax.lang.model.type.WildcardType) last).getExtendsBound();
            TypeUnit element = p.unitOfMirror(last);
            return new Object[] {element != null ? element.id : null, true};
        }
        TypeUnit own = p.unitOfMirror(type);
        return new Object[] {own != null ? own.id : null, false};
    }

    static List<Map<String, Object>> members(Project p, TypeUnit t) {
        List<Map<String, Object>> result = new ArrayList<>();
        for (Member m : t.members) {
            Map<String, Object> entry = Json.obj("name", m.name, "kind", m.kind, "visibility", m.visibility);
            if (!m.kind.equals("literal")) {
                String name = variableType(p, t.file, m.tree);
                if (name != null) entry.put("typeName", name);
                Object[] target = target(p, m.element != null ? m.element.asType() : p.typesOf.get(m.tree));
                if (target[0] != null) entry.put("type", target[0]);
                if (m.isStatic) entry.put("isStatic", true);
                if ((Boolean) target[1]) entry.put("isCollection", true);
            }
            result.add(entry);
        }
        return result;
    }

    static List<Map<String, Object>> parameters(Project p, Fn f) {
        List<Map<String, Object>> result = new ArrayList<>();
        for (VariableTree v : f.tree.getParameters()) {
            Map<String, Object> entry = Json.obj("name", v.getName().toString());
            String text = variableType(p, f.file, v);
            if (text != null) entry.put("typeName", text);
            result.add(entry);
        }
        return result;
    }

    static String returnTypeName(Project p, Fn f) {
        MethodTree m = f.tree;
        if (f.kind.equals("constructor") || m.getReturnType() == null) return null;
        String text = typeText(p, f.file, m.getReturnType(), -1);
        return text == null || text.equals("void") ? null : text;
    }
}
