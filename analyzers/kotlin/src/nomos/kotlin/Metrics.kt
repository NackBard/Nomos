package nomos.kotlin

import org.jetbrains.kotlin.com.intellij.psi.PsiElement
import org.jetbrains.kotlin.lexer.KtTokens
import org.jetbrains.kotlin.psi.KtBinaryExpression
import org.jetbrains.kotlin.psi.KtCallExpression
import org.jetbrains.kotlin.psi.KtCatchClause
import org.jetbrains.kotlin.psi.KtConstantExpression
import org.jetbrains.kotlin.psi.KtDoWhileExpression
import org.jetbrains.kotlin.psi.KtElement
import org.jetbrains.kotlin.psi.KtExpression
import org.jetbrains.kotlin.psi.KtForExpression
import org.jetbrains.kotlin.psi.KtFunctionType
import org.jetbrains.kotlin.psi.KtIfExpression
import org.jetbrains.kotlin.psi.KtIsExpression
import org.jetbrains.kotlin.psi.KtLambdaExpression
import org.jetbrains.kotlin.psi.KtNameReferenceExpression
import org.jetbrains.kotlin.psi.KtNamedFunction
import org.jetbrains.kotlin.psi.KtNullableType
import org.jetbrains.kotlin.psi.KtObjectLiteralExpression
import org.jetbrains.kotlin.psi.KtParenthesizedExpression
import org.jetbrains.kotlin.psi.KtPrefixExpression
import org.jetbrains.kotlin.psi.KtQualifiedExpression
import org.jetbrains.kotlin.psi.KtTryExpression
import org.jetbrains.kotlin.psi.KtTypeReference
import org.jetbrains.kotlin.psi.KtUserType
import org.jetbrains.kotlin.psi.KtWhenConditionIsPattern
import org.jetbrains.kotlin.psi.KtWhenEntry
import org.jetbrains.kotlin.psi.KtWhenExpression
import org.jetbrains.kotlin.psi.KtWhileExpression

/** Metrics of spec/metrics.md over the Kotlin PSI and the names Resolver found. */
object Metrics {
    /** Every Kotlin element below a root in source order, the root included. */
    fun walk(root: PsiElement?): List<KtElement> {
        val result = ArrayList<KtElement>()
        fun go(e: PsiElement) {
            if (e is KtElement) result.add(e)
            var c = e.firstChild
            while (c != null) {
                go(c)
                c = c.nextSibling
            }
        }
        if (root != null) go(root)
        return result
    }

    /** The elements of a function's code, lambdas and local functions and classes included: they belong to it. */
    fun body(f: Fn): List<KtElement> = f.body.flatMap { walk(it) }

    /** Direct Kotlin children of an element. */
    fun children(root: PsiElement?): List<KtElement> {
        val result = ArrayList<KtElement>()
        var c = root?.firstChild
        while (c != null) {
            if (c is KtElement) result.add(c) else result.addAll(children(c).takeIf { c.firstChild != null } ?: emptyList())
            c = c.nextSibling
        }
        return result
    }

    fun isLoop(e: PsiElement) = e is KtForExpression || e is KtWhileExpression || e is KtDoWhileExpression

    fun isShortCircuit(e: PsiElement) = e is KtBinaryExpression && (e.operationToken == KtTokens.ANDAND || e.operationToken == KtTokens.OROR)

    fun strip(e: KtExpression?): KtExpression? {
        var x = e
        while (x is KtParenthesizedExpression) x = x.expression
        return x
    }

    /** 1 + decision points: if, when conditions except else, loops, catch, && and ||. */
    fun cyclomatic(f: Fn): Int {
        var count = 1
        for (n in body(f)) {
            when {
                n is KtIfExpression || isLoop(n) || n is KtCatchClause || isShortCircuit(n) -> count++
                n is KtWhenEntry && !n.isElse -> count += n.conditions.size
            }
        }
        return count
    }

    fun isNesting(e: PsiElement) = e is KtWhenExpression || isLoop(e) || e is KtTryExpression

    /** Deepest number of enclosing if, when, loop and try; else if stays on its if's level. */
    fun maxNesting(f: Fn): Int {
        if (!f.hasBody) return 0
        val v = object {
            var deepest = 0

            fun visit(n: PsiElement?, d: Int) {
                if (n == null) return
                deepest = maxOf(deepest, d)
                if (n is KtIfExpression) {
                    visitIf(n, d)
                    return
                }
                if (isNesting(n)) {
                    deepest = maxOf(deepest, d + 1)
                    for (c in children(n)) visit(c, d + 1)
                    return
                }
                for (c in children(n)) visit(c, d)
            }

            fun visitIf(s: KtIfExpression, d: Int) {
                visit(s.condition, d)
                visit(s.then, d + 1)
                when (val other = s.`else`) {
                    is KtIfExpression -> visitIf(other, d)
                    null -> {}
                    else -> visit(other, d + 1)
                }
            }
        }
        for (b in f.body) v.visit(b, 0)
        return v.deepest
    }

    fun parameterCount(f: Fn): Int = f.parameters.size

    // Style -----------------------------------------------------------------------------------------------------------

    private val FUNCTIONAL = setOf("Runnable", "Callable", "Comparator", "Supplier", "Consumer", "BiConsumer", "Predicate", "BiPredicate", "Function", "BiFunction",
        "UnaryOperator", "BinaryOperator", "IntFunction", "ToIntFunction", "IntPredicate", "IntUnaryOperator", "IntBinaryOperator") +
        (0..22).map { "Function$it" }

    /** Depth of function types in a type: (A) -> B is 1 + the deepest of A and B; generic arguments add their depth. */
    fun functionDepth(p: Project, f: SourceFile, context: TypeUnit?, fn: Fn?, ref: KtTypeReference?, depth: Int = 0): Int {
        if (ref == null || depth > 10) return 0
        var element = ref.typeElement
        while (element is KtNullableType) element = element.innerType
        return when (element) {
            is KtFunctionType -> {
                var inner = 0
                element.receiverTypeReference?.let { inner = maxOf(inner, functionDepth(p, f, context, fn, it, depth + 1)) }
                for (param in element.parameters) inner = maxOf(inner, functionDepth(p, f, context, fn, param.typeReference, depth + 1))
                inner = maxOf(inner, functionDepth(p, f, context, fn, element.returnTypeReference, depth + 1))
                1 + inner
            }
            is KtUserType -> {
                var inner = 0
                for (a in element.typeArguments) inner = maxOf(inner, functionDepth(p, f, context, fn, a.typeReference, depth + 1))
                val target = p.resolver.userType(f, context, fn, element)
                val functional = target?.unit?.isFunInterface == true || (target?.unit == null && element.referencedName in FUNCTIONAL && target != null)
                if (functional) 1 + inner else inner
            }
            else -> 0
        }
    }

    /** 1 + the deepest function type in the parameters and the result. */
    fun hofOrder(p: Project, f: Fn): Int {
        var depth = 0
        for (param in f.parameters) depth = maxOf(depth, functionDepth(p, f.file, f.owner, f, param.typeReference))
        val result = f.returnType
        depth = if (result != null) maxOf(depth, functionDepth(p, f.file, f.owner, f, result))
        else if (f.kind != "constructor" && p.resolver.returnType(f)?.function == true) maxOf(depth, 1) else depth
        return 1 + depth
    }

    fun isLambda(e: PsiElement) = e is KtLambdaExpression || (e is KtNamedFunction && e.name == null)

    fun lambdaNesting(f: Fn): Int {
        if (!f.hasBody) return 0
        fun depth(n: PsiElement): Int {
            var deepest = 0
            for (c in children(n)) deepest = maxOf(deepest, if (isLambda(c)) 1 + depth(c) else depth(c))
            return deepest
        }
        return f.body.maxOfOrNull { maxOf(if (isLambda(it)) 1 + depth(it) else depth(it)) } ?: 0
    }

    /** Distinct project types a function tests at run time: is and !is, in expressions and when conditions. */
    fun testedTypes(p: Project, f: Fn): List<String> {
        val seen = sortedSetOf<String>()
        for (n in body(f)) {
            val ref = when (n) {
                is KtIsExpression -> n.typeReference
                is KtWhenConditionIsPattern -> n.typeReference
                else -> null
            } ?: continue
            p.resolver.typeOfReference(f.file, f.owner, f, ref)?.unit?.let { seen.add(it.id) }
        }
        return seen.toList()
    }

    // Loops -----------------------------------------------------------------------------------------------------------

    /** Library calls whose lambda runs once per element or per count: the lambda body is a loop body. */
    val LOOP_CALLS = setOf("forEach", "forEachIndexed", "repeat", "onEach")

    fun calleeName(call: KtCallExpression): String = (call.calleeExpression as? KtNameReferenceExpression)?.getReferencedName() ?: ""

    /** Visits every element with the number of loops whose body holds it; loop headers that run once are outside. */
    fun walkLoops(p: Project, f: Fn, visit: (KtElement, Int) -> Unit) {
        if (!f.hasBody) return
        fun go(n: PsiElement?, depth: Int) {
            if (n == null) return
            if (n is KtElement) visit(n, depth)
            when (n) {
                is KtForExpression -> {
                    go(n.loopRange, depth)
                    go(n.loopParameter, depth + 1)
                    go(n.body, depth + 1)
                    return
                }
                is KtWhileExpression -> {
                    go(n.condition, depth + 1)
                    go(n.body, depth + 1)
                    return
                }
                is KtDoWhileExpression -> {
                    go(n.body, depth + 1)
                    go(n.condition, depth + 1)
                    return
                }
                is KtCallExpression -> if (calleeName(n) in LOOP_CALLS && callee(p, n) == null) {
                    go(n.calleeExpression, depth)
                    for (a in n.valueArguments) {
                        val x = a.getArgumentExpression()
                        go(x, if (x is KtLambdaExpression) depth + 1 else depth)
                    }
                    return
                }
            }
            for (c in children(n)) go(c, depth)
        }
        for (b in f.body) go(b, 0)
    }

    val BUILDERS = setOf("listOf", "mutableListOf", "arrayListOf", "setOf", "mutableSetOf", "hashSetOf", "linkedSetOf", "sortedSetOf", "mapOf", "mutableMapOf",
        "hashMapOf", "linkedMapOf", "sortedMapOf", "arrayOf", "arrayOfNulls", "intArrayOf", "longArrayOf", "doubleArrayOf", "floatArrayOf", "charArrayOf",
        "booleanArrayOf", "byteArrayOf", "shortArrayOf", "buildList", "buildSet", "buildMap", "buildString", "lazy")
    val ARRAYS = setOf("Array", "IntArray", "LongArray", "DoubleArray", "FloatArray", "CharArray", "BooleanArray", "ByteArray", "ShortArray", "arrayOfNulls")

    /** Creates an object on the heap: a constructor call, a collection builder, a lambda or an object expression. */
    fun allocates(p: Project, n: PsiElement): Boolean {
        if (isLambda(n) || n is KtObjectLiteralExpression) return true
        if (n !is KtCallExpression) return false
        val ref = p.resolver.refs[n]
        if (ref is Ref.Ctor) return true
        if (ref is Ref.Call || ref is Ref.Local) return false
        val name = calleeName(n)
        return name in BUILDERS || name.firstOrNull()?.isUpperCase() == true
    }

    fun allocationDepth(p: Project, f: Fn): Int {
        var deepest = 0
        walkLoops(p, f) { n, depth -> if (allocates(p, n)) deepest = maxOf(deepest, depth) }
        return deepest
    }

    val GROWING = setOf("add", "addAll", "put", "putAll", "push", "offer", "addFirst", "addLast", "offerFirst", "offerLast", "append", "insert", "putIfAbsent",
        "computeIfAbsent", "getOrPut", "appendLine")

    fun isLiteralNumber(e: KtExpression?): Boolean {
        var x = strip(e)
        if (x is KtPrefixExpression && (x.operationToken == KtTokens.MINUS || x.operationToken == KtTokens.PLUS)) x = strip(x.baseExpression)
        if (x !is KtConstantExpression) return false
        val type = x.node.elementType.toString()
        return type == "INTEGER_CONSTANT" || type == "FLOAT_CONSTANT"
    }

    /** The callee of a call inside the project, or null. */
    fun callee(p: Project, call: KtElement): Fn? = (p.resolver.refs[call] as? Ref.Call)?.fn

    /** The receiver of a call written as a member call (`x.add(…)`), or null. */
    fun receiverOf(call: KtCallExpression): KtExpression? = (call.parent as? KtQualifiedExpression)?.takeIf { it.selectorExpression === call }?.receiverExpression

    /** Dimensions of non-literal size of an array creation: Array(n) { IntArray(m) } has two. */
    fun sizedDimensions(p: Project, call: KtCallExpression): Int {
        val name = calleeName(call)
        if (name !in ARRAYS || p.resolver.refs[call] is Ref.Call) return 0
        val size = call.valueArguments.firstOrNull()?.getArgumentExpression() ?: return 0
        if (isLiteralNumber(size)) return 0
        val init = call.lambdaArguments.firstOrNull()?.getLambdaExpression()?.bodyExpression?.statements?.singleOrNull()
        val inner = (strip(init) as? KtCallExpression)?.let { sizedDimensions(p, it) } ?: 0
        return 1 + inner
    }

    /** Collection growth in loops, arrays of non-literal size, direct recursion. */
    fun spaceDegree(p: Project, f: Fn, selfCalls: Int): Int {
        var degree = 0
        val inner = HashSet<KtCallExpression>()
        walkLoops(p, f) { n, depth ->
            if (n is KtCallExpression && receiverOf(n) != null && calleeName(n) in GROWING && callee(p, n) == null) degree = maxOf(degree, depth)
            if (n is KtBinaryExpression && n.operationToken == KtTokens.PLUSEQ && isMutableCollection(p.resolver.exprTypes[n.left])) degree = maxOf(degree, depth)
            if (n is KtCallExpression && n !in inner) {
                val sized = sizedDimensions(p, n)
                if (sized > 0) {
                    degree = maxOf(degree, depth + sized)
                    n.lambdaArguments.forEach { a -> walk(a).filterIsInstance<KtCallExpression>().forEach { inner.add(it) } }
                }
            }
        }
        if (selfCalls > 0) degree = maxOf(degree, 1)
        return degree
    }

    fun isMutableCollection(t: KType?): Boolean = t?.simple in setOf("MutableList", "ArrayList", "MutableSet", "HashSet", "LinkedHashSet", "MutableCollection",
        "ArrayDeque", "MutableMap", "HashMap", "LinkedHashMap")

    // Cohesion --------------------------------------------------------------------------------------------------------

    /** The instance field or property a reference reads, if it belongs to a project type. */
    fun memberOf(ref: Ref?): Member? {
        val m = (ref as? Ref.Prop)?.member ?: return null
        if (m.owner == null || m.isStatic) return null
        return if (m.kind == "field" || m.kind == "property") m else null
    }

    class Use(val own: Set<Member>, val foreign: Map<String, Set<String>>)

    private val uses = HashMap<Fn, Use>()

    /** Members of its own type a function touches and, by owner, those of other project types reached through a value. */
    fun memberUse(p: Project, f: Fn): Use {
        uses[f]?.let { return it }
        val own = LinkedHashSet<Member>()
        val foreign = sortedMapOf<String, java.util.TreeSet<String>>()
        for (n in body(f)) {
            val ref = p.resolver.refs[n] as? Ref.Prop ?: continue
            val m = memberOf(ref) ?: continue
            if (m.owner === f.owner) own.add(m)
            else if (ref.instance) foreign.getOrPut(m.owner!!.id) { java.util.TreeSet() }.add(m.name)
        }
        val use = Use(own, foreign)
        uses[f] = use
        return use
    }

    fun mostUsedForeign(p: Project, f: Fn): Pair<String, List<String>> {
        val foreign = memberUse(p, f).foreign
        var best = ""
        for ((owner, names) in foreign) {
            // Data classes, objects and enums hold data meant to be read: foreignMembers counts plain classes only (spec/metrics.md).
            val t = p.types.getValue(owner)
            if (t.kind != "class" || t.isData) continue
            if (best.isEmpty() || names.size > foreign.getValue(best).size) best = owner
        }
        return best to (if (best.isEmpty()) emptyList() else foreign.getValue(best).toList())
    }

    fun classMethods(t: TypeUnit): List<Fn> = t.methods.filter { it.kind == "method" && !it.isStatic && it.hasBody }

    fun wmc(t: TypeUnit): Int = t.methods.filter { it.kind != "accessor" }.sumOf { cyclomatic(it) }

    /** Longest chain of base classes; a base outside the project is one step, Any and interfaces do not count. */
    fun dit(t: TypeUnit): Int {
        val seen = HashSet<TypeUnit>()
        var depth = 0
        var x: TypeUnit? = t
        while (x != null && seen.add(x)) {
            if (x.superclass != null || x.externalSuperclass) depth++
            x = x.superclass
        }
        return depth
    }

    fun calledFunctions(p: Project, f: Fn): Set<Fn> = body(f).mapNotNull { callee(p, it) }.toSet()

    fun lcom4(p: Project, t: TypeUnit): Int? {
        val methods = classMethods(t)
        if (methods.isEmpty()) return null
        val parent = IntArray(methods.size) { it }
        fun find(i0: Int): Int {
            var i = i0
            while (parent[i] != i) {
                parent[i] = parent[parent[i]]
                i = parent[i]
            }
            return i
        }
        val uses = methods.map { memberUse(p, it).own }
        val calls = methods.map { calledFunctions(p, it) }
        for (i in methods.indices) for (j in i + 1 until methods.size) {
            if (uses[i].any { it in uses[j] } || methods[j] in calls[i] || methods[i] in calls[j]) parent[find(i)] = find(j)
        }
        return methods.indices.map { find(it) }.toSet().size
    }

    fun tcc(p: Project, t: TypeUnit): Double? {
        val methods = classMethods(t).filter { it.visibility != "private" }
        if (methods.size < 2) return null
        var connected = 0
        for (i in methods.indices) for (j in i + 1 until methods.size) {
            val a = memberUse(p, methods[i]).own
            if (memberUse(p, methods[j]).own.any { it in a }) connected++
        }
        val pairs = methods.size * (methods.size - 1) / 2.0
        return Text.round(connected / pairs, 4)
    }

    fun atfd(p: Project, t: TypeUnit): Int {
        val seen = HashSet<String>()
        for (m in t.methods) for ((owner, names) in memberUse(p, m).foreign) for (n in names) seen.add("$owner.$n")
        return seen.size
    }

    // Halstead --------------------------------------------------------------------------------------------------------

    val SEPARATORS = setOf("(", ")", "{", "}", "[", "]", ";", ",")

    /** N log2 n over the tokens of the lines of a function, without separators. */
    fun halsteadVolume(f: Fn): Double? {
        var total = 0
        val distinct = HashSet<String>()
        for (t in f.file.tokens) {
            if (t.line < f.place.startLine || t.line > f.place.endLine) continue
            if (t.kind == TokenKind.OP && t.text in SEPARATORS) continue
            total++
            distinct.add(t.text)
        }
        if (distinct.size < 2) return null
        return total * (Math.log(distinct.size.toDouble()) / Math.log(2.0))
    }

    fun maintainabilityIndex(f: Fn): Double? {
        val volume = halsteadVolume(f) ?: return null
        val lines = f.place.lines()
        if (lines == 0) return null
        return maxOf(0.0, (171 - 5.2 * Math.log(volume) - 0.23 * cyclomatic(f) - 16.2 * Math.log(lines.toDouble())) * 100 / 171)
    }
}
