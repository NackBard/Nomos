package nomos.kotlin

import org.jetbrains.kotlin.com.intellij.psi.PsiElement
import org.jetbrains.kotlin.lexer.KtTokens
import org.jetbrains.kotlin.psi.KtArrayAccessExpression
import org.jetbrains.kotlin.psi.KtBinaryExpression
import org.jetbrains.kotlin.psi.KtBlockExpression
import org.jetbrains.kotlin.psi.KtBreakExpression
import org.jetbrains.kotlin.psi.KtCallExpression
import org.jetbrains.kotlin.psi.KtClassOrObject
import org.jetbrains.kotlin.psi.KtConstantExpression
import org.jetbrains.kotlin.psi.KtContinueExpression
import org.jetbrains.kotlin.psi.KtDoWhileExpression
import org.jetbrains.kotlin.psi.KtExpression
import org.jetbrains.kotlin.psi.KtForExpression
import org.jetbrains.kotlin.psi.KtIfExpression
import org.jetbrains.kotlin.psi.KtLambdaExpression
import org.jetbrains.kotlin.psi.KtNameReferenceExpression
import org.jetbrains.kotlin.psi.KtNamedFunction
import org.jetbrains.kotlin.psi.KtObjectLiteralExpression
import org.jetbrains.kotlin.psi.KtProperty
import org.jetbrains.kotlin.psi.KtQualifiedExpression
import org.jetbrains.kotlin.psi.KtReturnExpression
import org.jetbrains.kotlin.psi.KtStringTemplateExpression
import org.jetbrains.kotlin.psi.KtThrowExpression
import org.jetbrains.kotlin.psi.KtWhenExpression
import org.jetbrains.kotlin.psi.KtWhileExpression

/** n^degree · log^l n, or exponential. */
data class Growth(val degree: Int, val log: Int, val exponential: Boolean, val uncertain: Boolean) {
    fun uncertain(value: Boolean) = copy(uncertain = value)
}

/** Time estimates of spec/metrics.md. */
object Estimate {
    val CONSTANT = Growth(0, 0, false, false)
    val LINEAR = Growth(1, 0, false, false)
    val LOGARITHMIC = Growth(0, 1, false, false)

    fun times(a: Growth, b: Growth) = Growth(a.degree + b.degree, a.log + b.log, a.exponential || b.exponential, a.uncertain || b.uncertain)

    fun larger(a: Growth, b: Growth): Growth {
        val pickB = (b.exponential != a.exponential && b.exponential) ||
            (b.exponential == a.exponential && (b.degree > a.degree || (b.degree == a.degree && b.log > a.log)))
        return (if (pickB) b else a).uncertain(a.uncertain || b.uncertain)
    }

    fun text(g: Growth): String {
        if (g.exponential) return "O(2ⁿ)"
        val parts = ArrayList<String>()
        when {
            g.degree == 1 -> parts.add("n")
            g.degree == 2 -> parts.add("n²")
            g.degree == 3 -> parts.add("n³")
            g.degree > 3 -> parts.add("n^${g.degree}")
        }
        if (g.log == 1) parts.add("log n") else if (g.log > 1) parts.add("log^${g.log} n")
        return if (parts.isEmpty()) "O(1)" else "O(${parts.joinToString(" ")})"
    }

    val SORTS = setOf("sorted", "sortedBy", "sortedByDescending", "sortedWith", "sortedDescending", "sort", "sortBy", "sortWith", "sortDescending", "sortByDescending")
    /** Library operations that walk the whole receiver (spec/metrics.md, Kotlin). */
    val LINEAR_OPS = setOf("filter", "filterNot", "filterIsInstance", "filterNotNull", "filterIndexed", "map", "mapNotNull", "mapIndexed", "flatMap", "flatten",
        "forEach", "forEachIndexed", "onEach", "reduce", "fold", "sum", "sumOf", "count", "any", "all", "none", "find", "findLast", "contains", "containsAll",
        "indexOf", "lastIndexOf", "indexOfFirst", "indexOfLast", "joinToString", "toList", "toMutableList", "toSet", "toMutableSet", "toHashSet", "toMap",
        "toMutableMap", "toTypedArray", "associate", "associateBy", "associateWith", "groupBy", "partition", "zip", "distinct", "distinctBy", "reversed",
        "max", "min", "maxOf", "minOf", "maxBy", "minBy", "maxByOrNull", "minByOrNull", "maxOrNull", "minOrNull", "average", "chunked", "windowed",
        "remove", "removeAll", "retainAll", "removeIf", "copyOf", "fill", "shuffled", "union", "intersect", "subtract", "minus")
    /** Linear only with a predicate: first() is constant, first { … } is a search. */
    val SEARCHES = setOf("first", "last", "firstOrNull", "lastOrNull", "single", "singleOrNull")
    val SETS = setOf("Set", "MutableSet", "HashSet", "LinkedHashSet", "SortedSet", "TreeSet") + Resolver.MAPS

    fun selfCalls(p: Project, f: Fn): List<KtCallExpression> = Metrics.body(f).filterIsInstance<KtCallExpression>().filter { Metrics.callee(p, it) === f }

    /** Estimates every function with a body in ordinal id order: mutual recursion is cut at the function still being estimated. */
    fun all(p: Project): Map<String, Growth> {
        val e = Estimator(p)
        val result = HashMap<String, Growth>()
        for (f in p.allFunctions()) if (f.hasBody) result[f.id] = e.estimate(f)
        return result
    }

    private fun isLiteral(e: KtExpression?, value: Double): Boolean {
        val x = Metrics.strip(e) as? KtConstantExpression ?: return false
        return x.text.replace("_", "").trimEnd('L', 'l', 'u', 'U').toDoubleOrNull() == value
    }

    private fun infix(b: KtBinaryExpression): String = b.operationReference.getReferencedName()

    fun dividesByTwo(n: PsiElement?): Boolean {
        for (c in Metrics.walk(n)) {
            if (c !is KtBinaryExpression) continue
            if (c.operationToken == KtTokens.DIV && isLiteral(c.right, 2.0)) return true
            if ((infix(c) == "shr" || infix(c) == "ushr") && isLiteral(c.right, 1.0)) return true
        }
        return false
    }

    /** A step that divides or multiplies a counter: /=, *=, or i = i / 2, i = i shr 1. */
    fun isHalving(n: PsiElement): Boolean {
        if (n !is KtBinaryExpression) return false
        return when (n.operationToken) {
            KtTokens.DIVEQ, KtTokens.MULTEQ -> true
            KtTokens.EQ -> dividesByTwo(n.right) || (Metrics.strip(n.right) as? KtBinaryExpression)?.let { infix(it) == "shl" || it.operationToken == KtTokens.MUL } == true
            else -> false
        }
    }

    /** 0..9, 0 until 10, 10 downTo 0, 0..<10: both bounds literal. */
    fun literalRange(e: KtExpression?): Boolean {
        val x = Metrics.strip(e)
        if (x is KtBinaryExpression) {
            val op = infix(x)
            if (x.operationToken == KtTokens.RANGE || x.operationToken == KtTokens.RANGE_UNTIL || op == "until" || op == "downTo" || op == "step") {
                if (op == "step") return literalRange(x.left)
                return Metrics.isLiteralNumber(x.left) && Metrics.isLiteralNumber(x.right)
            }
        }
        return false
    }

    /** listOf(1, 2), arrayOf("a"), setOf(…) with literal elements, or a string literal: a collection of constant size. */
    fun constantCollection(e: KtExpression?): Boolean {
        val x = Metrics.strip(e)
        if (x is KtStringTemplateExpression) return !x.hasInterpolation()
        if (x is KtCallExpression && Metrics.calleeName(x) in setOf("listOf", "setOf", "arrayOf", "sequenceOf", "mutableListOf", "intArrayOf")) {
            return x.valueArguments.all { Metrics.strip(it.getArgumentExpression()).let { a -> a is KtConstantExpression || (a is KtStringTemplateExpression && !a.hasInterpolation()) } }
        }
        return false
    }

    fun canComplete(body: List<KtExpression>): Boolean {
        val last = body.lastOrNull() ?: return true
        if (last is KtBlockExpression) return canComplete(last.statements)
        return !(last is KtReturnExpression || last is KtThrowExpression || last is KtBreakExpression || last is KtContinueExpression)
    }

    fun statements(e: KtExpression?): List<KtExpression> = when (e) {
        null -> emptyList()
        is KtBlockExpression -> e.statements
        else -> listOf(e)
    }

    /** The library operation a call is: "linear", "sort" or null. */
    fun library(p: Project, call: KtCallExpression): String? {
        if (Metrics.callee(p, call) != null) return null
        val name = Metrics.calleeName(call)
        val receiver = Metrics.receiverOf(call) ?: return null
        val type = p.resolver.exprTypes[receiver]
        if (type?.unit != null && !type.static) return null
        if (name in SORTS) return "sort"
        val withLambda = call.lambdaArguments.isNotEmpty() || call.valueArguments.any { it.getArgumentExpression() is KtLambdaExpression }
        if (name in SEARCHES) return if (withLambda) "linear" else null
        if ((name == "contains" || name == "remove") && type?.simple in SETS) return null
        return if (name in LINEAR_OPS) "linear" else null
    }

    private class Estimator(val p: Project) {
        val memo = HashMap<Fn, Growth>()
        val active = HashSet<Fn>()
        var elements = HashSet<String>()

        fun estimate(f: Fn): Growth {
            memo[f]?.let { return it }
            if (!f.hasBody || f in active) return CONSTANT
            active.add(f)
            val outer = elements
            elements = HashSet()
            val growth = combine(f, f.body.fold(CONSTANT) { g, b -> larger(g, cost(b)) })
            elements = outer
            active.remove(f)
            memo[f] = growth
            return growth
        }

        fun block(nodes: List<PsiElement>): Growth = nodes.fold(CONSTANT) { g, n -> larger(g, cost(n)) }

        fun children(n: PsiElement) = block(Metrics.children(n))

        fun cost(n: PsiElement?): Growth {
            if (n == null) return CONSTANT
            if (n is KtClassOrObject) return CONSTANT
            when (n) {
                is KtForExpression -> {
                    val header = cost(n.loopRange)
                    val walk = isElementWalk(n.loopRange) || constantCollection(n.loopRange) || literalRange(n.loopRange)
                    val added = ArrayList<String>()
                    val param = n.loopParameter
                    val names = param?.destructuringDeclaration?.entries?.mapNotNull { it.name } ?: listOfNotNull(param?.name)
                    for (name in names) if (elements.add(name)) added.add(name)
                    val iteration = cost(n.body)
                    elements.removeAll(added.toSet())
                    return larger(header, times(if (walk) CONSTANT else LINEAR, iteration))
                }
                is KtWhileExpression -> return times(whileFactor(n.body), larger(cost(n.body), cost(n.condition)))
                is KtDoWhileExpression -> return times(whileFactor(n.body), larger(cost(n.body), cost(n.condition)))
                is KtProperty -> if (n.initializer != null && isElementWalk(n.initializer)) {
                    n.name?.let { elements.add(it) }
                    return cost(n.initializer)
                }
                is KtQualifiedExpression -> {
                    val selector = n.selectorExpression
                    if (selector is KtCallExpression) return call(selector, cost(n.receiverExpression))
                }
                is KtCallExpression -> return call(n, CONSTANT)
                is KtBinaryExpression -> if (n.operationToken == KtTokens.IN_KEYWORD || n.operationToken == KtTokens.NOT_IN) {
                    val right = p.resolver.exprTypes[n.right]
                    val parts = larger(cost(n.left), cost(n.right))
                    val linear = right != null && right.unit == null && right.simple in Resolver.COLLECTIONS && right.simple !in SETS
                    return if (linear) larger(parts, LINEAR) else parts
                }
            }
            return children(n)
        }

        fun isElementWalk(e: KtExpression?): Boolean = when (val x = Metrics.strip(e)) {
            is KtNameReferenceExpression -> x.getReferencedName() in elements
            is KtQualifiedExpression -> isElementWalk(x.receiverExpression)
            is KtArrayAccessExpression -> isElementWalk(x.arrayExpression)
            is KtCallExpression -> false
            else -> false
        }

        fun lambda(l: KtLambdaExpression): Growth {
            val names = if (l.valueParameters.isEmpty()) listOf("it") else l.valueParameters.flatMap { param ->
                param.destructuringDeclaration?.entries?.mapNotNull { it.name } ?: listOfNotNull(param.name)
            }
            val added = names.filter { elements.add(it) }
            val g = cost(l.bodyExpression)
            elements.removeAll(added.toSet())
            return g
        }

        fun call(call: KtCallExpression, receiver: Growth): Growth {
            var parts = receiver
            var lambda = CONSTANT
            for (a in call.valueArguments) {
                val x = a.getArgumentExpression()
                if (x is KtLambdaExpression) lambda = larger(lambda, lambda(x)) else parts = larger(parts, cost(x))
            }
            val target = Metrics.callee(p, call)
            if (target != null) {
                var callee = estimate(target)
                if (callee.degree > 0 || callee.log > 0 || callee.exponential) callee = callee.uncertain(true)
                return larger(larger(parts, lambda), callee)
            }
            if (Metrics.calleeName(call) == "repeat" && Metrics.receiverOf(call) == null && p.resolver.refs[call] == null) {
                val count = call.valueArguments.firstOrNull()?.getArgumentExpression()
                return larger(parts, times(if (Metrics.isLiteralNumber(count)) CONSTANT else LINEAR, lambda))
            }
            return when (library(p, call)) {
                "sort" -> larger(parts, Growth(1, 1, false, false))
                "linear" -> larger(parts, times(LINEAR, lambda))
                else -> larger(parts, lambda)
            }
        }

        fun whileFactor(body: PsiElement?): Growth {
            val halves = Metrics.walk(body).any { isHalving(it) }
            return (if (halves) LOGARITHMIC else LINEAR).uncertain(true)
        }

        fun combine(f: Fn, work: Growth): Growth {
            val own = selfCalls(p, f)
            if (own.isEmpty()) return work
            val halfNames = HashSet<String>()
            var memoized = false
            for (n in Metrics.body(f)) {
                if (n is KtProperty && n.initializer != null && dividesByTwo(n.initializer)) n.name?.let { halfNames.add(it) }
                if (n is KtBinaryExpression && n.operationToken == KtTokens.EQ && n.left is KtNameReferenceExpression && dividesByTwo(n.right)) {
                    halfNames.add((n.left as KtNameReferenceExpression).getReferencedName())
                }
                if (n is KtCallExpression) {
                    val name = Metrics.calleeName(n)
                    if (name == "containsKey" || name == "getOrPut" || name == "computeIfAbsent") memoized = true
                    if (name == "get" && Metrics.receiverOf(n)?.let { p.resolver.exprTypes[it]?.simple } in Resolver.MAPS) memoized = true
                }
                if (n is KtArrayAccessExpression && p.resolver.exprTypes[n.arrayExpression]?.simple in Resolver.MAPS) memoized = true
                if (n is KtBinaryExpression && n.operationToken == KtTokens.IN_KEYWORD && p.resolver.exprTypes[n.right]?.simple in SETS) memoized = true
            }
            var halving = false
            var decrements = false
            for (call in own) {
                for (a in call.valueArguments) {
                    val argument = a.getArgumentExpression()
                    for (c in Metrics.walk(argument)) {
                        if (c is KtNameReferenceExpression && c.getReferencedName() in halfNames) halving = true
                        if (c is KtBinaryExpression && (c.operationToken == KtTokens.MINUS || c.operationToken == KtTokens.PLUS)) decrements = true
                    }
                    halving = halving || dividesByTwo(argument)
                }
            }
            val perPath = f.body.sumOf { b -> if (b is KtBlockExpression) callsOnPathBlock(f, b.statements) else callsOnPath(f, b) }
            val recursion = when {
                perPath <= 1 && halving -> LOGARITHMIC
                perPath <= 1 -> LINEAR
                halving -> LINEAR
                memoized || !decrements -> LINEAR
                else -> Growth(0, 0, true, false)
            }
            val total = when {
                perPath > 1 && halving -> times(larger(work, LINEAR), LOGARITHMIC)
                !halving && !decrements -> larger(work, LINEAR)
                else -> times(recursion, work)
            }
            return total.uncertain(true)
        }

        fun callsOnPath(f: Fn, n: PsiElement?): Int {
            if (n == null) return 0
            when (n) {
                is KtBlockExpression -> return callsOnPathBlock(f, n.statements)
                is KtIfExpression -> return callsOnPath(f, n.condition) + maxOf(callsOnPathBlock(f, statements(n.then)), callsOnPathBlock(f, statements(n.`else`)))
                is KtWhenExpression -> {
                    val subject = callsOnPath(f, n.subjectVariable ?: n.subjectExpression)
                    val most = n.entries.maxOfOrNull { entry -> entry.conditions.sumOf { callsOnPath(f, it) } + callsOnPath(f, entry.expression) } ?: 0
                    return subject + most
                }
                is KtLambdaExpression, is KtObjectLiteralExpression -> return 0
                is KtNamedFunction -> return 0
            }
            var count = if (n is KtCallExpression && Metrics.callee(p, n) === f) 1 else 0
            for (c in Metrics.children(n)) count += callsOnPath(f, c)
            return count
        }

        fun callsOnPathBlock(f: Fn, statements: List<KtExpression>): Int {
            val first = statements.firstOrNull() ?: return 0
            val rest = statements.drop(1)
            if (first is KtIfExpression && first.`else` == null && !canComplete(statements(first.then))) {
                return callsOnPath(f, first.condition) + maxOf(callsOnPathBlock(f, statements(first.then)), callsOnPathBlock(f, rest))
            }
            return callsOnPath(f, first) + callsOnPathBlock(f, rest)
        }
    }
}
