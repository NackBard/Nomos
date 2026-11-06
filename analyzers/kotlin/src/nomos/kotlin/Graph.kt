package nomos.kotlin

import org.jetbrains.kotlin.com.intellij.psi.PsiElement
import org.jetbrains.kotlin.psi.KtAnnotationEntry
import org.jetbrains.kotlin.psi.KtClassOrObject
import org.jetbrains.kotlin.psi.KtConstructorDelegationCall
import org.jetbrains.kotlin.psi.KtDelegatedSuperTypeEntry
import org.jetbrains.kotlin.psi.KtSuperTypeCallEntry
import org.jetbrains.kotlin.psi.KtElement
import org.jetbrains.kotlin.psi.KtFunctionType
import org.jetbrains.kotlin.psi.KtNullableType
import org.jetbrains.kotlin.psi.KtQualifiedExpression
import org.jetbrains.kotlin.psi.KtSuperTypeListEntry
import org.jetbrains.kotlin.psi.KtTypeReference
import org.jetbrains.kotlin.psi.KtUserType

/** One occurrence of a dependency between units, or an import between modules. Every Kotlin edge is runtime. */
data class Edge(val from: String, val to: String, val kind: String, val external: Boolean, val stdlib: Boolean, val toType: Boolean, val place: Place)

class Graph {
    val next = sortedMapOf<String, java.util.TreeSet<String>>()
    val prev = sortedMapOf<String, java.util.TreeSet<String>>()

    fun node(n: String) {
        next.getOrPut(n) { java.util.TreeSet() }
        prev.getOrPut(n) { java.util.TreeSet() }
    }

    fun edge(a: String, b: String) {
        node(a)
        node(b)
        next.getValue(a).add(b)
        prev.getValue(b).add(a)
    }
}

class Graphs {
    val units = Graph()
    val modules = Graph()
    val moduleOf = HashMap<String, Module>()
    val radius = HashMap<String, Int>()
}

/** Dependency edges by spec/metrics.md, the unit and module graphs, cycles and blast radius. */
object Graphing {
    fun collect(p: Project): List<Edge> {
        val edges = ArrayList<Edge>()
        for (m in p.modules) {
            for (f in m.files) edges.addAll(importEdges(p, m, f))
            for (t in m.types) Collector(p, t.id, t.file, t, null, edges).unit(t.decl)
            for (fn in m.functions) Collector(p, fn.id, fn.file, null, fn, edges).unit(fn.decl)
        }
        return edges
    }

    private class Collector(val p: Project, val unit: String, val f: SourceFile, val type: TypeUnit?, val topFunction: Fn?, val edges: MutableList<Edge>) {
        private var fn: Fn? = topFunction

        fun unit(root: KtElement) = visit(root)

        private fun record(target: Target, kind: String, where: PsiElement) {
            val place = f.place(where.textRange.startOffset, where.textRange.endOffset)
            val to = target.unit?.id ?: target.name
            if (to == unit) return
            edges.add(Edge(unit, to, kind, target.unit == null, target.unit == null && target.stdlib, true, place))
        }

        private fun recordFn(target: Fn, where: PsiElement) {
            if (target.unitId() == unit) return
            edges.add(Edge(unit, target.unitId(), "call", false, false, target.owner != null, f.place(where.textRange.startOffset, where.textRange.endOffset)))
        }

        private fun visit(e: PsiElement) {
            if (e is KtClassOrObject && e !== type?.decl && p.typeOfDecl.containsKey(e)) return // a member type is a unit of its own
            val own = p.fnOfDecl[e]
            val outer = fn
            if (own != null) fn = own
            try {
                when (e) {
                    is KtSuperTypeListEntry -> {
                        // The constructor call of the base is part of the declaration: inheritance only, as in C#.
                        e.typeReference?.let { typeReference(it, "inheritance") }
                        (e as? KtSuperTypeCallEntry)?.valueArgumentList?.let { visit(it) }
                        (e as? KtDelegatedSuperTypeEntry)?.delegateExpression?.let { visit(it) }
                        return
                    }
                    is KtTypeReference -> {
                        typeReference(e, "type-ref")
                        return
                    }
                    is KtConstructorDelegationCall -> {
                        val base = type?.superclass
                        if (e.isCallToThis.not() && !e.isImplicit && base != null) record(Target(base, base.id, false), "call", e)
                    }
                    is KtQualifiedExpression -> {
                        // A type name before a static member or a call is a qualifier, not a dependency of its own.
                        val receiver = e.receiverExpression
                        val qualifier = p.resolver.refs[last(receiver)] is Ref.TypeName && e.selectorExpression?.let { p.resolver.refs[it] } != null
                        if (qualifier) {
                            e.selectorExpression?.let { visit(it) }
                            return
                        }
                    }
                    is KtElement -> reference(e)
                    else -> {}
                }
                var c = e.firstChild
                while (c != null) {
                    visit(c)
                    c = c.nextSibling
                }
            } finally {
                fn = outer
            }
        }

        private fun last(e: PsiElement?): PsiElement? = if (e is KtQualifiedExpression) e.selectorExpression else e

        private fun reference(e: KtElement) {
            when (val ref = p.resolver.refs[e] ?: return) {
                is Ref.Call -> recordFn(ref.fn, e)
                is Ref.Ctor -> record(ref.target, "call", e)
                is Ref.External -> record(ref.target, "call", e)
                is Ref.TypeName -> record(ref.target, "type-ref", e)
                is Ref.Prop -> {
                    val owner = ref.member.owner ?: return
                    val static = !ref.instance && (ref.member.isStatic || ref.member.kind == "constant" || ref.member.kind == "literal" || owner.kind == "object")
                    record(Target(owner, owner.id, false), if (static) "call" else "type-ref", e)
                }
                else -> {}
            }
        }

        /** A type as written: the named type, its arguments and the parts of a function type. */
        private fun typeReference(ref: KtTypeReference, kind: String) {
            for (a in ref.annotationEntries) annotation(a)
            var element = ref.typeElement
            while (element is KtNullableType) element = element.innerType
            when (element) {
                is KtUserType -> {
                    p.resolver.userType(f, type ?: fn?.owner, fn, element)?.let { record(it, kind, element) }
                    for (arg in element.typeArguments) arg.typeReference?.let { typeReference(it, "type-ref") }
                }
                is KtFunctionType -> {
                    element.receiverTypeReference?.let { typeReference(it, "type-ref") }
                    for (param in element.parameters) param.typeReference?.let { typeReference(it, "type-ref") }
                    element.returnTypeReference?.let { typeReference(it, "type-ref") }
                }
                else -> {}
            }
        }

        private fun annotation(a: KtAnnotationEntry) {
            a.typeReference?.let { typeReference(it, "type-ref") }
            a.valueArgumentList?.let { visit(it) }
        }
    }

    // Imports ---------------------------------------------------------------------------------------------------------

    private fun importEdges(p: Project, m: Module, f: SourceFile): List<Edge> {
        val edges = ArrayList<Edge>()
        for (imp in f.kt.importDirectives) {
            val path = imp.importPath ?: continue
            val fq = path.fqName.asString()
            var target: String
            var external = true
            if (path.isAllUnder) {
                target = fq
                if (p.byId.containsKey(fq)) external = false
                else p.types[fq]?.let { target = it.module.id; external = false }
            } else {
                val type = p.types[fq]
                val owner = p.byId[fq.substringBeforeLast('.', "")]
                val name = fq.substringAfterLast('.')
                if (type != null) {
                    target = type.module.id
                    external = false
                } else if (owner != null && (owner.functions.any { it.name == name } || owner.properties.any { it.name == name })) {
                    target = owner.id
                    external = false
                } else {
                    target = packageOfName(fq)
                    if (p.byId.containsKey(target)) external = false
                }
            }
            if (target == m.id || target.isEmpty()) continue
            edges.add(Edge(m.id, target, "import", external, external && Resolver.isStdlibName("$target."), false, f.place(imp)))
        }
        return edges
    }

    /** The package of a name: the segments before the first that starts with a capital; a lowercase name drops its last. */
    fun packageOfName(name: String): String {
        val parts = name.split(".")
        val kept = ArrayList<String>()
        for (part in parts) {
            if (part.isNotEmpty() && part[0].isUpperCase()) break
            kept.add(part)
        }
        if (kept.size == parts.size && parts.size > 1) kept.removeAt(kept.size - 1)
        return kept.joinToString(".")
    }

    // Graphs ----------------------------------------------------------------------------------------------------------

    fun build(p: Project, edges: List<Edge>): Graphs {
        val g = Graphs()
        for (m in p.modules) {
            g.modules.node(m.id)
            for (t in m.types) {
                g.moduleOf[t.id] = m
                g.units.node(t.id)
            }
            for (fn in m.functions) {
                g.moduleOf[fn.id] = m
                g.units.node(fn.id)
            }
        }
        for (e in edges) {
            if (e.external) continue
            if (e.kind == "import") {
                g.modules.edge(e.from, e.to)
                continue
            }
            g.units.edge(e.from, e.to)
            val a = g.moduleOf[e.from]
            val b = g.moduleOf[e.to]
            if (a != null && b != null && a !== b) g.modules.edge(a.id, b.id)
        }
        for (unit in g.units.next.keys) g.radius[unit] = reach(g.units, unit)
        return g
    }

    private fun reach(g: Graph, start: String): Int {
        val seen = hashSetOf(start)
        val queue = ArrayDeque(listOf(start))
        while (queue.isNotEmpty()) {
            val current = queue.removeFirst()
            for (dependent in g.prev[current] ?: emptySet<String>()) if (seen.add(dependent)) queue.add(dependent)
        }
        return seen.size - 1
    }

    /** Strongly connected components with two or more members (Tarjan), iteratively. */
    fun components(g: Graph): List<List<String>> {
        val index = HashMap<String, Int>()
        val low = HashMap<String, Int>()
        val onStack = HashSet<String>()
        val stack = ArrayDeque<String>()
        val result = ArrayList<List<String>>()
        var counter = 0
        for (start in g.next.keys) {
            if (start in index) continue
            val work = ArrayDeque<Pair<String, ArrayDeque<String>>>()
            fun enter(n: String) {
                index[n] = counter
                low[n] = counter
                counter++
                stack.addLast(n)
                onStack.add(n)
                work.addLast(n to ArrayDeque(g.next.getValue(n)))
            }
            enter(start)
            while (work.isNotEmpty()) {
                val (node, successors) = work.last()
                if (successors.isNotEmpty()) {
                    val successor = successors.removeFirst()
                    if (successor !in index) enter(successor)
                    else if (successor in onStack) low[node] = minOf(low.getValue(node), index.getValue(successor))
                    continue
                }
                work.removeLast()
                if (work.isNotEmpty()) {
                    val parent = work.last().first
                    low[parent] = minOf(low.getValue(parent), low.getValue(node))
                }
                if (low[node] != index[node]) continue
                val component = ArrayList<String>()
                while (true) {
                    val member = stack.removeLast()
                    onStack.remove(member)
                    component.add(member)
                    if (member == node) break
                }
                if (component.size > 1) {
                    component.sort()
                    result.add(component)
                }
            }
        }
        result.sortBy { it[0] }
        return result
    }

    fun simpleName(id: String): String = id.substringAfterLast('.')
}
