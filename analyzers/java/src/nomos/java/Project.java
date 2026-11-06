package nomos.java;

import com.sun.source.tree.AnnotationTree;
import com.sun.source.tree.ClassTree;
import com.sun.source.tree.CompilationUnitTree;
import com.sun.source.tree.ExpressionTree;
import com.sun.source.tree.ImportTree;
import com.sun.source.tree.MethodTree;
import com.sun.source.tree.ModifiersTree;
import com.sun.source.tree.Tree;
import com.sun.source.tree.TypeParameterTree;
import com.sun.source.tree.VariableTree;
import com.sun.source.util.JavacTask;
import com.sun.source.util.SourcePositions;
import com.sun.source.util.TreePath;
import com.sun.source.util.TreePathScanner;
import com.sun.source.util.Trees;
import java.io.IOException;
import java.net.URI;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import javax.lang.model.element.Element;
import javax.lang.model.element.ElementKind;
import javax.lang.model.element.ExecutableElement;
import javax.lang.model.element.Modifier;
import javax.lang.model.element.TypeElement;
import javax.lang.model.element.VariableElement;
import javax.lang.model.type.TypeKind;
import javax.lang.model.type.TypeMirror;
import javax.lang.model.util.Elements;
import javax.lang.model.util.Types;
import javax.tools.Diagnostic;
import javax.tools.DiagnosticListener;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.SimpleJavaFileObject;
import javax.tools.StandardJavaFileManager;
import javax.tools.ToolProvider;
import nomos.java.Model.Fn;
import nomos.java.Model.Member;
import nomos.java.Model.Module;
import nomos.java.Model.Place;
import nomos.java.Model.SourceFile;
import nomos.java.Model.TypeUnit;

/**
 * Everything loaded from a root: one javac compilation over all sources, without a class path (D-058, as D-003 for C#).
 * Types of the JDK resolve; types of libraries stay unresolved (TypeKind.ERROR) and are known by their names.
 */
final class Project {
    static final String GLOBAL = "(global)";
    /** Build output, dependencies and tool folders; hidden folders are skipped as well. */
    static final Set<String> SKIPPED_FOLDERS = Set.of("node_modules", "target", "build", "out", "bin");

    final Path root;
    final List<SourceFile> files = new ArrayList<>();
    final List<Module> modules = new ArrayList<>();
    final Map<String, Module> byId = new HashMap<>();
    final Map<String, TypeUnit> types = new TreeMap<>();
    final Map<String, Fn> functions = new TreeMap<>();
    final List<Map<String, Object>> notes = new ArrayList<>();
    private final Set<String> ids = new HashSet<>();

    final Map<Element, TypeUnit> typeOf = new HashMap<>();
    final Map<Element, Fn> fnOf = new HashMap<>();
    final Map<Element, Member> memberOf = new HashMap<>();
    final Map<Tree, TypeUnit> typeOfTree = new IdentityHashMap<>();
    final Map<Tree, Fn> fnOfTree = new IdentityHashMap<>();
    final Map<Tree, Member> memberOfTree = new IdentityHashMap<>();
    /** Element each name, selection, call, creation and declaration refers to. */
    final Map<Tree, Element> elements = new IdentityHashMap<>();
    /** Attributed type of each expression and type tree. */
    final Map<Tree, TypeMirror> typesOf = new IdentityHashMap<>();
    final Map<Tree, Tree> parents = new IdentityHashMap<>();
    final Map<Tree, SourceFile> fileOf = new IdentityHashMap<>();
    int unresolved;

    JavacTask task;
    Trees trees;
    Elements elementUtils;
    Types typeUtils;
    SourcePositions positions;

    Project(Path root) {
        this.root = root.toAbsolutePath().normalize();
    }

    String relative(Path full) {
        return root.relativize(full.toAbsolutePath().normalize()).toString().replace('\\', '/');
    }

    // Loading ---------------------------------------------------------------------------------------------------------

    static Pattern glob(String pattern) {
        String expression = Pattern.quote(pattern);
        // Pattern.quote wraps in \Q…\E; reopen the quote around each wildcard.
        expression = expression.replace("**/", "\\E\u0000\\Q").replace("**", "\\E\u0001\\Q").replace("*", "\\E[^/]*\\Q");
        expression = expression.replace("\u0000", "(.*/)?").replace("\u0001", ".*");
        return Pattern.compile("^" + expression + "$");
    }

    static boolean anyGlob(List<String> patterns, String value) {
        for (String p : patterns) if (glob(p).matcher(value).matches()) return true;
        return false;
    }

    void load(List<String> include, List<String> exclude) throws IOException {
        List<Path> found = new ArrayList<>();
        walk(root, include, exclude, found);
        found.sort((a, b) -> relative(a).compareTo(relative(b)));
        for (Path full : found) addFile(full);
        compile();
    }

    private void walk(Path folder, List<String> include, List<String> exclude, List<Path> found) throws IOException {
        List<Path> entries;
        try (Stream<Path> list = Files.list(folder)) {
            entries = new ArrayList<>(list.toList());
        } catch (IOException e) {
            return;
        }
        entries.sort((a, b) -> a.getFileName().toString().compareTo(b.getFileName().toString()));
        for (Path full : entries) {
            String name = full.getFileName().toString();
            if (Files.isDirectory(full)) {
                if (SKIPPED_FOLDERS.contains(name) || name.startsWith(".")) continue;
                walk(full, include, exclude, found);
            } else if (name.endsWith(".java") && !name.equals("module-info.java") && Files.isRegularFile(full)) {
                String rel = relative(full);
                if ((include.isEmpty() || anyGlob(include, rel)) && !anyGlob(exclude, rel)) found.add(full);
            }
        }
    }

    static String readSource(Path path) throws IOException {
        byte[] data = Files.readAllBytes(path);
        String text;
        try {
            text = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).decode(java.nio.ByteBuffer.wrap(data)).toString();
        } catch (CharacterCodingException e) {
            text = new String(data, StandardCharsets.ISO_8859_1);
        }
        if (text.startsWith("\uFEFF")) text = text.substring(1);
        return text.replace("\r\n", "\n").replace('\r', '\n');
    }

    private void addFile(Path full) throws IOException {
        SourceFile f = new SourceFile();
        f.path = relative(full);
        f.text = readSource(full);
        f.lines = (int) f.text.chars().filter(c -> c == '\n').count() + (!f.text.isEmpty() && !f.text.endsWith("\n") ? 1 : 0);
        Lexer.Result scanned = Lexer.scan(f.text);
        f.tokens = scanned.tokens();
        f.comments = scanned.comments();
        f.loc = scanned.loc();
        f.lineStarts = Lexer.lineStarts(f.text);
        for (Lexer.Comment c : f.comments) f.directives.add(c.text(), c.startLine(), c.endLine());
        files.add(f);
    }

    /** A source given to javac as the text the analyzer read, so that offsets agree with the tokens. */
    private static final class Source extends SimpleJavaFileObject {
        final SourceFile file;

        Source(SourceFile file, URI uri) {
            super(uri, Kind.SOURCE);
            this.file = file;
        }

        @Override
        public CharSequence getCharContent(boolean ignoreEncodingErrors) {
            return file.text;
        }
    }

    private void compile() {
        if (files.isEmpty()) return;
        JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
        if (compiler == null) throw new IllegalStateException("the Java runtime has no compiler (module jdk.compiler); Nomos needs a JDK 17 or newer");
        Map<URI, SourceFile> byObject = new HashMap<>();
        List<JavaFileObject> objects = new ArrayList<>();
        for (int i = 0; i < files.size(); i++) {
            SourceFile f = files.get(i);
            // The URI only names the file for javac; it never reaches the facts.
            Source source = new Source(f, URI.create("string:///nomos/" + i + "/" + f.path.replaceAll("[^A-Za-z0-9_./-]", "_")));
            byObject.put(source.toUri(), f);
            objects.add(source);
        }
        boolean[] parsing = {true};
        DiagnosticListener<JavaFileObject> listener = d -> {
            if (d.getKind() != Diagnostic.Kind.ERROR || d.getSource() == null) return;
            SourceFile f = byObject.get(d.getSource().toUri());
            if (f == null) return;
            if (parsing[0]) f.broken = true;
            else unresolved++;
        };
        StandardJavaFileManager manager = compiler.getStandardFileManager(listener, null, StandardCharsets.UTF_8);
        List<String> options = List.of("-proc:none", "-implicit:none", "-nowarn", "-Xlint:none", "-XDshould-stop.ifError=FLOW", "-XDshould-stop.ifNoError=FLOW",
            "-Xmaxerrs", "100000");
        task = (JavacTask) compiler.getTask(null, manager, listener, options, null, objects);
        trees = Trees.instance(task);
        elementUtils = task.getElements();
        typeUtils = task.getTypes();
        positions = trees.getSourcePositions();
        List<CompilationUnitTree> units = new ArrayList<>();
        try {
            for (CompilationUnitTree u : task.parse()) units.add(u);
            parsing[0] = false;
            task.analyze();
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
        for (CompilationUnitTree u : units) {
            SourceFile f = byObject.get(u.getSourceFile().toUri());
            if (f == null) continue;
            f.unit = u;
        }
        for (SourceFile f : files) {
            String pkg = f.unit != null && f.unit.getPackageName() != null ? f.unit.getPackageName().toString() : "";
            String id = pkg.isEmpty() ? GLOBAL : pkg;
            Module m = byId.computeIfAbsent(id, k -> {
                Module created = new Module(k);
                modules.add(created);
                return created;
            });
            m.files.add(f);
            f.module = m;
            if (f.unit != null) index(f);
        }
        modules.sort((a, b) -> a.id.compareTo(b.id));
        for (SourceFile f : files) if (f.unit != null) declare(f);
        for (TypeUnit t : types.values()) link(t);
    }

    // Index -------------------------------------------------------------------------------------------------------------

    private void index(SourceFile f) {
        CompilationUnitTree unit = f.unit;
        for (ImportTree imp : unit.getImports()) {
            Place p = place(f, imp);
            for (int l = p.startLine(); l <= p.endLine(); l++) f.importLines.add(l);
        }
        if (unit.getPackage() != null) {
            Place p = place(f, unit.getPackage());
            for (int l = p.startLine(); l <= p.endLine(); l++) f.importLines.add(l);
        }
        new TreePathScanner<Void, Void>() {
            @Override
            public Void scan(Tree tree, Void unused) {
                if (tree == null) return null;
                TreePath parent = getCurrentPath();
                if (parent != null) parents.put(tree, parent.getLeaf());
                fileOf.put(tree, f);
                return super.scan(tree, unused);
            }

            @Override
            public Void scan(TreePath path, Void unused) {
                return super.scan(path, unused);
            }

            private void record() {
                TreePath path = getCurrentPath();
                Tree leaf = path.getLeaf();
                try {
                    Element e = trees.getElement(path);
                    if (e != null) elements.put(leaf, e);
                    TypeMirror type = trees.getTypeMirror(path);
                    if (type != null) typesOf.put(leaf, type);
                } catch (RuntimeException ignored) {
                    // javac could not attribute this tree; it stays unresolved.
                }
            }

            @Override
            public Void visitIdentifier(com.sun.source.tree.IdentifierTree node, Void unused) {
                record();
                return super.visitIdentifier(node, unused);
            }

            @Override
            public Void visitMemberSelect(com.sun.source.tree.MemberSelectTree node, Void unused) {
                record();
                return super.visitMemberSelect(node, unused);
            }

            @Override
            public Void visitMethodInvocation(com.sun.source.tree.MethodInvocationTree node, Void unused) {
                record();
                return super.visitMethodInvocation(node, unused);
            }

            @Override
            public Void visitNewClass(com.sun.source.tree.NewClassTree node, Void unused) {
                record();
                return super.visitNewClass(node, unused);
            }

            @Override
            public Void visitNewArray(com.sun.source.tree.NewArrayTree node, Void unused) {
                record();
                return super.visitNewArray(node, unused);
            }

            @Override
            public Void visitMemberReference(com.sun.source.tree.MemberReferenceTree node, Void unused) {
                record();
                return super.visitMemberReference(node, unused);
            }

            @Override
            public Void visitVariable(VariableTree node, Void unused) {
                record();
                return super.visitVariable(node, unused);
            }

            @Override
            public Void visitMethod(MethodTree node, Void unused) {
                record();
                return super.visitMethod(node, unused);
            }

            @Override
            public Void visitClass(ClassTree node, Void unused) {
                record();
                return super.visitClass(node, unused);
            }

            @Override
            public Void visitParameterizedType(com.sun.source.tree.ParameterizedTypeTree node, Void unused) {
                record();
                return super.visitParameterizedType(node, unused);
            }

            @Override
            public Void visitArrayType(com.sun.source.tree.ArrayTypeTree node, Void unused) {
                record();
                return super.visitArrayType(node, unused);
            }

            @Override
            public Void visitLiteral(com.sun.source.tree.LiteralTree node, Void unused) {
                record();
                return super.visitLiteral(node, unused);
            }

            @Override
            public Void visitBinary(com.sun.source.tree.BinaryTree node, Void unused) {
                record();
                return super.visitBinary(node, unused);
            }

            @Override
            public Void visitCompoundAssignment(com.sun.source.tree.CompoundAssignmentTree node, Void unused) {
                record();
                return super.visitCompoundAssignment(node, unused);
            }

            @Override
            public Void visitParenthesized(com.sun.source.tree.ParenthesizedTree node, Void unused) {
                record();
                return super.visitParenthesized(node, unused);
            }

            @Override
            public Void visitConditionalExpression(com.sun.source.tree.ConditionalExpressionTree node, Void unused) {
                record();
                return super.visitConditionalExpression(node, unused);
            }

            @Override
            public Void visitArrayAccess(com.sun.source.tree.ArrayAccessTree node, Void unused) {
                record();
                return super.visitArrayAccess(node, unused);
            }

            @Override
            public Void visitTypeCast(com.sun.source.tree.TypeCastTree node, Void unused) {
                record();
                return super.visitTypeCast(node, unused);
            }
        }.scan(new TreePath(unit), null);
    }

    // Places ------------------------------------------------------------------------------------------------------------

    long start(SourceFile f, Tree t) {
        return positions.getStartPosition(f.unit, t);
    }

    long end(SourceFile f, Tree t) {
        return positions.getEndPosition(f.unit, t);
    }

    Place place(SourceFile f, Tree t) {
        return f.place(start(f, t), end(f, t));
    }

    Place place(Tree t) {
        SourceFile f = fileOf.get(t);
        return place(f, t);
    }

    /** The span of a declaration from its first token after annotations to its end (spec/metrics.md, lines). */
    Place declarationPlace(SourceFile f, Tree t, ModifiersTree modifiers) {
        long start = start(f, t);
        long end = end(f, t);
        if (modifiers != null && !modifiers.getAnnotations().isEmpty()) {
            List<long[]> spans = new ArrayList<>();
            for (AnnotationTree a : modifiers.getAnnotations()) spans.add(new long[] {start(f, a), end(f, a)});
            for (Lexer.Token token : f.tokens) {
                if (token.start() < start) continue;
                if (token.start() >= end) break;
                boolean inside = false;
                for (long[] s : spans) if (token.start() >= s[0] && token.start() < s[1]) inside = true;
                if (!inside) {
                    start = token.start();
                    break;
                }
            }
        }
        return f.place(start, end);
    }

    // Declarations ------------------------------------------------------------------------------------------------------

    String uniqueId(String base) {
        String candidate = base;
        int n = 2;
        while (ids.contains(candidate)) candidate = base + "#" + n++;
        ids.add(candidate);
        return candidate;
    }

    private void declare(SourceFile f) {
        for (Tree t : f.unit.getTypeDecls()) {
            if (t instanceof ClassTree c) declareType(f, c, null);
        }
    }

    static String visibility(Set<Modifier> modifiers) {
        if (modifiers.contains(Modifier.PUBLIC)) return "public";
        if (modifiers.contains(Modifier.PROTECTED)) return "protected";
        if (modifiers.contains(Modifier.PRIVATE)) return "private";
        return "internal";
    }

    private void declareType(SourceFile f, ClassTree tree, TypeUnit outer) {
        TypeUnit t = new TypeUnit();
        t.tree = tree;
        t.file = f;
        t.module = f.module;
        t.outer = outer;
        t.name = tree.getSimpleName().toString();
        Element e = elements.get(tree);
        t.element = e instanceof TypeElement te && !typeOf.containsKey(te) ? te : null;
        String base = outer != null ? outer.id + "." + t.name : f.module.id.equals(GLOBAL) ? t.name : f.module.id + "." + t.name;
        t.id = uniqueId(base);
        t.kind = switch (tree.getKind()) {
            case INTERFACE -> "interface";
            case ENUM -> "enum";
            case ANNOTATION_TYPE -> "annotation";
            default -> tree.getKind().name().equals("RECORD") ? "record" : "class";
        };
        Set<Modifier> modifiers = tree.getModifiers().getFlags();
        t.isAbstract = t.kind.equals("interface") || t.kind.equals("annotation") || modifiers.contains(Modifier.ABSTRACT);
        t.place = declarationPlace(f, tree, tree.getModifiers());
        for (TypeParameterTree p : tree.getTypeParameters()) t.typeParameters.add(p.getName().toString());
        if (t.element != null) typeOf.put(t.element, t);
        typeOfTree.put(tree, t);
        types.put(t.id, t);
        f.module.types.add(t);
        if (outer != null) outer.nested.add(t);

        List<MethodTree> methods = new ArrayList<>();
        for (Tree member : tree.getMembers()) {
            if (member instanceof VariableTree v) declareMember(f, t, v);
            else if (member instanceof MethodTree m && isExplicit(m)) methods.add(m);
        }
        Map<String, Integer> counts = new HashMap<>();
        for (MethodTree m : methods) counts.merge(functionName(t, m), 1, Integer::sum);
        for (MethodTree m : methods) declareFunction(f, t, m, counts.get(functionName(t, m)) > 1);
        for (Tree member : tree.getMembers()) {
            if (member instanceof ClassTree c) declareType(f, c, t);
        }
    }

    /** Declarations javac adds (default and canonical record constructors) are not in the source. */
    private boolean isExplicit(MethodTree m) {
        Element e = elements.get(m);
        if (e != null && elementUtils.getOrigin(e) != Elements.Origin.EXPLICIT) return false;
        return positions.getStartPosition(fileOfTree(m).unit, m) >= 0 && positions.getEndPosition(fileOfTree(m).unit, m) > positions.getStartPosition(fileOfTree(m).unit, m);
    }

    private SourceFile fileOfTree(Tree t) {
        return fileOf.get(t);
    }

    private static String functionName(TypeUnit t, MethodTree m) {
        return m.getName().contentEquals("<init>") ? t.name : m.getName().toString();
    }

    private void declareMember(SourceFile f, TypeUnit t, VariableTree v) {
        Member m = new Member();
        m.name = v.getName().toString();
        m.owner = t;
        m.tree = v;
        Element e = elements.get(v);
        m.element = e instanceof VariableElement ve ? ve : null;
        Set<Modifier> modifiers = m.element != null ? m.element.getModifiers() : v.getModifiers().getFlags();
        boolean inInterface = t.kind.equals("interface") || t.kind.equals("annotation");
        m.isStatic = modifiers.contains(Modifier.STATIC) || inInterface;
        m.isFinal = modifiers.contains(Modifier.FINAL) || inInterface;
        m.visibility = inInterface ? "public" : visibility(modifiers);
        if (m.element != null && m.element.getKind() == ElementKind.ENUM_CONSTANT) {
            m.kind = "literal";
            m.isStatic = false;
            m.visibility = "public";
        } else if (t.kind.equals("record") && !m.isStatic && m.element != null && isRecordComponent(t, m.name)) {
            m.kind = "property";
            m.visibility = "public";
        } else if (m.isStatic && m.isFinal && m.element != null && m.element.getConstantValue() != null) {
            m.kind = "constant";
            m.isStatic = false;
        } else {
            m.kind = "field";
        }
        m.place = declarationPlace(f, v, v.getModifiers());
        t.members.add(m);
        if (m.element != null) memberOf.put(m.element, m);
        memberOfTree.put(v, m);
    }

    private boolean isRecordComponent(TypeUnit t, String name) {
        if (t.element == null) return true;
        for (Element c : t.element.getRecordComponents()) if (c.getSimpleName().contentEquals(name)) return true;
        return false;
    }

    private void declareFunction(SourceFile f, TypeUnit t, MethodTree tree, boolean overloaded) {
        Fn fn = new Fn();
        fn.owner = t;
        fn.module = t.module;
        fn.file = f;
        fn.tree = tree;
        Element e = elements.get(tree);
        fn.element = e instanceof ExecutableElement ee && !fnOf.containsKey(ee) ? ee : null;
        boolean constructor = tree.getName().contentEquals("<init>");
        fn.kind = constructor ? "constructor" : "method";
        fn.name = functionName(t, tree);
        Set<Modifier> modifiers = fn.element != null ? fn.element.getModifiers() : tree.getModifiers().getFlags();
        boolean inInterface = t.kind.equals("interface") || t.kind.equals("annotation");
        fn.visibility = inInterface && !modifiers.contains(Modifier.PRIVATE) ? "public" : visibility(modifiers);
        fn.isStatic = modifiers.contains(Modifier.STATIC);
        fn.isAbstract = tree.getBody() == null && !modifiers.contains(Modifier.NATIVE);
        String base = t.id + "." + fn.name;
        if (overloaded) {
            List<String> parameters = new ArrayList<>();
            for (VariableTree p : tree.getParameters()) {
                TypeMirror type = typesOf.get(p);
                parameters.add(type != null ? type.toString() : p.getType().toString());
            }
            base += "(" + String.join(",", parameters) + ")";
        }
        fn.id = uniqueId(base);
        fn.place = declarationPlace(f, tree, tree.getModifiers());
        t.methods.add(fn);
        functions.put(fn.id, fn);
        if (fn.element != null) fnOf.put(fn.element, fn);
        fnOfTree.put(tree, fn);
    }

    /** Project bases of a type: the superclass of extends and the interfaces of implements and extends. */
    private void link(TypeUnit t) {
        Tree extending = t.tree.getExtendsClause();
        if (extending != null && !t.kind.equals("interface")) {
            TypeUnit base = unitOfType(extending);
            if (base != null) t.superclass = base;
            else t.externalSuperclass = !isObject(extending);
        }
        List<Tree> named = new ArrayList<>();
        if (extending != null) named.add(extending);
        named.addAll(t.tree.getImplementsClause());
        for (Tree n : named) {
            TypeUnit base = unitOfType(n);
            if (base != null && base != t && !t.projectBases.contains(base)) t.projectBases.add(base);
        }
    }

    private boolean isObject(Tree type) {
        TypeMirror m = typesOf.get(type);
        if (m == null) m = typeOfTypeTree(type);
        return m != null && m.toString().equals("java.lang.Object");
    }

    /** The attributed type of a type tree, looked up through its name. */
    TypeMirror typeOfTypeTree(Tree type) {
        TypeMirror m = typesOf.get(type);
        if (m != null) return m;
        Element e = elements.get(type);
        return e != null ? e.asType() : null;
    }

    /** The project type a type tree names (List<Order> names List), or null. */
    TypeUnit unitOfType(Tree type) {
        Tree t = type;
        if (t instanceof com.sun.source.tree.ParameterizedTypeTree p) t = p.getType();
        if (t instanceof com.sun.source.tree.AnnotatedTypeTree a) t = a.getUnderlyingType();
        Element e = elements.get(t);
        if (e instanceof TypeElement te) return typeOf.get(te);
        TypeMirror m = typesOf.get(t);
        return unitOfMirror(m);
    }

    TypeUnit unitOfMirror(TypeMirror m) {
        if (m == null || m.getKind() != TypeKind.DECLARED) return null;
        Element e = typeUtils.asElement(m);
        return e != null ? typeOf.get(e) : null;
    }

    /** The project unit an element belongs to: its type, the owner of a member or method. */
    TypeUnit unitOfElement(Element e) {
        for (Element x = e; x != null; x = x.getEnclosingElement()) {
            TypeUnit t = typeOf.get(x);
            if (t != null) return t;
            if (x.getKind() == ElementKind.PACKAGE || x.getKind() == ElementKind.MODULE) return null;
        }
        return null;
    }

    List<TypeUnit> allTypes() {
        return new ArrayList<>(types.values());
    }

    List<Fn> allFunctions() {
        return new ArrayList<>(functions.values());
    }

    /** The functions of a module in id order. */
    List<Fn> moduleFunctions(Module m) {
        List<Fn> result = new ArrayList<>();
        for (TypeUnit t : m.types) result.addAll(t.methods);
        return result;
    }

    Map<String, Object> note(String level, String message, String code) {
        Map<String, Object> d = new LinkedHashMap<>();
        d.put("level", level);
        d.put("message", message);
        d.put("code", code);
        return d;
    }

    /** Whether an expression tree is the source text a generated call (super() in a constructor) was not written as. */
    boolean isGenerated(SourceFile f, Tree t) {
        long s = start(f, t);
        long e = end(f, t);
        return s < 0 || e <= s;
    }

    static ExpressionTree strip(ExpressionTree e) {
        while (e instanceof com.sun.source.tree.ParenthesizedTree p) e = p.getExpression();
        return e;
    }
}
