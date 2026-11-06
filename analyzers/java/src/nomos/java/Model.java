package nomos.java;

import com.sun.source.tree.ClassTree;
import com.sun.source.tree.CompilationUnitTree;
import com.sun.source.tree.MethodTree;
import com.sun.source.tree.Tree;
import com.sun.source.tree.VariableTree;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import javax.lang.model.element.ExecutableElement;
import javax.lang.model.element.TypeElement;
import javax.lang.model.element.VariableElement;

/** What the analyzer knows about the sources: files, packages, types, their members and methods. */
final class Model {
    private Model() {
    }

    record Place(String file, int startLine, int startColumn, int endLine, int endColumn) {
        Map<String, Object> json() {
            return Json.obj("file", file, "startLine", startLine, "startColumn", startColumn, "endLine", endLine, "endColumn", endColumn);
        }

        int lines() {
            return endLine - startLine + 1;
        }
    }

    static final class SourceFile {
        String path;
        String text;
        int lines;
        int loc;
        List<Lexer.Token> tokens;
        List<Lexer.Comment> comments;
        int[] lineStarts;
        Directives directives = new Directives();
        Set<Integer> importLines = new HashSet<>();
        CompilationUnitTree unit;
        boolean broken;
        Module module;

        Place place(long start, long end) {
            int s = (int) Math.max(0, start);
            int e = (int) Math.max(s, end);
            int sl = Lexer.line(lineStarts, s);
            int el = Lexer.line(lineStarts, e);
            return new Place(path, sl, s - lineStarts[sl - 1] + 1, el, e - lineStarts[el - 1] + 1);
        }

        /** Whether a comment lies between two offsets. */
        boolean hasComment(long start, long end) {
            for (Lexer.Comment c : comments) if (c.start() >= start && c.end() <= end) return true;
            return false;
        }
    }

    static final class Module {
        final String id;
        final List<SourceFile> files = new ArrayList<>();
        /** Every type of the package, nested ones included, in file and declaration order. */
        final List<TypeUnit> types = new ArrayList<>();

        Module(String id) {
            this.id = id;
        }

        int loc() {
            int total = 0;
            for (SourceFile f : files) total += f.loc;
            return total;
        }
    }

    static final class TypeUnit {
        String id;
        String name;
        Module module;
        SourceFile file;
        ClassTree tree;
        TypeElement element;
        Place place;
        String kind;
        boolean isAbstract;
        TypeUnit outer;
        final List<Member> members = new ArrayList<>();
        final List<Fn> methods = new ArrayList<>();
        final List<TypeUnit> nested = new ArrayList<>();
        final List<String> typeParameters = new ArrayList<>();
        /** Project types named in extends; the superclass alone for DIT. */
        TypeUnit superclass;
        /** A base class outside the project, written in extends. */
        boolean externalSuperclass;
        final List<TypeUnit> projectBases = new ArrayList<>();

        boolean isClassLike() {
            return kind.equals("class") || kind.equals("record");
        }
    }

    static final class Member {
        String name;
        /** field, property (record component), constant, literal (enum constant). */
        String kind;
        String visibility;
        boolean isStatic;
        boolean isFinal;
        TypeUnit owner;
        VariableTree tree;
        VariableElement element;
        Place place;
    }

    static final class Fn {
        String id;
        String name;
        /** method or constructor. */
        String kind;
        String visibility;
        TypeUnit owner;
        Module module;
        SourceFile file;
        MethodTree tree;
        ExecutableElement element;
        Place place;
        boolean isStatic;
        boolean isAbstract;

        boolean hasBody() {
            return tree.getBody() != null;
        }

        /** An instance method with a body: the methods of TCC, LCOM4 and foreignMembers. */
        boolean isInstanceMethod() {
            return owner.isClassLike() && hasBody() && kind.equals("method") && !isStatic;
        }

        Tree body() {
            return tree.getBody();
        }
    }
}
