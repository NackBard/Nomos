package nomos.java;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/** Tests of the Java analyzer without a test framework: the standard library has none (D-058). Run by node run.mjs --test. */
public final class Tests {
    private static int failed;
    private static int passed;
    private static Path home;

    private Tests() {
    }

    public static void main(String[] args) throws Exception {
        home = Path.of(args.length > 0 ? args[0] : ".").toAbsolutePath();
        test("every finding text is a template of spec/rules", Tests::templatesAreInSpec);
        test("the manifest names supported rules of spec and the Java files", Tests::manifest);
        test("two runs give the same bytes", Tests::deterministic);
        test("exit codes follow the protocol, not the findings", Tests::exitCodes);
        test("an empty folder is analyzed with a note", Tests::emptyFolder);
        test("an unresolved library type is named by its import", Tests::unresolved);
        test("a constructor javac adds and its super() give no function and no call", Tests::generated);
        test("overloads keep their parameter types in the id, nested types their outer type", Tests::ids);
        test("a record component read through its accessor is a property read", Tests::recordAccessor);
        test("practices switch off rules outside them", Tests::practices);
        test("a text block is one token and a comment is not code", Tests::tokens);
        test("numbers are written as JavaScript writes them", Tests::numbers);
        System.out.println(passed + " passed, " + failed + " failed");
        System.exit(failed == 0 ? 0 : 1);
    }

    interface Body {
        void run() throws Exception;
    }

    private static void test(String name, Body body) {
        try {
            body.run();
            passed++;
            System.out.println("PASS  " + name);
        } catch (Throwable e) {
            failed++;
            System.out.println("FAIL  " + name + "\n      " + e);
        }
    }

    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    record Output(int code, String out, String err) {
    }

    private static Output run(String... args) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        ByteArrayOutputStream err = new ByteArrayOutputStream();
        int code = Main.run(args, new PrintStream(out, true, StandardCharsets.UTF_8), new PrintStream(err, true, StandardCharsets.UTF_8));
        return new Output(code, out.toString(StandardCharsets.UTF_8), err.toString(StandardCharsets.UTF_8));
    }

    private static Path project(String... files) throws IOException {
        Path root = Files.createTempDirectory("nomos-java-test");
        for (int i = 0; i < files.length; i += 2) {
            Path file = root.resolve(files[i]);
            Files.createDirectories(file.getParent());
            Files.writeString(file, files[i + 1], StandardCharsets.UTF_8);
        }
        return root;
    }

    private static Map<String, Object> analyze(Path root, String... extra) throws Json.ParseError {
        List<String> args = new ArrayList<>(List.of("analyze", "--root", root.toString()));
        args.addAll(List.of(extra));
        Output o = run(args.toArray(String[]::new));
        check(o.code() == 0 || o.code() == 4, "exit code " + o.code() + ": " + o.err());
        return Json.object(Json.parse(o.out()));
    }

    private static List<Map<String, Object>> list(Map<String, Object> facts, String key) {
        List<Map<String, Object>> result = new ArrayList<>();
        for (Object o : Json.array(facts.get(key))) result.add(Json.object(o));
        return result;
    }

    private static Set<String> edges(Map<String, Object> facts) {
        Set<String> result = new HashSet<>();
        for (Map<String, Object> d : list(facts, "dependencies")) result.add(d.get("from") + " -> " + d.get("to") + " [" + d.get("kind") + "]");
        return result;
    }

    // Tests -------------------------------------------------------------------------------------------------------------

    private static void templatesAreInSpec() throws IOException {
        Set<String> spec = new HashSet<>();
        for (Map<String, Object> rule : Config.specRules()) {
            Json.object(rule.get("messages")).values().forEach(m -> spec.add((String) Json.object(m).get("text")));
        }
        Pattern call = Pattern.compile("\\btx\\(\\s*\"((?:[^\"\\\\]|\\\\.)*)\"");
        int found = 0;
        try (Stream<Path> files = Files.walk(home.resolve("src"))) {
            for (Path file : files.filter(f -> f.toString().endsWith(".java")).toList()) {
                Matcher m = call.matcher(Files.readString(file, StandardCharsets.UTF_8));
                while (m.find()) {
                    found++;
                    String template = m.group(1).replace("\\\"", "\"").replace("\\\\", "\\");
                    check(spec.contains(template), file.getFileName() + ": not a template of spec/rules: " + template);
                }
            }
        }
        check(found > 40, "only " + found + " templates found");
    }

    private static void manifest() throws Json.ParseError {
        Output o = run("manifest");
        check(o.code() == 0, "exit code " + o.code());
        Map<String, Object> m = Json.object(Json.parse(o.out()));
        check("java".equals(m.get("language")), "language");
        check(List.of("**/*.java").equals(m.get("files")), "files");
        Set<String> ids = new HashSet<>();
        for (Map<String, Object> r : Config.specRules()) ids.add((String) r.get("id"));
        for (Object id : Json.array(Json.object(m.get("capabilities")).get("supportedRules"))) check(ids.contains(id), "unknown rule " + id);
    }

    private static void deterministic() throws Exception {
        Path root = project("a/A.java", "package a;\nimport java.util.*;\npublic class A { List<B> items = new ArrayList<>(); int n(int[] xs) { int s = 0; for (int x : xs) for (int y : xs) s += x * y; return s; } }\n",
            "a/B.java", "package a;\nclass B { A back; }\n");
        Path sarif = root.resolve("out.sarif");
        String first = run("analyze", "--root", root.toString(), "--sarif", sarif.toString()).out();
        String firstSarif = Files.readString(sarif);
        String second = run("analyze", "--root", root.toString(), "--sarif", sarif.toString()).out();
        check(first.equals(second), "facts differ");
        check(firstSarif.equals(Files.readString(sarif)), "SARIF differs");
        // checks.sarifFile repeats the --sarif argument as given; nothing else may name the root.
        String escaped = root.toString().replace("\\", "\\\\");
        check(first.indexOf(escaped) == first.lastIndexOf(escaped) && first.contains("\"sarifFile\": \"" + escaped), "an absolute path in the facts");
    }

    private static void exitCodes() throws IOException {
        check(run().code() == 2, "no command");
        check(run("analyze").code() == 2, "no root");
        check(run("analyze", "--root", "/no/such/folder/at/all").code() == 3, "missing root");
        Path root = project("A.java", "class A { void f() { int x = 1; } }\n", "nomos.json", "{ \"schemaVersion\": \"2.0.0\" }");
        check(run("analyze", "--root", root.toString(), "--config", root.resolve("nomos.json").toString()).code() == 3, "bad config");
        check(run("analyze", "--root", root.toString(), "--rules", "NOPE1").code() == 2, "unknown rule");
        check(run("analyze", "--root", root.toString()).code() == 0, "a clean file");
        Path broken = project("A.java", "class A { int x = ; }\n");
        check(run("analyze", "--root", broken.toString()).code() == 4, "a syntax error");
    }

    private static void emptyFolder() throws Exception {
        Map<String, Object> facts = analyze(project());
        check(list(facts, "files").isEmpty(), "files");
        check(list(facts, "diagnostics").stream().anyMatch(d -> "no-files".equals(d.get("code"))), "no-files diagnostic");
    }

    private static void unresolved() throws Exception {
        Map<String, Object> facts = analyze(project("app/Svc.java", "package app;\nimport org.lib.Client;\npublic class Svc { Client client; void go() { client.send(); } }\n"));
        Set<String> e = edges(facts);
        check(e.contains("app.Svc -> org.lib.Client [type-ref]"), "type edge: " + e);
        check(e.contains("app.Svc -> org.lib.Client [call]"), "call edge: " + e);
        check(e.contains("app -> org.lib [import]"), "import edge: " + e);
        check(list(facts, "diagnostics").stream().anyMatch(d -> "unresolved".equals(d.get("code"))), "unresolved diagnostic");
        Map<String, Object> svc = list(facts, "types").get(0);
        check(Json.object(svc.get("metrics")).get("cbo").equals(1L), "CBO counts the library type");
    }

    private static void generated() throws Exception {
        Map<String, Object> facts = analyze(project("p/B.java", "package p;\nclass B { }\nclass C extends B { C() { int x = 1; } }\n"));
        check(edges(facts).equals(Set.of("p.C -> p.B [inheritance]")), "edges: " + edges(facts));
        List<String> ids = list(facts, "functions").stream().map(f -> (String) f.get("id")).toList();
        check(ids.equals(List.of("p.C.C")), "functions: " + ids);
    }

    private static void ids() throws Exception {
        Map<String, Object> facts = analyze(project("p/O.java", "package p;\npublic class O {\n  int f(int a) { return a; }\n  int f(String s) { return 0; }\n  static class In { }\n}\n"));
        List<String> functions = list(facts, "functions").stream().map(f -> (String) f.get("id")).toList();
        check(functions.equals(List.of("p.O.f(int)", "p.O.f(java.lang.String)")), "functions: " + functions);
        List<String> types = list(facts, "types").stream().map(f -> (String) f.get("id")).toList();
        check(types.equals(List.of("p.O", "p.O.In")), "types: " + types);
    }

    private static void recordAccessor() throws Exception {
        Map<String, Object> facts = analyze(project("p/R.java", "package p;\nrecord R(int x) { }\nclass U { int read(R r) { return r.x(); } }\n"));
        check(edges(facts).equals(Set.of("p.U -> p.R [type-ref]")), "edges: " + edges(facts));
    }

    private static void practices() throws Exception {
        Path root = project("A.java", "class A { }\n", "nomos.json", "{ \"schemaVersion\": \"1.1.0\", \"practices\": [\"security\"] }");
        Map<String, Object> facts = analyze(root, "--config", root.resolve("nomos.json").toString());
        check(list(facts, "skippedRules").stream().anyMatch(s -> "CC001".equals(s.get("ruleId")) && "disabled-by-config".equals(s.get("reason")) && !s.containsKey("module")),
            "CC001 is outside security");
        Path unknown = project("A.java", "class A { }\n", "nomos.json", "{ \"schemaVersion\": \"1.1.0\", \"practices\": [\"nope\"] }");
        check(run("analyze", "--root", unknown.toString(), "--config", unknown.resolve("nomos.json").toString()).code() == 3, "unknown practice");
    }

    private static void tokens() {
        Lexer.Result r = Lexer.scan("class A {\n  // note\n  String s = \"\"\"\n    a \"quoted\" b\n    \"\"\";\n}\n");
        check(r.tokens().stream().filter(t -> t.kind() == Lexer.Kind.LITERAL).count() == 1, "one literal");
        check(r.loc() == 5, "loc " + r.loc());
        check(r.comments().size() == 1, "one comment");
    }

    private static void numbers() {
        check(Json.number(0.0001).equals("0.0001"), Json.number(0.0001));
        check(Json.number(1.0).equals("1"), Json.number(1.0));
        check(Json.number(0.6667).equals("0.6667"), Json.number(0.6667));
        check(Text.fixed(0.125, 2).equals("0.13"), Text.fixed(0.125, 2));
    }
}
