package nomos.kotlin

import org.jetbrains.kotlin.com.intellij.psi.PsiErrorElement
import org.jetbrains.kotlin.lexer.KtTokens
import org.jetbrains.kotlin.psi.KtBinaryExpression
import org.jetbrains.kotlin.psi.KtCallExpression
import org.jetbrains.kotlin.psi.KtClass
import org.jetbrains.kotlin.psi.KtClassOrObject
import org.jetbrains.kotlin.psi.KtExpression
import org.jetbrains.kotlin.psi.KtIfExpression
import org.jetbrains.kotlin.psi.KtLambdaExpression
import org.jetbrains.kotlin.psi.KtNameReferenceExpression
import org.jetbrains.kotlin.psi.KtNamedFunction
import org.jetbrains.kotlin.psi.KtObjectLiteralExpression
import org.jetbrains.kotlin.psi.KtQualifiedExpression
import org.jetbrains.kotlin.psi.KtUnaryExpression
import org.jetbrains.kotlin.psi.KtUserType
import org.jetbrains.kotlin.psi.KtValueArgument
import org.jetbrains.kotlin.psi.KtWhenExpression

/** Paradigm evidence of spec/paradigms.md and the conservative definition of a pure function. */
object Paradigms {
    val ACTIVATING = setOf("oop.classes", "str.free-functions", "str.control-flow", "fp.higher-order", "fp.pure-functions")

    fun active(evidence: List<Map<String, Any?>>): List<String> =
        evidence.filter { it["kind"] in ACTIVATING }.map { it["paradigm"] as String }.toSortedSet().toList()

    private fun add(result: MutableList<Map<String, Any?>>, paradigm: String, kind: String, description: String, ids: List<String>, count: Int? = null) {
        val n = count ?: ids.size
        if (n == 0) return
        result.add(Json.of("paradigm" to paradigm, "kind" to kind, "count" to n, "description" to description, "examples" to ids.toSortedSet().take(5)))
    }

    private fun isState(m: Member) = (m.kind == "field" || m.kind == "property") && !m.isStatic

    fun hasMutableInstanceState(t: TypeUnit) = t.members.any { isState(it) && !it.isFinal }

    fun isImmutable(t: TypeUnit) = t.members.any { isState(it) } && !hasMutableInstanceState(t)

    fun hasControlFlow(f: Fn) = Metrics.body(f).any { it is KtIfExpression || Metrics.isLoop(it) || it is KtWhenExpression }

    fun evidence(p: Project, m: Module, pure: Set<Fn>): List<Map<String, Any?>> {
        val result = ArrayList<Map<String, Any?>>()
        val classes = ArrayList<String>()
        val mutable = ArrayList<String>()
        val inheriting = ArrayList<String>()
        val abstractions = ArrayList<String>()
        val immutable = ArrayList<String>()
        val shared = ArrayList<String>()
        for (t in m.types) {
            if (t.isClassLike()) {
                if (t.members.isNotEmpty() || t.methods.isNotEmpty()) classes.add(t.id)
                if (hasMutableInstanceState(t)) mutable.add(t.id)
                if (isImmutable(t)) immutable.add(t.id)
                if (t.superclass != null) inheriting.add(t.id)
            }
            if (t.isAbstract) abstractions.add(t.id)
            for (x in t.members) if ((x.kind == "field" || x.kind == "property") && !x.isFinal && (x.isStatic || t.kind == "object")) shared.add("${t.id}.${x.name}")
        }
        for (x in m.properties) if (!x.isFinal && x.kind != "constant") shared.add(if (m.id == Project.GLOBAL) x.name else "${m.id}.${x.name}")
        add(result, "oop", "oop.classes", "classes with methods or fields", classes)
        add(result, "oop", "oop.mutable-state-classes", "classes with mutable instance state", mutable)
        add(result, "oop", "oop.inheritance", "project types inheriting project types", inheriting)
        add(result, "oop", "oop.abstractions", "interfaces and abstract classes", abstractions)

        val flow = ArrayList<String>()
        val higher = ArrayList<String>()
        val pureIds = ArrayList<String>()
        val lambdaOwners = ArrayList<String>()
        for (f in p.moduleFunctions(m)) {
            if (f.hasBody && hasControlFlow(f)) flow.add(f.id)
            if (Metrics.hofOrder(p, f) > 1) higher.add(f.id)
            if (f in pure) pureIds.add(f.id)
            for (n in Metrics.body(f)) if (n is KtLambdaExpression && n.parent.let { it is KtValueArgument || it?.parent is KtValueArgument }) lambdaOwners.add(f.id)
        }
        add(result, "structural", "str.free-functions", "functions outside types", m.functions.map { it.id })
        add(result, "structural", "str.control-flow", "functions with branches or loops", flow)
        add(result, "structural", "str.global-state", "module-level variables and static mutable state", shared)
        add(result, "functional", "fp.lambdas", "lambdas passed as arguments", lambdaOwners, lambdaOwners.size)
        add(result, "functional", "fp.higher-order", "functions taking or returning functions", higher)
        add(result, "functional", "fp.pure-functions", "functions that provably have no effects (conservative)", pureIds)
        add(result, "functional", "fp.immutable-types", "types without mutable state", immutable)
        result.sortBy { it["kind"] as String }
        return result
    }

    // Pure functions --------------------------------------------------------------------------------------------------

    /** The conservative definition of spec/paradigms.md as a greatest fixed point. */
    fun pure(p: Project): Set<Fn> {
        val candidates = HashMap<Fn, List<Fn>>()
        for (f in p.allFunctions()) {
            if (!f.hasBody || (f.kind != "method" && f.kind != "function")) continue
            val callees = ArrayList<Fn>()
            if (locallyPure(p, f, callees)) candidates[f] = callees
        }
        var changed = true
        while (changed) {
            changed = false
            for (f in candidates.keys.toList()) {
                if (candidates.getValue(f).all { it in candidates }) continue
                candidates.remove(f)
                changed = true
            }
        }
        return candidates.keys
    }

    private fun isOwnVariable(p: Project, target: KtExpression?): Boolean {
        val x = Metrics.strip(target) as? KtNameReferenceExpression ?: return false
        return p.resolver.refs[x] is Ref.Local
    }

    private val MATH = setOf("kotlin.math", "java.lang.Math", "java.lang.StrictMath", "kotlin.math.MathKt")
    private val ALWAYS = setOf("maxOf", "minOf")

    private fun isReadOnly(m: Member) = m.isFinal || m.kind == "constant" || m.kind == "literal"

    /** The root of a chain of member reads: `a` in `a.b.c`. */
    private fun root(e: KtExpression?): KtExpression? {
        var x = Metrics.strip(e)
        while (x is KtQualifiedExpression) x = Metrics.strip(x.receiverExpression)
        return x
    }

    private fun locallyPure(p: Project, f: Fn, callees: MutableList<Fn>): Boolean {
        val r = p.resolver
        for (n in Metrics.body(f)) {
            if (n is KtObjectLiteralExpression || n is KtClassOrObject || n.children.any { it is PsiErrorElement }) return false
            if (n is KtNamedFunction && n.name != null) return false
            if (n is KtBinaryExpression && n.operationToken in KtTokens.ALL_ASSIGNMENTS && !isOwnVariable(p, n.left)) return false
            if (n is KtUnaryExpression && (n.operationToken == KtTokens.PLUSPLUS || n.operationToken == KtTokens.MINUSMINUS) && !isOwnVariable(p, n.baseExpression)) return false
            if (n is KtNameReferenceExpression && n.parent !is KtUserType) {
                val parent = n.parent
                val selector = parent is KtQualifiedExpression && parent.selectorExpression === n
                val callee = parent is KtCallExpression && parent.calleeExpression === n
                when (val ref = r.refs[n]) {
                    is Ref.Prop -> {
                        if (isReadOnly(ref.member)) continue
                        if (ref.instance && selector && isOwnVariable(p, root(parent.receiverExpression))) continue
                        return false
                    }
                    null -> if (!selector && !callee && n.getReferencedName() != "it") return false
                    else -> {}
                }
            }
            if (n is KtCallExpression && !callAllowed(p, f, n, callees)) return false
        }
        return true
    }

    private fun callAllowed(p: Project, f: Fn, call: KtCallExpression, callees: MutableList<Fn>): Boolean {
        val r = p.resolver
        when (val ref = r.refs[call]) {
            is Ref.Call -> {
                callees.add(ref.fn)
                return true
            }
            is Ref.Ctor -> {
                if (ref.target.name == "kotlin.String") return true
                val t = ref.target.unit ?: return false
                val k = t.decl as? KtClass ?: return false
                return k.getAnonymousInitializers().isEmpty() && k.secondaryConstructors.isEmpty()
            }
            is Ref.External -> return ref.target.name in MATH || ref.target.name == "kotlin.String"
            null -> {}
            else -> return false
        }
        val name = Metrics.calleeName(call)
        val receiver = Metrics.receiverOf(call)
        if (receiver == null) {
            if (name in ALWAYS) return true
            val imported = f.file.imports[name] ?: return false
            return imported.startsWith("kotlin.math.")
        }
        val type = r.exprTypes[receiver]
        return type?.simple == "String"
    }
}
