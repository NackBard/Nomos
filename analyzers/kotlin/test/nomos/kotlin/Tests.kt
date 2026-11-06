package nomos.kotlin

import java.io.ByteArrayOutputStream
import java.io.PrintStream
import java.nio.file.Files
import java.nio.file.Path
import kotlin.system.exitProcess

/** Tests of the Kotlin analyzer without a test framework, as for Java (D-059). Run by node run.mjs --test. */
private var failed = 0
private var passed = 0
private lateinit var home: Path

fun main(args: Array<String>) {
    home = Path.of(if (args.isNotEmpty()) args[0] else ".").toAbsolutePath()
    test("every finding text is a template of spec/rules", ::templatesAreInSpec)
    test("the manifest names supported rules of spec and the Kotlin files", ::manifest)
    test("two runs give the same bytes", ::deterministic)
    test("exit codes follow the protocol, not the findings", ::exitCodes)
    test("an empty folder is analyzed with a note", ::emptyFolder)
    test("a library type is named by its import", ::imported)
    test("overloads keep their parameter types in the id, nested types their outer type", ::ids)
    test("companion and object members are static, top-level functions are units", ::statics)
    test("an extension function depends on its receiver, which is no parameter", ::extension)
    test("implicit it and the loop variable get the element type", ::elements)
    test("practices switch off rules outside them", ::practices)
    test("a string template is one token and a comment is not code", ::tokens)
    test("numbers are written as JavaScript writes them", ::numbers)
    println("$passed passed, $failed failed")
    exitProcess(if (failed == 0) 0 else 1)
}

private fun test(name: String, body: () -> Unit) {
    try {
        body()
        passed++
        println("PASS  $name")
    } catch (e: Throwable) {
        failed++
        println("FAIL  $name\n      $e")
    }
}

private fun check(condition: Boolean, message: () -> String) {
    if (!condition) throw AssertionError(message())
}

private class Output(val code: Int, val out: String, val err: String)

private fun run(vararg args: String): Output {
    val out = ByteArrayOutputStream()
    val err = ByteArrayOutputStream()
    val code = Main.run(args.toList(), PrintStream(out, true, "UTF-8"), PrintStream(err, true, "UTF-8"))
    return Output(code, out.toString("UTF-8"), err.toString("UTF-8"))
}

private fun project(vararg files: String): Path {
    val root = Files.createTempDirectory("nomos-kotlin-test")
    for (i in files.indices step 2) {
        val file = root.resolve(files[i])
        Files.createDirectories(file.parent)
        Files.writeString(file, files[i + 1], Charsets.UTF_8)
    }
    return root
}

private fun analyze(root: Path, vararg extra: String): Map<String, Any?> {
    val o = run("analyze", "--root", root.toString(), *extra)
    check(o.code == 0 || o.code == 4) { "exit code ${o.code}: ${o.err}" }
    return Json.obj(Json.parse(o.out))
}

private fun list(facts: Map<String, Any?>, key: String): List<Map<String, Any?>> = Json.array(facts[key]).map { Json.obj(it) }

private fun edges(facts: Map<String, Any?>): Set<String> = list(facts, "dependencies").map { "${it["from"]} -> ${it["to"]} [${it["kind"]}]" }.toSet()

private fun internalEdges(facts: Map<String, Any?>): Set<String> =
    list(facts, "dependencies").filter { it["external"] == false }.map { "${it["from"]} -> ${it["to"]} [${it["kind"]}]" }.toSet()

private fun ids(facts: Map<String, Any?>, key: String): List<String> = list(facts, key).map { it["id"] as String }

private fun byId(facts: Map<String, Any?>, key: String, id: String): Map<String, Any?> = list(facts, key).first { it["id"] == id }

// Tests ---------------------------------------------------------------------------------------------------------------

private fun templatesAreInSpec() {
    val spec = Config.specRules().flatMap { rule -> Json.obj(rule["messages"]).values.map { Json.obj(it)["text"] as String } }.toSet()
    val call = Regex("\\btx\\(\\s*\"((?:[^\"\\\\]|\\\\.)*)\"")
    var found = 0
    Files.walk(home.resolve("src")).use { files ->
        for (file in files.filter { it.toString().endsWith(".kt") }.toList()) {
            for (m in call.findAll(Files.readString(file, Charsets.UTF_8))) {
                found++
                val template = m.groupValues[1].replace("\\\"", "\"").replace("\\\\", "\\").replace("\\$", "$")
                check(template in spec) { "${file.fileName}: not a template of spec/rules: $template" }
            }
        }
    }
    check(found > 40) { "only $found templates found" }
}

private fun manifest() {
    val o = run("manifest")
    check(o.code == 0) { "exit code ${o.code}" }
    val m = Json.obj(Json.parse(o.out))
    check(m["language"] == "kotlin") { "language" }
    check(m["files"] == listOf("**/*.kt")) { "files" }
    val known = Config.specRules().map { it["id"] as String }.toSet()
    for (id in Json.array(Json.obj(m["capabilities"])["supportedRules"])) check(id in known) { "unknown rule $id" }
    check(Json.obj(m["capabilities"])["semantic"] == false) { "semantic" }
}

private fun deterministic() {
    val root = project("a/A.kt", "package a\nclass A { val items = mutableListOf<B>()\n fun n(xs: IntArray): Int { var s = 0; for (x in xs) for (y in xs) s += x * y; return s } }\n",
        "a/B.kt", "package a\nclass B { lateinit var back: A }\nfun top(b: B) = b.back\n")
    val sarif = root.resolve("out.sarif")
    val first = run("analyze", "--root", root.toString(), "--sarif", sarif.toString()).out
    val firstSarif = Files.readString(sarif)
    val second = run("analyze", "--root", root.toString(), "--sarif", sarif.toString()).out
    check(first == second) { "facts differ" }
    check(firstSarif == Files.readString(sarif)) { "SARIF differs" }
    // checks.sarifFile repeats the --sarif argument as given; nothing else may name the root.
    val escaped = root.toString().replace("\\", "\\\\")
    check(first.indexOf(escaped) == first.lastIndexOf(escaped) && first.contains("\"sarifFile\": \"$escaped")) { "an absolute path in the facts" }
}

private fun exitCodes() {
    check(run().code == 2) { "no command" }
    check(run("analyze").code == 2) { "no root" }
    check(run("analyze", "--root", "/no/such/folder/at/all").code == 3) { "missing root" }
    val root = project("A.kt", "class A { fun f() { val x = 1 } }\n", "nomos.json", "{ \"schemaVersion\": \"2.0.0\" }")
    check(run("analyze", "--root", root.toString(), "--config", root.resolve("nomos.json").toString()).code == 3) { "bad config" }
    check(run("analyze", "--root", root.toString(), "--rules", "NOPE1").code == 2) { "unknown rule" }
    check(run("analyze", "--root", root.toString()).code == 0) { "a clean file" }
    val broken = project("A.kt", "class A { val x = }\n")
    check(run("analyze", "--root", broken.toString()).code == 4) { "a syntax error" }
}

private fun emptyFolder() {
    val facts = analyze(project())
    check(list(facts, "files").isEmpty()) { "files" }
    check(list(facts, "diagnostics").any { it["code"] == "no-files" }) { "no-files diagnostic" }
}

private fun imported() {
    val facts = analyze(project("app/Svc.kt", "package app\nimport org.lib.Client\nclass Svc(val client: Client) { fun go() { client.send() } }\n"))
    val e = edges(facts)
    check("app.Svc -> org.lib.Client [type-ref]" in e) { "type edge: $e" }
    check("app.Svc -> org.lib.Client [call]" in e) { "call edge: $e" }
    check("app -> org.lib [import]" in e) { "import edge: $e" }
    check(Json.obj(byId(facts, "types", "app.Svc")["metrics"])["cbo"] == 1L) { "CBO counts the library type" }
}

private fun ids() {
    val facts = analyze(project("p/O.kt", "package p\nclass O {\n  fun f(a: Int) = a\n  fun f(s: String) = 0\n  class In\n}\n"))
    val functions = ids(facts, "functions")
    check(functions == listOf("p.O.f(Int)", "p.O.f(String)")) { "functions: $functions" }
    val types = ids(facts, "types")
    check(types == listOf("p.O", "p.O.In")) { "types: $types" }
}

private fun statics() {
    val facts = analyze(project("p/S.kt", "package p\nclass S { companion object { var n = 0; fun make() = S() } }\nobject Registry { var size = 0; fun add() { size++ } }\nfun helper() = S.make()\n"))
    check(ids(facts, "types") == listOf("p.Registry", "p.S")) { "types: ${ids(facts, "types")}" }
    check(byId(facts, "functions", "p.S.make")["isStatic"] == true) { "companion function" }
    check(byId(facts, "functions", "p.Registry.add")["isStatic"] == true) { "object function" }
    val helper = byId(facts, "functions", "p.helper")
    check(!helper.containsKey("type") && helper["kind"] == "function") { "top-level function: $helper" }
    check("p.helper -> p.S [call]" in internalEdges(facts)) { "edges: ${internalEdges(facts)}" }
    val evidence = list(list(facts, "modules")[0], "paradigmEvidence").associate { it["kind"] to it["examples"] }
    check(evidence["str.global-state"] == listOf("p.Registry.size", "p.S.n")) { "global state: $evidence" }
    check(evidence["str.free-functions"] == listOf("p.helper")) { "free functions: $evidence" }
}

private fun extension() {
    val facts = analyze(project("p/E.kt", "package p\nclass Cart { val total = 0 }\nfun Cart.describe(prefix: String) = prefix + total\n"))
    val fn = byId(facts, "functions", "p.describe")
    check(Json.obj(fn["metrics"])["parameterCount"] == 1L) { "parameters: $fn" }
    val e = internalEdges(facts)
    check("p.describe -> p.Cart [type-ref]" in e) { "edges: $e" }
}

private fun elements() {
    val facts = analyze(project("p/L.kt", "package p\nclass Item { var price = 0 }\nclass Shop {\n  private val items = mutableListOf<Item>()\n" +
        "  fun a(): Int { var s = 0; for (i in items) s += i.price; return s }\n  fun b() = items.sumOf { it.price }\n}\n"))
    check(Json.obj(byId(facts, "types", "p.Shop")["metrics"])["atfd"] == 1L) { "ATFD: ${byId(facts, "types", "p.Shop")}" }
    check(Json.obj(byId(facts, "functions", "p.Shop.b")["metrics"])["timeDegree"] == 1L) { "sumOf is linear" }
}

private fun practices() {
    val root = project("A.kt", "class A\n", "nomos.json", "{ \"schemaVersion\": \"1.1.0\", \"practices\": [\"security\"] }")
    val facts = analyze(root, "--config", root.resolve("nomos.json").toString())
    check(list(facts, "skippedRules").any { it["ruleId"] == "CC001" && it["reason"] == "disabled-by-config" && !it.containsKey("module") }) { "CC001 is outside security" }
    val unknown = project("A.kt", "class A\n", "nomos.json", "{ \"schemaVersion\": \"1.1.0\", \"practices\": [\"nope\"] }")
    check(run("analyze", "--root", unknown.toString(), "--config", unknown.resolve("nomos.json").toString()).code == 3) { "unknown practice" }
}

private fun tokens() {
    val root = project("A.kt", "class A {\n  // note\n  val s = \"\"\"\n    a \${'$'}{1 + 2} b\n    \"\"\"\n  val t = \"x \$s y\"\n}\n")
    val p = Project(root)
    p.load(emptyList(), emptyList())
    val f = p.files[0]
    check(f.tokens.count { it.kind == TokenKind.LITERAL } == 2) { "literals: ${f.tokens.filter { it.kind == TokenKind.LITERAL }.map { it.text }}" }
    check(f.loc == 6) { "loc ${f.loc}" }
    check(f.comments.size == 1) { "comments ${f.comments.size}" }
}

private fun numbers() {
    check(Json.number(0.0001) == "0.0001") { Json.number(0.0001) }
    check(Json.number(1.0) == "1") { Json.number(1.0) }
    check(Json.number(0.6667) == "0.6667") { Json.number(0.6667) }
    check(Text.fixed(0.125, 2) == "0.13") { Text.fixed(0.125, 2) }
}
