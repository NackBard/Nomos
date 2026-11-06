package nomos.kotlin

import java.security.MessageDigest
import java.util.IdentityHashMap
import org.jetbrains.kotlin.lexer.KtTokens
import org.jetbrains.kotlin.psi.KtBinaryExpression
import org.jetbrains.kotlin.psi.KtCallExpression
import org.jetbrains.kotlin.psi.KtCatchClause
import org.jetbrains.kotlin.psi.KtConstantExpression
import org.jetbrains.kotlin.psi.KtDoWhileExpression
import org.jetbrains.kotlin.psi.KtElement
import org.jetbrains.kotlin.psi.KtExpression
import org.jetbrains.kotlin.psi.KtIfExpression
import org.jetbrains.kotlin.psi.KtNameReferenceExpression
import org.jetbrains.kotlin.psi.KtParameter
import org.jetbrains.kotlin.psi.KtProperty
import org.jetbrains.kotlin.psi.KtQualifiedExpression
import org.jetbrains.kotlin.psi.KtStringTemplateExpression
import org.jetbrains.kotlin.psi.KtWhileExpression

class Finding(
    val rule: String, val severity: String, val confidence: String, val category: String, val place: Place, val message: String, val explanation: String,
    var module: String, val entity: String, val messageText: Text, val explanationText: Text, val measured: Map<String, Any?>?,
)

/** State of one analysis shared by the detectors. */
class Run(val p: Project, val config: Config, val edges: List<Edge>, val graphs: Graphs, val estimates: Map<String, Growth>) {
    val findings = ArrayList<Finding>()
    lateinit var rule: Map<String, Any?>
    val ran = LinkedHashMap<String, Map<String, Any?>>()
    val active = HashMap<String, Set<String>>()
    var coverage: Coverage? = null

    fun paradigms(): List<String> = Config.strings(rule["paradigms"])

    fun applies(m: Module): Boolean {
        val paradigms = paradigms()
        if (paradigms.isEmpty()) return true
        val own = active[m.id] ?: emptySet()
        return paradigms.any { it in own }
    }

    fun number(name: String) = config.number(rule, name)

    /** A threshold as JSON writes it: an integer stays an integer. */
    fun threshold(name: String): Any {
        val v = number(name)
        return if (v == Math.rint(v)) v.toLong() else v
    }

    fun limit(name: String): String {
        val v = number(name)
        return if (v == Math.rint(v)) v.toLong().toString() else Json.number(v)
    }

    fun report(confidence: String, place: Place, module: String, entity: String, message: Text, explanation: Text, measured: Map<String, Any?>? = null, severity: String? = null) {
        val id = rule["id"] as String
        val own = config.rule(id)["severity"] as? String
        findings.add(Finding(id, own ?: severity ?: rule["severity"] as String, confidence, rule["category"] as String, place, message.render(), explanation.render(),
            module, entity, message, explanation, measured))
    }

    fun functions(): List<Fn> = p.modules.filter { applies(it) }.flatMap { p.moduleFunctions(it) }

    fun types(): List<TypeUnit> = p.modules.filter { applies(it) }.flatMap { it.types }

    fun martin(m: Module): Map<String, Any?> {
        val inside = (m.types.map { it.id } + m.functions.map { it.id }).toSet()
        val incoming = HashSet<String>()
        val outgoing = HashSet<String>()
        for (unit in inside) {
            for (o in graphs.units.prev[unit] ?: emptySet<String>()) if (o !in inside) incoming.add(o)
            for (o in graphs.units.next[unit] ?: emptySet<String>()) if (o !in inside) outgoing.add(o)
        }
        val ca = incoming.size
        val ce = outgoing.size
        val instability = if (ca + ce > 0) Text.round(ce.toDouble() / (ca + ce), 4) else null
        val abstractness = if (m.types.isNotEmpty()) Text.round(m.types.count { it.isAbstract }.toDouble() / m.types.size, 4) else null
        val distance = if (instability != null && abstractness != null) Text.round(Math.abs(abstractness + instability - 1), 4) else null
        return Json.of("ca" to ca, "ce" to ce, "instability" to instability, "abstractness" to abstractness, "distance" to distance)
    }

    fun cbo(t: TypeUnit): Int = edges.filter { it.from == t.id && it.kind != "import" && it.toType && !it.stdlib }.map { it.to }.toSet().size
}

/** The detectors. Every finding text is a template of its rule in spec/rules (checked by the test templatesAreInSpec). */
object Rules {
    /** The rules implemented for Kotlin. STR001: the language has no goto; the others are not written (D-059). */
    val SUPPORTED = listOf(
        "ALG001", "ALG002", "ALG003", "ALG004", "CC001", "CC002", "CC003", "CC004", "CC009", "DSN001", "DSN002", "DSN003", "DSN004", "DSN005", "DSN006",
        "FUN005", "MNT001", "MNT002", "MNT003", "MNT004", "OOP001", "OOP002", "OOP003", "OOP004", "OOP005", "PRN007", "SEC001", "SEC003", "STR002", "STR003")

    /** Does not depend on the line (contracts/sarif-profile.md). */
    fun fingerprint(f: Finding): String {
        val hash = MessageDigest.getInstance("SHA-256").digest("${f.rule}|${f.place.file}|${f.entity}|${f.message}".toByteArray(Charsets.UTF_8))
        return (0 until 8).joinToString("") { String.format("%02x", hash[it]) }
    }

    fun measured(metric: String, value: Any?, threshold: Any?): Map<String, Any?> = Json.of("metric" to metric, "value" to value, "threshold" to threshold)

    fun filePlace(path: String) = Place(path, 1, 1, 1, 1)

    /** Fields, properties, constants and entries, methods and constructors, nested types; accessors are part of their property. */
    fun memberCount(t: TypeUnit): Int = t.members.size + t.methods.count { it.kind != "accessor" } + t.nested.size

    fun methodCount(t: TypeUnit): Int = t.methods.count { it.kind != "accessor" }

    val DETECTORS: Map<String, (Run) -> Unit> = linkedMapOf(
        "ALG001" to ::alg001, "ALG002" to ::alg002, "ALG003" to ::alg003, "ALG004" to ::alg004, "CC001" to ::cc001, "CC002" to ::cc002, "CC003" to ::cc003,
        "CC004" to ::cc004, "CC009" to ::cc009, "DSN001" to ::dsn001, "DSN002" to ::dsn002, "DSN003" to ::dsn003, "DSN004" to ::dsn004, "DSN005" to ::dsn005,
        "DSN006" to ::dsn006, "FUN005" to ::fun005, "MNT001" to ::mnt001, "MNT002" to ::mnt002, "MNT003" to ::mnt003, "MNT004" to ::mnt004,
        "OOP001" to ::oop001, "OOP002" to ::oop002, "OOP003" to ::oop003, "OOP004" to ::oop004, "OOP005" to ::oop005, "PRN007" to ::prn007,
        "SEC001" to ::sec001, "SEC003" to ::sec003, "STR002" to ::str002, "STR003" to ::str003,
    )

    // Clean code ------------------------------------------------------------------------------------------------------

    private fun cc001(r: Run) {
        val limit = r.number("maxLines")
        for (f in r.functions()) {
            val lines = f.place.lines()
            if (!f.hasBody || lines <= limit) continue
            r.report("high", f.place, f.module.id, f.id, tx("{0} spans {1} lines", f.name, lines),
                tx("The line count is exact; the limit of {0} is a readability convention.", r.limit("maxLines")),
                measured("lines", lines, r.threshold("maxLines")), if (lines > limit * 2) "major" else null)
        }
    }

    private fun cc002(r: Run) {
        val maxLines = r.number("maxLines")
        val maxMembers = r.number("maxMembers")
        for (t in r.types()) {
            val lines = t.place.lines()
            val count = memberCount(t)
            if (lines <= maxLines && count <= maxMembers) continue
            val m = if (lines > maxLines) measured("lines", lines, r.threshold("maxLines")) else null
            r.report("high", t.place, t.module.id, t.id, tx("{0} has {1} lines and {2} members", t.name, lines, count),
                tx("The counts are exact; the limits ({0} lines, {1} members) are conventions.", r.limit("maxLines"), r.limit("maxMembers")), m)
        }
    }

    private fun cc003(r: Run) {
        for (f in r.functions()) {
            val count = Metrics.parameterCount(f)
            val name = if (f.kind == "constructor") "maxConstructorParameters" else "maxParameters"
            if (count > r.number(name)) {
                r.report("high", f.place, f.module.id, f.id, tx("{0} takes {1} parameters", f.name, count),
                    tx("The limit is {0}. Long lists are easy to misorder; a parameter object groups what belongs together.", r.limit(name)),
                    measured("parameterCount", count, r.threshold(name)))
            }
        }
    }

    private fun cc004(r: Run) {
        val limit = r.number("maxDepth")
        for (f in r.functions()) {
            val depth = Metrics.maxNesting(f)
            if (depth > limit) {
                r.report("high", f.place, f.module.id, f.id, tx("{0} nests {1} levels deep", f.name, depth),
                    tx("The limit is {0}. Guard clauses or extracted methods flatten the flow.", r.limit("maxDepth")), measured("maxNesting", depth, r.threshold("maxDepth")))
            }
        }
    }

    private fun cc009(r: Run) {
        for (f in r.functions()) {
            for (n in Metrics.body(f)) {
                if (n !is KtCatchClause) continue
                val block = n.catchBody ?: continue
                if (Metrics.children(block).isNotEmpty()) continue
                // A comment in the handler says why ignoring is safe.
                if (f.file.hasComment(block.textRange.startOffset, block.textRange.endOffset)) continue
                r.report("high", f.file.place(n), f.module.id, f.id, tx("Empty catch in {0}", f.name),
                    tx("The exception disappears without handling, logging or a comment saying why that is safe."))
            }
        }
    }

    // Algorithms ------------------------------------------------------------------------------------------------------

    private fun alg001(r: Run) {
        val reportFrom = r.number("reportFromDegree")
        for (f in r.functions()) {
            val g = r.estimates[f.id] ?: continue
            if (!g.exponential && g.degree < reportFrom) continue
            val explanation = if (g.uncertain) tx("Estimated from recursion, a while loop or a callee; loop bounds and call counts are not known exactly.")
            else tx("Estimated from nested loops over inputs of unknown size. Small inputs may make this irrelevant.")
            val m = if (g.exponential) measured("timeExponential", 1, 1) else measured("timeDegree", g.degree, r.threshold("reportFromDegree"))
            r.report(if (g.uncertain) "low" else "medium", f.place, f.module.id, f.id, tx("{0} is likely {1}", f.name, Estimate.text(g)), explanation, m,
                if (g.exponential) "major" else null)
        }
    }

    private val LISTS = setOf("List", "MutableList", "ArrayList", "LinkedList")

    private fun alg002(r: Run) {
        for (f in r.functions()) {
            val found = ArrayList<Triple<KtElement, String, String>>()
            Metrics.walkLoops(r.p, f) { n, depth ->
                if (depth == 0) return@walkLoops
                if (n is KtCallExpression && Metrics.callee(r.p, n) == null) {
                    val receiver = Metrics.receiverOf(n)
                    if (receiver != null && r.p.resolver.exprTypes[receiver]?.simple in LISTS) {
                        val method = Metrics.calleeName(n)
                        if (method == "contains" || method == "indexOf" || method == "lastIndexOf") found.add(Triple(n, "search", method))
                        val first = n.valueArguments.firstOrNull()?.getArgumentExpression()
                        if (method == "add" && n.valueArguments.size == 2 && first is KtConstantExpression && first.text == "0") found.add(Triple(n, "front", method))
                    }
                }
                if (n is KtBinaryExpression && (n.operationToken == KtTokens.IN_KEYWORD || n.operationToken == KtTokens.NOT_IN) &&
                    r.p.resolver.exprTypes[n.right]?.simple in LISTS) found.add(Triple(n, "search", "in"))
                if (n is KtBinaryExpression && n.operationToken == KtTokens.PLUSEQ && r.p.resolver.exprTypes[n.left]?.simple == "String") found.add(Triple(n, "concat", ""))
            }
            for ((node, kind, method) in found) {
                val place = f.file.place(node)
                when (kind) {
                    "search" -> r.report("medium", place, f.module.id, f.id, tx("Likely quadratic: {0} on a sequence inside a loop", method),
                        tx("Each iteration scans the list. A HashSet or HashMap built once makes the lookup constant-time."))
                    "front" -> r.report("medium", place, f.module.id, f.id, tx("Likely quadratic: {0}(0) inside a loop", method),
                        tx("Every element shifts on each call. A Queue, a Stack or iterating from the end avoids this."))
                    else -> r.report("medium", place, f.module.id, f.id, tx("Likely quadratic: String concatenation inside a loop"),
                        tx("Each step copies the whole string so far. StringBuilder grows in amortized constant time."))
                }
            }
        }
    }

    val MATERIALIZING = setOf("toList", "toMutableList", "toSet", "toMutableSet", "toHashSet", "toMap", "toMutableMap", "toTypedArray", "toIntArray", "toSortedSet")

    /** The name of a call that builds a new collection from another one, or null. */
    fun materialization(r: Run, call: KtCallExpression): String? {
        if (Metrics.callee(r.p, call) != null) return null
        val receiver = Metrics.receiverOf(call) ?: return null
        val name = Metrics.calleeName(call)
        if (name !in MATERIALIZING) return null
        val type = r.p.resolver.exprTypes[receiver]
        if (type?.unit != null) return null
        return "$name()"
    }

    private fun alg003(r: Run) {
        val limit = r.number("minDepthForObjects")
        for (f in r.functions()) {
            var deepest = 0
            val items = ArrayList<Pair<KtElement, Int>>()
            Metrics.walkLoops(r.p, f) { n, depth ->
                if (Metrics.allocates(r.p, n)) deepest = maxOf(deepest, depth)
                items.add(n to depth)
            }
            val reported = ArrayList<KtElement>()
            for ((n, depth) in items) {
                if (depth >= 1 && n is KtCallExpression) {
                    materialization(r, n)?.let {
                        r.report("medium", f.file.place(n), f.module.id, f.id, tx("{0} allocates on each loop iteration", it),
                            tx("A new collection is built per iteration; moving it out of the loop or reusing a buffer reduces GC pressure."))
                    }
                }
                if (depth < limit || !Metrics.allocates(r.p, n) || within(n, reported)) continue
                reported.add(n)
                val place = f.file.place(n)
                val m = measured("allocationDepth", deepest, r.threshold("minDepthForObjects"))
                when {
                    Metrics.isLambda(n) -> r.report("low", place, f.module.id, f.id, tx("Lambda in a nested loop"),
                        tx("A capturing lambda allocates a closure per iteration; a non-capturing one is cached."), m)
                    n is KtCallExpression -> r.report("low", place, f.module.id, f.id, tx("Allocation of {0} in a nested loop", Metrics.calleeName(n)),
                        tx("Runs once per inner iteration. Whether it matters depends on how hot the loop really is, which static analysis cannot tell."), m)
                    else -> r.report("low", place, f.module.id, f.id, tx("Allocation in a nested loop"),
                        tx("Runs once per inner iteration. Whether it matters depends on how hot the loop really is, which static analysis cannot tell."), m)
                }
            }
        }
    }

    private fun within(node: KtElement, outers: List<KtElement>): Boolean {
        val s = node.textRange.startOffset
        val e = node.textRange.endOffset
        return outers.any { it === node || (it.textRange.startOffset <= s && e <= it.textRange.endOffset) }
    }

    private fun alg004(r: Run) {
        val reportFrom = r.number("reportFromDegree")
        for (f in r.functions()) {
            if (!f.hasBody) continue
            val degree = Metrics.spaceDegree(r.p, f, Estimate.selfCalls(r.p, f).size)
            if (degree >= reportFrom) {
                r.report("low", f.place, f.module.id, f.id, tx("{0} likely uses {1} extra memory", f.name, Estimate.text(Growth(degree, 0, false, false))),
                    tx("Estimated from collection growth under nested loops or multi-dimensional allocation sizes."), measured("spaceDegree", degree, r.threshold("reportFromDegree")))
            }
        }
    }

    // Design ----------------------------------------------------------------------------------------------------------

    private fun dsn001(r: Run) {
        val limit = r.number("maxDistance")
        val coupling = r.number("minCoupling")
        for (m in r.p.modules) {
            val x = r.martin(m)
            val distance = x["distance"] as Double? ?: continue
            if (distance <= limit || (x["ca"] as Int) + (x["ce"] as Int) < coupling || m.types.isEmpty()) continue
            val instability = x["instability"] as Double
            val a = Text.fixed(x["abstractness"] as Double, 2)
            val i = Text.fixed(instability, 2)
            val explanation = if (instability < 0.5) tx("A = {0}, I = {1}, so it sits near the zone of pain: concrete and heavily depended upon.", a, i)
            else tx("A = {0}, I = {1}, so it sits near the zone of uselessness: abstract and unused.", a, i)
            r.report("medium", m.types[0].place, m.id, "", tx("Module {0} is far from the main sequence (D = {1})", m.id, Text.fixed(distance, 2)), explanation,
                measured("distance", distance, r.threshold("maxDistance")))
        }
    }

    private fun dsn002(r: Run) {
        for (cycle in Graphing.components(r.graphs.modules)) {
            val m = r.p.byId[cycle[0]] ?: continue
            if (m.files.isEmpty()) continue
            r.report("high", filePlace(m.files[0].path), m.id, "", tx("Module cycle: {0}", cycle.joinToString(" <-> ")),
                tx("These modules depend on each other, directly or transitively, so none can be built, tested or released alone."))
        }
        for (cycle in Graphing.components(r.graphs.units)) {
            val id = cycle[0]
            val place = r.p.types[id]?.place ?: r.p.functions[id]?.place ?: continue
            val module = r.graphs.moduleOf[id]?.id ?: ""
            r.report("high", place, module, id, tx("Type cycle of {0}: {1}", cycle.size, cycle.joinToString(" <-> ") { Graphing.simpleName(it) }),
                tx("These types reference each other, so a change to one can ripple through all of them."), null, "minor")
        }
    }

    private fun dsn003(r: Run) {
        if (r.config.layers.isEmpty()) return
        for (e in r.edges) {
            if (e.external || e.kind == "import") continue
            val sm = r.graphs.moduleOf[e.from] ?: continue
            val tm = r.graphs.moduleOf[e.to] ?: continue
            if (sm === tm) continue
            val source = r.config.layerOf(sm.id) ?: continue
            val target = r.config.layerOf(tm.id) ?: continue
            val sourceName = source["name"] as String
            val targetName = target["name"] as String
            val allowed = Config.strings(source["mayDependOn"])
            if (sourceName == targetName || targetName in allowed) continue
            val explanation = if (allowed.isEmpty()) tx("{0} ({1}) uses {2} ({3}); allowed: none.", Graphing.simpleName(e.from), sm.id, Graphing.simpleName(e.to), tm.id)
            else tx("{0} ({1}) uses {2} ({3}); allowed: {4}.", Graphing.simpleName(e.from), sm.id, Graphing.simpleName(e.to), tm.id, allowed.joinToString(", "))
            r.report("high", e.place, sm.id, e.from, tx("{0} must not depend on {1}", sourceName, targetName), explanation)
        }
    }

    private fun dsn004(r: Run) {
        val minWmc = r.number("minWmc")
        val minAtfd = r.number("minAtfd")
        val maxTcc = r.number("maxTcc")
        for (t in r.types()) {
            if (!t.isClassLike()) continue
            val w = Metrics.wmc(t)
            val a = Metrics.atfd(r.p, t)
            val c = Metrics.tcc(r.p, t)
            if (w >= minWmc && a >= minAtfd && c != null && c < maxTcc) {
                r.report("low", t.place, t.module.id, t.id, tx("{0} looks like a god class", t.name),
                    tx("WMC = {0} (>= {1}), ATFD = {2} (>= {3}), TCC = {4} (< {5}): it does much, uses others' data, and its methods share little.",
                        w, r.limit("minWmc"), a, r.limit("minAtfd"), Text.fixed(c, 2), Text.fixed(maxTcc, 2)), measured("wmc", w, r.threshold("minWmc")))
            }
        }
    }

    private fun dsn005(r: Run) {
        val limit = r.number("minForeignMembers")
        for (f in r.functions()) {
            if (!f.isInstanceMethod()) continue
            val (owner, names) = Metrics.mostUsedForeign(r.p, f)
            val own = Metrics.memberUse(r.p, f).own.size
            if (names.size >= limit && names.size > own) {
                r.report("low", f.place, f.module.id, f.id, tx("{0} is more interested in {1} than in {2}", f.name, Graphing.simpleName(owner), f.owner!!.name),
                    tx("It uses {0} members of {1} ({2}) and {3} of its own.", names.size, owner, names.joinToString(", "), own),
                    measured("foreignMembers", names.size, r.threshold("minForeignMembers")))
            }
        }
    }

    private fun dsn006(r: Run) {
        val limit = r.number("maxDependents")
        for (t in r.p.allTypes()) {
            val radius = r.graphs.radius[t.id] ?: 0
            if (radius > limit) {
                r.report("medium", t.place, t.module.id, t.id, tx("Changing {0} can reach {1} units", t.name, radius),
                    tx("Stable abstractions at such points limit the spread. Static dependencies overstate real impact when a change keeps the contract."),
                    measured("blastRadius", radius, r.threshold("maxDependents")))
            }
        }
    }

    // Paradigm --------------------------------------------------------------------------------------------------------

    private fun fun005(r: Run) {
        val maxOrder = r.number("maxOrder")
        val maxLambdas = r.number("maxLambdaNesting")
        for (f in r.functions()) {
            val order = Metrics.hofOrder(r.p, f)
            if (order > maxOrder) {
                r.report("medium", f.place, f.module.id, f.id, tx("{0} has order {1}", f.name, order), tx("The signature nests function types beyond order {0}.", r.limit("maxOrder")),
                    measured("hofOrder", order, r.threshold("maxOrder")))
            }
            val nesting = Metrics.lambdaNesting(f)
            if (nesting > maxLambdas) {
                r.report("medium", f.place, f.module.id, f.id, tx("{0} nests lambdas {1} levels deep", f.name, nesting),
                    tx("Beyond {0} levels, captured variables are hard to trace; named functions help.", r.limit("maxLambdaNesting")),
                    measured("lambdaNesting", nesting, r.threshold("maxLambdaNesting")))
            }
        }
    }

    private fun oop001(r: Run) {
        for (t in r.types()) {
            if (t.kind != "class" || t.isData) continue
            for (m in t.members) {
                if (m.kind == "field" && m.visibility == "public" && !m.isFinal && !m.isStatic) {
                    r.report("medium", m.place, t.module.id, t.id, tx("Public mutable field {0}.{1}", t.name, m.name),
                        tx("Any caller can change this field, so the type cannot protect its invariants. A property or a method can."))
                }
            }
        }
    }

    private fun oop002(r: Run) {
        val limit = r.number("maxDepth")
        for (t in r.types()) {
            if (!t.isClassLike()) continue
            val depth = Metrics.dit(t)
            if (depth > limit) {
                r.report("medium", t.place, t.module.id, t.id, tx("{0} sits {1} levels deep", t.name, depth),
                    tx("The depth counts base classes in the project; a base outside it is one step. Beyond {0} levels, behavior is spread over many classes. Composition often reads better.",
                        r.limit("maxDepth")), measured("dit", depth, r.threshold("maxDepth")))
            }
        }
    }

    private fun oop003(r: Run) {
        val limit = r.number("minTypeTests")
        for (f in r.functions()) {
            val tested = Metrics.testedTypes(r.p, f)
            if (tested.size >= limit) {
                r.report("medium", f.place, f.module.id, f.id, tx("{0} branches on {1} runtime types", f.name, tested.size),
                    tx("It tests for {0}. A virtual member on their common base would dispatch without the checks.", tested.joinToString(", ") { Graphing.simpleName(it) }),
                    measured("typeTests", tested.size, r.threshold("minTypeTests")))
            }
        }
    }

    private fun oop004(r: Run) {
        val maxLcom = r.number("maxLcom")
        val minMethods = r.number("minMethods")
        for (t in r.types()) {
            if (!t.isClassLike()) continue
            val lcom = Metrics.lcom4(r.p, t) ?: continue
            if (lcom > maxLcom && Metrics.classMethods(t).size >= minMethods) {
                r.report("medium", t.place, t.module.id, t.id, tx("{0} splits into {1} unrelated method groups", t.name, lcom),
                    tx("LCOM4 finds method groups that share no field and do not call each other; each may be a separate class."), measured("lcom4", lcom, r.threshold("maxLcom")))
            }
        }
    }

    private fun oop005(r: Run) {
        val limit = r.number("maxCoupling")
        for (t in r.types()) {
            if (!t.isClassLike()) continue
            val coupling = r.cbo(t)
            if (coupling > limit) {
                r.report("low", t.place, t.module.id, t.id, tx("{0} depends on {1} types", t.name, coupling),
                    tx("Beyond {0} collaborators, changes elsewhere are likely to reach this class.", r.limit("maxCoupling")), measured("cbo", coupling, r.threshold("maxCoupling")))
            }
        }
    }

    // Principles ------------------------------------------------------------------------------------------------------

    private fun prn007(r: Run) {
        val limit = r.number("maxBooleanOperators")
        for (f in r.functions()) {
            val counted = java.util.Collections.newSetFromMap(IdentityHashMap<KtExpression, Boolean>())
            for (n in Metrics.body(f)) {
                val condition = when (n) {
                    is KtIfExpression -> n.condition
                    is KtWhileExpression -> n.condition
                    is KtDoWhileExpression -> n.condition
                    else -> null
                }?.let { Metrics.strip(it) } ?: continue
                if (!counted.add(condition)) continue
                val operators = booleanOperators(condition)
                if (operators > limit) {
                    r.report("medium", f.file.place(condition), f.module.id, f.id, tx("Condition combines {0} boolean operators", operators),
                        tx("More than {0} operators in one condition; named intermediate values or a predicate method would state the intent.", r.limit("maxBooleanOperators")))
                }
            }
        }
    }

    private fun booleanOperators(node: KtElement): Int {
        if (Metrics.isLambda(node)) return 0
        return (if (Metrics.isShortCircuit(node)) 1 else 0) + Metrics.children(node).sumOf { booleanOperators(it) }
    }

    // Security --------------------------------------------------------------------------------------------------------

    val SECRET_NAME = Regex("password|passwd|pwd|secret|api_?key|apikey|access_?token|auth_?token|private_?key", RegexOption.IGNORE_CASE)
    val KNOWN_CREDENTIAL = Regex("AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|sk-[A-Za-z0-9]{32,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[baprs]-[A-Za-z0-9-]{10,}")
    val SQL_TEXT = Regex("\\b(SELECT\\s[\\s\\S]+\\sFROM|INSERT\\s+INTO|UPDATE\\s[\\s\\S]+\\sSET|DELETE\\s+FROM|DROP\\s+TABLE)\\b", RegexOption.IGNORE_CASE)

    /** The function whose declaration holds an offset, or an empty entity. */
    private fun ownerOf(r: Run, m: Module, f: SourceFile, node: KtElement): String {
        val at = node.textRange.startOffset
        var best: Fn? = null
        for (fn in r.p.moduleFunctions(m)) {
            if (fn.file !== f) continue
            val range = fn.decl.textRange
            if (range.startOffset <= at && at <= range.endOffset && (best == null || range.startOffset >= best.decl.textRange.startOffset)) best = fn
        }
        return best?.id ?: ""
    }

    /** The text of a string literal without templates, or null. */
    private fun literalText(e: KtExpression?): String? {
        val x = Metrics.strip(e) as? KtStringTemplateExpression ?: return null
        if (x.hasInterpolation()) return null
        return x.entries.joinToString("") { it.text }
    }

    private fun sec001(r: Run) {
        for (m in r.p.modules) {
            for (f in m.files) {
                for (n in Metrics.walk(f.kt)) {
                    when {
                        n is KtProperty && n.initializer != null -> checkSecret(r, m, f, n.name ?: "", n.initializer, ownerOf(r, m, f, n))
                        n is KtParameter && n.defaultValue != null -> checkSecret(r, m, f, n.name ?: "", n.defaultValue, ownerOf(r, m, f, n))
                        n is KtBinaryExpression && n.operationToken == KtTokens.EQ -> {
                            val target = Metrics.strip(n.left)
                            val name = when (target) {
                                is KtNameReferenceExpression -> target.getReferencedName()
                                is KtQualifiedExpression -> (target.selectorExpression as? KtNameReferenceExpression)?.getReferencedName() ?: ""
                                else -> ""
                            }
                            if (name.isNotEmpty()) checkSecret(r, m, f, name, n.right, ownerOf(r, m, f, n))
                        }
                        n is KtBinaryExpression && n.operationReference.getReferencedName() == "to" -> {
                            val key = literalText(n.left)
                            if (key != null) checkSecret(r, m, f, key, n.right, ownerOf(r, m, f, n))
                        }
                        n is KtCallExpression && Metrics.calleeName(n) == "put" && n.valueArguments.size == 2 -> {
                            val key = literalText(n.valueArguments[0].getArgumentExpression())
                            if (key != null) checkSecret(r, m, f, key, n.valueArguments[1].getArgumentExpression(), ownerOf(r, m, f, n))
                        }
                    }
                }
            }
        }
    }

    private fun checkSecret(r: Run, m: Module, f: SourceFile, name: String, value: KtExpression?, entity: String) {
        val text = literalText(value) ?: return
        if (text.length < 6) return
        val place = f.place(Metrics.strip(value)!!)
        if (KNOWN_CREDENTIAL.containsMatchIn(text)) {
            r.report("high", place, m.id, entity, tx("{0} holds what looks like a real credential", name),
                tx("Heuristic: the literal matches the format of a known key or token. Rotate it if it is real, and load it from a secret store."), null, "critical")
        } else if (SECRET_NAME.containsMatchIn(name) && !Regex("[ {]").containsMatchIn(text)) {
            r.report("medium", place, m.id, entity, tx("{0} looks like a hardcoded secret", name),
                tx("Heuristic: the name suggests a secret and the value is a literal. It may be a placeholder or a non-secret value."))
        }
    }

    /** The text of a constant string: a literal without templates or a const val of the project; null otherwise. */
    private fun constantText(r: Run, e: KtExpression?): String? {
        val x = Metrics.strip(e)
        literalText(x)?.let { return it }
        if (x is KtConstantExpression) return ""
        val ref = (if (x is KtQualifiedExpression) x.selectorExpression else x)?.let { r.p.resolver.refs[it] } as? Ref.Prop ?: return null
        if (ref.member.kind != "constant") return null
        return literalText(ref.member.initializer) ?: ""
    }

    private fun plusParts(e: KtExpression?, out: MutableList<KtExpression?>) {
        val x = Metrics.strip(e)
        if (x is KtBinaryExpression && x.operationToken == KtTokens.PLUS) {
            plusParts(x.left, out)
            plusParts(x.right, out)
        } else {
            out.add(x)
        }
    }

    private fun sec003(r: Run) {
        for (m in r.p.modules) {
            for (f in r.p.moduleFunctions(m)) {
                val inner = java.util.Collections.newSetFromMap(IdentityHashMap<KtElement, Boolean>())
                for (n in Metrics.body(f)) {
                    if (n in inner) continue
                    var text: String? = null
                    var dynamic = false
                    if (n is KtStringTemplateExpression && n.hasInterpolation() && n.parent !is KtBinaryExpression) {
                        text = n.entries.filter { it.expression == null }.joinToString("") { it.text }
                        dynamic = true
                    } else if (n is KtBinaryExpression && n.operationToken == KtTokens.PLUS) {
                        val parts = ArrayList<KtExpression?>()
                        plusParts(n, parts)
                        val constant = StringBuilder()
                        var anyString = false
                        for (part in parts) {
                            val s = constantText(r, part)
                            if (s != null) {
                                anyString = anyString || s.isNotEmpty()
                                constant.append(s)
                            } else if (part is KtStringTemplateExpression) {
                                anyString = true
                                dynamic = true
                                constant.append(part.entries.filter { it.expression == null }.joinToString("") { it.text })
                            } else {
                                dynamic = true
                            }
                        }
                        if (!anyString) continue
                        text = constant.toString()
                        for (x in Metrics.walk(n)) if (x !== n) inner.add(x)
                    } else if (n is KtCallExpression) {
                        val name = Metrics.calleeName(n)
                        val receiver = Metrics.receiverOf(n)
                        if (name == "format" && receiver?.text == "String" && n.valueArguments.isNotEmpty()) {
                            text = constantText(r, n.valueArguments[0].getArgumentExpression())
                            dynamic = n.valueArguments.size > 1
                        } else if (name == "format" && receiver != null && constantText(r, receiver) != null) {
                            text = constantText(r, receiver)
                            dynamic = n.valueArguments.isNotEmpty()
                        }
                    }
                    if (text != null && dynamic && SQL_TEXT.containsMatchIn(text)) {
                        r.report("medium", f.file.place(n), m.id, f.id, tx("SQL built from non-constant values"),
                            tx("Heuristic: if any value comes from a user, this allows injection. Parameterized queries keep data out of the statement."))
                    }
                }
            }
        }
    }

    // Structural ------------------------------------------------------------------------------------------------------

    private fun str002(r: Run) {
        for (m in r.p.modules) {
            if (!r.applies(m)) continue
            for (x in m.properties) {
                if (x.isFinal || x.kind == "constant" || x.visibility == "private") continue
                r.report("high", x.place, m.id, if (m.id == Project.GLOBAL) x.name else "${m.id}.${x.name}", tx("Global variable {0}", x.name),
                    tx("Any function can change it, so its value depends on the call history."))
            }
            for (t in m.types) {
                for (x in t.members) {
                    if ((x.kind != "field" && x.kind != "property") || x.isFinal || x.visibility == "private" || !(x.isStatic || t.kind == "object")) continue
                    if (x.kind == "field") {
                        r.report("high", x.place, m.id, t.id, tx("Global mutable field {0}.{1}", t.name, x.name), tx("A non-private static mutable field is shared by all code and threads."))
                    } else {
                        r.report("high", x.place, m.id, t.id, tx("Global mutable property {0}.{1}", t.name, x.name), tx("A static settable property is shared by all code and threads."))
                    }
                }
            }
        }
    }

    private fun str003(r: Run) {
        val maxModule = r.number("maxModuleLines")
        val maxFile = r.number("maxFileLines")
        for (m in r.p.modules) {
            if (!r.applies(m)) continue
            if (m.loc() > maxModule && m.files.isNotEmpty()) {
                r.report("high", filePlace(m.files[0].path), m.id, "", tx("Module {0} has {1} lines of code", m.id, m.loc()),
                    tx("The limit is {0}; a smaller module is easier to understand as a unit.", r.limit("maxModuleLines")), measured("loc", m.loc(), r.threshold("maxModuleLines")))
            }
            for (f in m.files) {
                if (f.lines > maxFile) {
                    r.report("high", filePlace(f.path), "", "", tx("{0} has {1} lines", f.path, f.lines), tx("The limit is {0}.", r.limit("maxFileLines")),
                        measured("lines", f.lines, r.threshold("maxFileLines")))
                }
            }
        }
    }

    // Maintainability -------------------------------------------------------------------------------------------------

    private fun mnt001(r: Run) {
        val limit = r.number("maxComplexity")
        for (f in r.functions()) {
            val complexity = Metrics.cyclomatic(f)
            if (!f.hasBody || complexity <= limit) continue
            r.report("high", f.place, f.module.id, f.id, tx("{0} has cyclomatic complexity {1}", f.name, complexity),
                tx("The count is exact; above {0}, the number of paths to test and to understand grows quickly.", r.limit("maxComplexity")),
                measured("cyclomatic", complexity, r.threshold("maxComplexity")), if (complexity > limit * 2) "major" else null)
        }
    }

    private fun mnt002(r: Run) {
        val limit = r.number("minIndex")
        for (f in r.functions()) {
            val index = Metrics.maintainabilityIndex(f)
            if (!f.hasBody || index == null || index >= limit) continue
            r.report("medium", f.place, f.module.id, f.id, tx("{0} has a maintainability index of {1}", f.name, Text.fixed(index, 0)),
                tx("Below {0}. The formula is an empirical blend of size and complexity, useful for ranking rather than as a measure of quality.", r.limit("minIndex")),
                measured("maintainabilityIndex", Text.round(index, 4), r.threshold("minIndex")))
        }
    }

    private fun normalized(f: SourceFile, ids: MutableMap<String, Int>): List<IntArray> = f.tokens.filter { it.line !in f.importLines }.map { t ->
        val text = when (t.kind) {
            TokenKind.NAME -> "\$id"
            TokenKind.LITERAL -> "\$lit"
            else -> t.text
        }
        intArrayOf(ids.getOrPut(text) { ids.size + 1 }, t.line)
    }

    private fun mnt003(r: Run) {
        val window = r.number("minTokens").toInt()
        val base = 1000003L
        val modulus = 1000000007L
        val ids = HashMap<String, Int>()
        val files = ArrayList<SourceFile>()
        val streams = ArrayList<List<IntArray>>()
        for (f in r.p.files) {
            val tokens = normalized(f, ids)
            if (tokens.size >= window && window > 0) {
                files.add(f)
                streams.add(tokens)
            }
        }
        var power = 1L
        for (i in 1 until window) power = power * base % modulus
        val seen = HashMap<Long, MutableList<IntArray>>()
        for (index in files.indices) {
            val tokens = streams[index]
            var h = 0L
            for (i in 0 until window) h = (h * base + tokens[i][0]) % modulus
            var skipUntil = 0
            var at = 0
            while (at + window <= tokens.size) {
                if (at > 0) {
                    h = (h - tokens[at - 1][0] * power % modulus + modulus) % modulus
                    h = (h * base + tokens[at + window - 1][0]) % modulus
                }
                if (at >= skipUntil) {
                    for (earlier in seen[h] ?: emptyList<IntArray>()) {
                        val other = streams[earlier[0]]
                        var length = 0
                        while (earlier[1] + length < other.size && at + length < tokens.size && other[earlier[1] + length][0] == tokens[at + length][0]) length++
                        if (length < window || (earlier[0] == index && earlier[1] + length > at)) continue
                        skipUntil = at + length
                        val place = Place(files[index].path, tokens[at][1], 1, tokens[at + length - 1][1], 1)
                        r.report("high", place, "", "", tx("{0} tokens duplicate {1}:{2}", length, files[earlier[0]].path, other[earlier[1]][1]),
                            tx("The token sequences are identical after replacing identifiers and literals with placeholders."), measured("cloneTokens", length, r.threshold("minTokens")))
                        break
                    }
                }
                seen.getOrPut(h) { ArrayList() }.add(intArrayOf(index, at))
                at++
            }
        }
    }

    private fun mnt004(r: Run) {
        val coverage = r.coverage ?: return
        val limit = r.number("minCoverage")
        val report = r.config.threshold(r.rule, "report")
        for (f in r.p.files) {
            val percent = coverage.percent(f.path) ?: continue
            if (percent < limit) {
                r.report("high", filePlace(f.path), "", "", tx("{0} has {1}% line coverage", f.path, Text.fixed(percent, 0)),
                    tx("Measured from {0}; below the {1}% minimum. Coverage shows what ran, not what was verified.", report?.toString() ?: "", r.limit("minCoverage")),
                    measured("coverage", percent, r.threshold("minCoverage")))
            }
        }
    }

    // Order -----------------------------------------------------------------------------------------------------------

    fun sort(findings: List<Finding>): List<Finding> {
        val seen = HashSet<String>()
        val unique = findings.filter { f ->
            seen.add("${f.rule}\u0000${f.place.file}\u0000${f.place.startLine}\u0000${f.place.startColumn}\u0000${f.place.endLine}\u0000${f.place.endColumn}\u0000${f.message}")
        }
        return unique.sortedWith(compareBy<Finding>({ it.place.file }, { it.place.startLine }, { it.place.startColumn }, { it.rule }, { it.message }))
    }
}
