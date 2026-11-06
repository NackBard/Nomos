package nomos.kotlin

import java.util.IdentityHashMap
import org.jetbrains.kotlin.com.intellij.psi.PsiElement
import org.jetbrains.kotlin.lexer.KtTokens
import org.jetbrains.kotlin.psi.KtAnnotatedExpression
import org.jetbrains.kotlin.psi.KtArrayAccessExpression
import org.jetbrains.kotlin.psi.KtBinaryExpression
import org.jetbrains.kotlin.psi.KtBinaryExpressionWithTypeRHS
import org.jetbrains.kotlin.psi.KtBlockExpression
import org.jetbrains.kotlin.psi.KtCallExpression
import org.jetbrains.kotlin.psi.KtCallableReferenceExpression
import org.jetbrains.kotlin.psi.KtCatchClause
import org.jetbrains.kotlin.psi.KtClass
import org.jetbrains.kotlin.psi.KtClassLiteralExpression
import org.jetbrains.kotlin.psi.KtClassOrObject
import org.jetbrains.kotlin.psi.KtConstantExpression
import org.jetbrains.kotlin.psi.KtDestructuringDeclaration
import org.jetbrains.kotlin.psi.KtElement
import org.jetbrains.kotlin.psi.KtExpression
import org.jetbrains.kotlin.psi.KtForExpression
import org.jetbrains.kotlin.psi.KtFunctionType
import org.jetbrains.kotlin.psi.KtIfExpression
import org.jetbrains.kotlin.psi.KtLabeledExpression
import org.jetbrains.kotlin.psi.KtLambdaExpression
import org.jetbrains.kotlin.psi.KtNameReferenceExpression
import org.jetbrains.kotlin.psi.KtNamedFunction
import org.jetbrains.kotlin.psi.KtNullableType
import org.jetbrains.kotlin.psi.KtObjectLiteralExpression
import org.jetbrains.kotlin.psi.KtParameter
import org.jetbrains.kotlin.psi.KtParenthesizedExpression
import org.jetbrains.kotlin.psi.KtPostfixExpression
import org.jetbrains.kotlin.psi.KtProperty
import org.jetbrains.kotlin.psi.KtQualifiedExpression
import org.jetbrains.kotlin.psi.KtStringTemplateExpression
import org.jetbrains.kotlin.psi.KtSuperExpression
import org.jetbrains.kotlin.psi.KtThisExpression
import org.jetbrains.kotlin.psi.KtTryExpression
import org.jetbrains.kotlin.psi.KtTypeReference
import org.jetbrains.kotlin.psi.KtUserType
import org.jetbrains.kotlin.psi.KtWhenConditionIsPattern
import org.jetbrains.kotlin.psi.KtWhenExpression

/** A named type: a project type, or a library type known by its qualified name (or the name as written). */
class Target(val unit: TypeUnit?, val name: String, val stdlib: Boolean) {
    val external: Boolean get() = unit == null
}

/**
 * The type of an expression as far as declarations show it. `static` marks a type name used as a value: its
 * companion members, enum entries and nested types are reached through it.
 */
class KType(val target: Target?, val args: List<KType?> = emptyList(), val function: Boolean = false, val static: Boolean = false) {
    val unit: TypeUnit? get() = target?.unit

    /** The simple name of a library type: List, MutableList, String. */
    val simple: String? get() = target?.takeIf { it.unit == null }?.name?.substringAfterLast('.')
}

/** What a name, call or reference in code refers to. */
sealed class Ref {
    class Local(val type: KType?) : Ref()
    /** A property of a project type or of the top level; `instance` when read through a value, not a type name. */
    class Prop(val member: Member, val instance: Boolean) : Ref()
    class Call(val fn: Fn) : Ref()
    class Ctor(val target: Target) : Ref()
    class TypeName(val target: Target) : Ref()
    /** A function or member of a library type named through its type or an import. */
    class External(val target: Target) : Ref()
    object LocalFunction : Ref()
}

/**
 * Name resolution without the compiler's resolver (D-059): type names by nesting, imports, the package, star imports
 * and the default imports of Kotlin; values by local scopes, implicit receivers and declared or created types.
 */
class Resolver(private val p: Project) {
    val refs = IdentityHashMap<KtElement, Ref>()
    val exprTypes = IdentityHashMap<KtExpression, KType>()
    private val returnTypes = HashMap<Fn, KType?>()
    private val memberTypes = HashMap<Member, KType?>()
    private val inProgress = HashSet<Any>()

    // Type names ------------------------------------------------------------------------------------------------------

    fun typeOfReference(file: SourceFile, context: TypeUnit?, fn: Fn?, ref: KtTypeReference?): Target? = ktype(file, context, fn, ref)?.target

    fun ktype(file: SourceFile, context: TypeUnit?, fn: Fn?, ref: KtTypeReference?): KType? {
        var element = ref?.typeElement ?: return null
        while (element is KtNullableType) element = element.innerType ?: return null
        return when (element) {
            is KtFunctionType -> KType(Target(null, "kotlin.Function", true), element.parameters.map { ktype(file, context, fn, it.typeReference) } +
                listOf(ktype(file, context, fn, element.returnTypeReference)), function = true)
            is KtUserType -> {
                val target = userType(file, context, fn, element) ?: return null
                KType(target, element.typeArguments.map { ktype(file, context, fn, it.typeReference) })
            }
            else -> null
        }
    }

    fun userType(file: SourceFile, context: TypeUnit?, fn: Fn?, type: KtUserType): Target? {
        val names = ArrayList<String>()
        var t: KtUserType? = type
        while (t != null) {
            names.add(0, t.referencedName ?: return null)
            t = t.qualifier
        }
        if (names.size == 1 && isTypeParameter(context, fn, names[0])) return null
        return resolveType(file, context, names)
    }

    private fun isTypeParameter(context: TypeUnit?, fn: Fn?, name: String): Boolean {
        if (fn != null && name in fn.typeParameters) return true
        var c = context
        while (c != null) {
            if (name in c.typeParameters) return true
            c = c.outer
        }
        return false
    }

    /** A type name, possibly qualified (`Outer.Inner`, `shop.orders.Cart`), as seen from a file and a type. */
    fun resolveType(file: SourceFile, context: TypeUnit?, names: List<String>): Target? {
        val first = names[0]
        val rest = names.drop(1)
        var c = context
        while (c != null) {
            if (c.name == first && c.outer == null) return nested(Target(c, c.id, false), rest)
            for (t in c.lineage()) t.nested.firstOrNull { it.name == first }?.let { return nested(Target(it, it.id, false), rest) }
            if (c.name == first) return nested(Target(c, c.id, false), rest)
            c = c.outer
        }
        file.imports[first]?.let { return byName((listOf(it) + rest).joinToString(".")) }
        file.module.types.firstOrNull { it.outer == null && it.name == first }?.let { return nested(Target(it, it.id, false), rest) }
        for (star in file.starImports) {
            p.byId[star]?.types?.firstOrNull { it.outer == null && it.name == first }?.let { return nested(Target(it, it.id, false), rest) }
        }
        if (rest.isNotEmpty()) {
            for (cut in names.size downTo 2) {
                val unit = p.types[names.take(cut).joinToString(".")] ?: continue
                return nested(Target(unit, unit.id, false), names.drop(cut))
            }
        }
        DEFAULT_TYPES[first]?.let { return Target(null, (listOf(it) + rest).joinToString("."), true) }
        val written = names.joinToString(".")
        return Target(null, written, isStdlibName(written))
    }

    private fun nested(start: Target, rest: List<String>): Target? {
        var current = start
        for (name in rest) {
            val unit = current.unit
            current = if (unit != null) {
                val inner = unit.lineage().firstNotNullOfOrNull { t -> t.nested.firstOrNull { it.name == name } } ?: return Target(null, "${unit.id}.$name", false)
                Target(inner, inner.id, false)
            } else {
                Target(null, "${current.name}.$name", current.stdlib)
            }
        }
        return current
    }

    /** A qualified name: a project type by id, otherwise a library name. */
    fun byName(fq: String): Target {
        p.types[fq]?.let { return Target(it, it.id, false) }
        return Target(null, fq, isStdlibName(fq))
    }

    // Declared types --------------------------------------------------------------------------------------------------

    fun memberType(m: Member): KType? {
        if (m in memberTypes) return memberTypes[m]
        if (!inProgress.add(m)) return null
        val type = m.typeRef?.let { ktype(m.file, m.owner, null, it) } ?: m.initializer?.let { Walker(m.file, m.owner, null).expr(it) }
        inProgress.remove(m)
        memberTypes[m] = type
        return type
    }

    fun returnType(fn: Fn): KType? {
        if (fn.kind == "constructor") return fn.owner?.let { KType(Target(it, it.id, false)) }
        if (fn in returnTypes) return returnTypes[fn]
        if (!inProgress.add(fn)) return null
        val type = fn.returnType?.let { ktype(fn.file, fn.owner, fn, it) } ?: fn.expressionBody?.let { walker(fn).expr(it) }
        inProgress.remove(fn)
        returnTypes[fn] = type
        return type
    }

    // Values ----------------------------------------------------------------------------------------------------------

    fun resolveAll() {
        for (t in p.allTypes()) {
            val w = Walker(t.file, t, null)
            w.push()
            (t.decl as? KtClass)?.primaryConstructorParameters?.forEach { param -> w.define(param.name, ktype(t.file, t, null, param.typeReference)) }
            for (entry in t.decl.superTypeListEntries) for (e in expressions(entry)) w.expr(e)
            for (m in t.members) {
                when (val d = m.decl) {
                    is KtProperty -> {
                        d.initializer?.let { w.expr(it) }
                        d.delegateExpression?.let { w.expr(it) }
                    }
                    is KtParameter -> d.defaultValue?.let { w.expr(it) }
                    else -> for (e in expressions(d)) w.expr(e)
                }
            }
        }
        for (m in p.modules) for (prop in m.properties) {
            val d = prop.decl as KtProperty
            val w = Walker(prop.file, null, null)
            d.initializer?.let { w.expr(it) }
            d.delegateExpression?.let { w.expr(it) }
        }
        for (fn in p.allFunctions()) {
            val w = walker(fn)
            for (param in fn.parameters) param.defaultValue?.let { w.expr(it) }
            for (b in fn.body) {
                if (b is KtExpression) w.expr(b) else for (e in expressions(b)) w.expr(e)
            }
        }
    }

    private fun walker(fn: Fn): Walker {
        val receiver = fn.receiver?.let { ktype(fn.file, fn.owner, fn, it) }
        val w = Walker(fn.file, fn.owner, fn, receiver, fn.isStatic)
        w.push()
        for (param in fn.parameters) w.define(param.name, paramType(fn.file, fn.owner, fn, param))
        if (fn.kind == "constructor") (fn.owner?.decl as? KtClass)?.primaryConstructorParameters?.forEach { w.define(it.name, ktype(fn.file, fn.owner, fn, it.typeReference)) }
        return w
    }

    private fun paramType(file: SourceFile, owner: TypeUnit?, fn: Fn?, param: KtParameter): KType? {
        val type = ktype(file, owner, fn, param.typeReference) ?: return null
        return if (param.isVarArg) KType(Target(null, "kotlin.Array", true), listOf(type)) else type
    }

    /** Expressions directly below an element that is not itself an expression. */
    private fun expressions(e: PsiElement): List<KtExpression> {
        val result = ArrayList<KtExpression>()
        var c = e.firstChild
        while (c != null) {
            if (c is KtExpression) result.add(c) else if (c !is KtTypeReference) result.addAll(expressions(c))
            c = c.nextSibling
        }
        return result
    }

    /** Members of a type and its project bases a name reaches; static access sees companion members, constants, entries. */
    fun property(unit: TypeUnit, name: String, static: Boolean): Member? {
        for (t in unit.lineage()) {
            for (m in t.members) {
                if (m.name != name) continue
                if (!static || m.isStatic || m.kind == "constant" || m.kind == "literal" || t.kind == "object") return m
            }
        }
        return null
    }

    fun method(unit: TypeUnit, name: String, arity: Int, static: Boolean): Fn? {
        val candidates = unit.lineage().flatMap { t -> t.methods.filter { it.name == name && it.kind == "method" && (!static || it.isStatic || t.kind == "object") } }
        return pick(candidates, arity)
    }

    /** The overload a call takes by its argument count; a reference without arguments (arity -1) takes the first. */
    private fun pick(candidates: List<Fn>, arity: Int): Fn? {
        if (arity < 0) return candidates.firstOrNull()
        return candidates.firstOrNull { it.parameters.size == arity }
            ?: candidates.firstOrNull { f -> f.parameters.size > arity && f.parameters.drop(arity).all { it.hasDefaultValue() } }
            ?: candidates.firstOrNull()
    }

    /** Top-level functions a bare name reaches from a file: its package, explicit imports, star imports of the project. */
    fun topFunction(file: SourceFile, name: String, arity: Int): Fn? {
        val explicit = file.imports[name]
        if (explicit != null) {
            val module = p.byId[explicit.substringBeforeLast('.', Project.GLOBAL)] ?: p.byId[Project.GLOBAL].takeIf { '.' !in explicit }
            val original = explicit.substringAfterLast('.')
            module?.functions?.filter { it.name == original }?.takeIf { it.isNotEmpty() }?.let { return pick(it, arity) }
        }
        file.module.functions.filter { it.name == name }.takeIf { it.isNotEmpty() }?.let { return pick(it, arity) }
        for (star in file.starImports) p.byId[star]?.functions?.filter { it.name == name }?.takeIf { it.isNotEmpty() }?.let { return pick(it, arity) }
        return null
    }

    fun topProperty(file: SourceFile, name: String): Member? {
        val explicit = file.imports[name]
        if (explicit != null) {
            val module = p.byId[explicit.substringBeforeLast('.', "")]
            module?.properties?.firstOrNull { it.name == explicit.substringAfterLast('.') }?.let { return it }
        }
        file.module.properties.firstOrNull { it.name == name }?.let { return it }
        for (star in file.starImports) p.byId[star]?.properties?.firstOrNull { it.name == name }?.let { return it }
        return null
    }

    /** The element type of a collection, array or range type. */
    fun elementType(t: KType?): KType? {
        if (t == null || t.unit != null) return null
        val name = t.simple ?: return null
        if (name in RANGES) return KType(Target(null, "kotlin.Int", true))
        if (name == "String" || name == "CharSequence") return KType(Target(null, "kotlin.Char", true))
        if (name in COLLECTIONS && name !in MAPS) return t.args.lastOrNull()
        return null
    }

    inner class Walker(val file: SourceFile, val owner: TypeUnit?, val fn: Fn?, val extension: KType? = null, val static: Boolean = false) {
        private val scopes = ArrayList<HashMap<String, Ref>>()
        /** Receivers of lambdas with a receiver (apply, run, with), innermost last. */
        private val receivers = ArrayList<KType>()

        fun push() {
            scopes.add(HashMap())
        }

        fun pop() {
            scopes.removeAt(scopes.size - 1)
        }

        fun define(name: String?, type: KType?) {
            if (name == null || name == "_") return
            if (scopes.isEmpty()) push()
            scopes.last()[name] = Ref.Local(type)
        }

        private fun lookup(name: String): Ref? {
            for (i in scopes.indices.reversed()) scopes[i][name]?.let { return it }
            return null
        }

        private fun record(e: KtExpression, type: KType?): KType? {
            if (type != null) exprTypes[e] = type
            return type
        }

        private fun <T> scoped(block: () -> T): T {
            push()
            try {
                return block()
            } finally {
                pop()
            }
        }

        fun expr(e: KtExpression?): KType? {
            if (e == null) return null
            return record(e, compute(e))
        }

        private fun compute(e: KtExpression): KType? = when (e) {
            is KtParenthesizedExpression -> expr(e.expression)
            is KtLabeledExpression -> expr(e.baseExpression)
            is KtAnnotatedExpression -> expr(e.baseExpression)
            is KtConstantExpression -> when (e.node.elementType.toString()) {
                "INTEGER_CONSTANT" -> KType(Target(null, "kotlin.Int", true))
                "BOOLEAN_CONSTANT" -> KType(Target(null, "kotlin.Boolean", true))
                else -> null
            }
            is KtStringTemplateExpression -> {
                for (entry in e.entries) expr(entry.expression)
                STRING
            }
            is KtNameReferenceExpression -> name(e)
            is KtThisExpression -> receivers.lastOrNull() ?: extension ?: owner?.let { KType(Target(it, it.id, false), static = static) }
            is KtSuperExpression -> owner?.superclass?.let { KType(Target(it, it.id, false)) }
            is KtCallExpression -> call(e, null)
            is KtQualifiedExpression -> qualified(e)
            is KtCallableReferenceExpression -> callableReference(e)
            is KtClassLiteralExpression -> {
                e.receiverExpression?.let { expr(it) }
                null
            }
            is KtBlockExpression -> scoped { block(e.statements) }
            is KtProperty -> {
                val type = e.initializer?.let { expr(it) }
                e.delegateExpression?.let { expr(it) }
                define(e.name, e.typeReference?.let { ktype(file, owner, fn, it) } ?: type)
                null
            }
            is KtDestructuringDeclaration -> {
                expr(e.initializer)
                for (entry in e.entries) define(entry.name, entry.typeReference?.let { ktype(file, owner, fn, it) })
                null
            }
            is KtNamedFunction -> {
                define(e.name, null)
                e.name?.let { scopes.last()[it] = Ref.LocalFunction }
                scoped {
                    for (param in e.valueParameters) {
                        param.defaultValue?.let { expr(it) }
                        define(param.name, paramType(file, owner, fn, param))
                    }
                    expr(e.bodyExpression)
                }
                null
            }
            is KtLambdaExpression -> lambda(e, null, null)
            is KtObjectLiteralExpression -> {
                objectBody(e.objectDeclaration)
                null
            }
            is KtIfExpression -> {
                expr(e.condition)
                val then = scoped { expr(e.then) }
                val other = scoped { expr(e.`else`) }
                then ?: other
            }
            is KtWhenExpression -> scoped {
                e.subjectVariable?.let { expr(it) } ?: expr(e.subjectExpression)
                var type: KType? = null
                for (entry in e.entries) {
                    for (condition in entry.conditions) for (x in expressions(condition)) expr(x)
                    val t = scoped { expr(entry.expression) }
                    if (type == null) type = t
                }
                type
            }
            is KtForExpression -> {
                val range = expr(e.loopRange)
                scoped {
                    val param = e.loopParameter
                    val destructuring = param?.destructuringDeclaration
                    if (destructuring != null) {
                        for (entry in destructuring.entries) define(entry.name, null)
                    } else if (param != null) {
                        define(param.name, param.typeReference?.let { ktype(file, owner, fn, it) } ?: elementType(range))
                    }
                    expr(e.body)
                }
                null
            }
            is KtTryExpression -> {
                expr(e.tryBlock)
                for (c in e.catchClauses) catchClause(c)
                e.finallyBlock?.let { expr(it.finalExpression) }
                null
            }
            is KtBinaryExpression -> {
                val left = expr(e.left)
                val right = expr(e.right)
                when (e.operationToken) {
                    KtTokens.ELVIS -> left ?: right
                    KtTokens.PLUS -> if (left?.simple == "String") STRING else null
                    else -> null
                }
            }
            is KtBinaryExpressionWithTypeRHS -> {
                expr(e.left)
                ktype(file, owner, fn, e.right)
            }
            is KtPostfixExpression -> {
                val base = expr(e.baseExpression)
                if (e.operationToken == KtTokens.EXCLEXCL) base else null
            }
            is KtArrayAccessExpression -> {
                val array = expr(e.arrayExpression)
                for (i in e.indexExpressions) expr(i)
                elementType(array) ?: array?.takeIf { it.simple in MAPS }?.args?.lastOrNull()
            }
            else -> {
                for (x in expressions(e)) expr(x)
                null
            }
        }

        private fun block(statements: List<KtExpression>): KType? {
            var last: KType? = null
            for (s in statements) last = expr(s)
            return last
        }

        private fun catchClause(c: KtCatchClause) = scoped {
            val param = c.catchParameter
            define(param?.name, param?.typeReference?.let { ktype(file, owner, fn, it) })
            expr(c.catchBody)
        }

        private fun objectBody(d: KtClassOrObject) {
            for (entry in d.superTypeListEntries) for (x in expressions(entry)) expr(x)
            for (member in d.declarations) {
                when (member) {
                    is KtNamedFunction -> scoped {
                        for (param in member.valueParameters) define(param.name, paramType(file, owner, fn, param))
                        expr(member.bodyExpression)
                    }
                    is KtProperty -> {
                        member.initializer?.let { expr(it) }
                        for (a in member.accessors) scoped { expr(a.bodyExpression) }
                    }
                    else -> for (x in expressions(member)) expr(x)
                }
            }
        }

        /** A lambda; `it` or its first parameter gets the element type, a receiver lambda the receiver. */
        fun lambda(e: KtLambdaExpression, parameter: KType?, receiver: KType?): KType? {
            scoped {
                val params = e.valueParameters
                if (params.isEmpty()) define("it", parameter)
                for ((i, param) in params.withIndex()) {
                    val destructuring = param.destructuringDeclaration
                    if (destructuring != null) for (entry in destructuring.entries) define(entry.name, null)
                    else define(param.name, param.typeReference?.let { ktype(file, owner, fn, it) } ?: parameter.takeIf { i == 0 })
                }
                if (receiver != null) receivers.add(receiver)
                try {
                    expr(e.bodyExpression)
                } finally {
                    if (receiver != null) receivers.removeAt(receivers.size - 1)
                }
            }
            return KType(Target(null, "kotlin.Function", true), function = true)
        }

        /** Implicit receivers of a bare name, innermost first: lambda receivers, the extension receiver, the owner and its outer types. */
        private fun implicit(): List<KType> {
            val result = ArrayList<KType>(receivers.reversed())
            extension?.let { result.add(it) }
            var c = owner
            var first = true
            while (c != null) {
                result.add(KType(Target(c, c.id, false), static = !first || static))
                first = false
                c = c.outer
            }
            return result
        }

        private fun name(e: KtNameReferenceExpression): KType? {
            val name = e.getReferencedName()
            lookup(name)?.let { ref ->
                refs[e] = ref
                return (ref as? Ref.Local)?.type
            }
            for (r in implicit()) {
                val unit = r.unit ?: continue
                val member = property(unit, name, r.static) ?: if (r.static) null else property(unit, name, true)
                if (member != null) {
                    refs[e] = Ref.Prop(member, false)
                    return memberType(member)
                }
            }
            topProperty(file, name)?.let {
                refs[e] = Ref.Prop(it, false)
                return memberType(it)
            }
            if (name.firstOrNull()?.isUpperCase() == true || file.imports.containsKey(name)) {
                val target = resolveType(file, owner, listOf(name))
                if (target != null && (target.unit != null || file.imports.containsKey(name) || DEFAULT_TYPES.containsKey(name))) {
                    refs[e] = Ref.TypeName(target)
                    return KType(target, static = target.unit?.kind != "object")
                }
            }
            return null
        }

        private fun arity(call: KtCallExpression) = call.valueArguments.size

        private fun arguments(call: KtCallExpression, element: KType?, receiver: KType?) {
            for (a in call.valueArguments) {
                val x = a.getArgumentExpression()
                if (x is KtLambdaExpression) record(x, lambda(x, element, receiver)) else expr(x)
            }
        }

        /** A call; `on` is the type of its receiver in a qualified expression. */
        fun call(e: KtCallExpression, on: KType?): KType? {
            val callee = e.calleeExpression
            val name = (callee as? KtNameReferenceExpression)?.getReferencedName()
            if (name == null) {
                expr(callee)
                arguments(e, null, null)
                return null
            }
            if (on != null) return memberCall(e, name, on)
            val local = lookup(name)
            if (local != null) {
                refs[e] = local
                arguments(e, null, null)
                return null
            }
            when (name) {
                "with" -> {
                    val args = e.valueArguments
                    val subject = expr(args.firstOrNull()?.getArgumentExpression())
                    for (a in args.drop(1)) {
                        val x = a.getArgumentExpression()
                        if (x is KtLambdaExpression) record(x, lambda(x, null, subject)) else expr(x)
                    }
                    return null
                }
                "listOf", "mutableListOf", "arrayListOf", "setOf", "mutableSetOf", "hashSetOf", "linkedSetOf", "arrayOf", "emptyList", "emptySet", "sequenceOf" -> {
                    val element = e.typeArguments.firstOrNull()?.typeReference?.let { ktype(file, owner, fn, it) }
                    var first: KType? = null
                    for (a in e.valueArguments) {
                        val t = expr(a.getArgumentExpression())
                        if (first == null) first = t
                    }
                    return KType(Target(null, BUILDERS.getValue(name), true), listOf(element ?: first))
                }
            }
            for (r in implicit()) {
                val unit = r.unit ?: continue
                val target = method(unit, name, arity(e), r.static) ?: if (r.static) null else method(unit, name, arity(e), true)
                if (target != null) {
                    refs[e] = Ref.Call(target)
                    arguments(e, null, null)
                    return returnType(target)
                }
            }
            topFunction(file, name, arity(e))?.let {
                refs[e] = Ref.Call(it)
                arguments(e, null, null)
                return returnType(it)
            }
            val imported = file.imports[name]
            if (name.firstOrNull()?.isUpperCase() == true || imported != null) {
                val target = resolveType(file, owner, listOf(name))
                if (target != null && (target.unit != null || imported != null || DEFAULT_TYPES.containsKey(name))) {
                    val isType = target.unit != null || imported?.substringAfterLast('.')?.firstOrNull()?.isUpperCase() == true || DEFAULT_TYPES.containsKey(name)
                    refs[e] = if (isType) Ref.Ctor(target) else Ref.External(target)
                    arguments(e, null, null)
                    return if (isType) KType(target, e.typeArguments.map { a -> a.typeReference?.let { ktype(file, owner, fn, it) } }) else null
                }
            }
            arguments(e, null, null)
            return null
        }

        private fun memberCall(e: KtCallExpression, name: String, on: KType): KType? {
            val unit = on.unit
            if (unit != null) {
                if (on.static) unit.nested.firstOrNull { it.name == name }?.let {
                    val target = Target(it, it.id, false)
                    refs[e] = Ref.Ctor(target)
                    arguments(e, null, null)
                    return KType(target)
                }
                val target = method(unit, name, arity(e), on.static)
                if (target != null) {
                    refs[e] = Ref.Call(target)
                    arguments(e, null, null)
                    return returnType(target)
                }
                arguments(e, null, null)
                return null
            }
            // A call on a library type known from a declaration belongs to that type, as in Java (spec/metrics.md, Kotlin).
            if (on.target != null && !on.function) refs[e] = Ref.External(on.target)
            val element = elementType(on)
            when (name) {
                "apply", "run" -> {
                    lambdaArgument(e, null, on)
                    return if (name == "apply") on else null
                }
                "also", "let", "takeIf", "takeUnless" -> {
                    lambdaArgument(e, on, null)
                    return if (name == "also" || name.startsWith("take")) on else null
                }
            }
            arguments(e, element, null)
            if (element == null) return null
            return when (name) {
                "first", "last", "single", "firstOrNull", "lastOrNull", "singleOrNull", "find", "findLast", "get", "getOrNull", "elementAt", "random",
                "maxBy", "minBy", "maxByOrNull", "minByOrNull", "maxWith", "minWith", "removeAt", "removeFirst", "removeLast" -> element
                "filter", "filterNot", "sortedBy", "sortedByDescending", "sorted", "sortedDescending", "sortedWith", "reversed", "take", "drop", "takeWhile",
                "dropWhile", "distinct", "distinctBy", "toList", "toMutableList", "asReversed", "subList", "shuffled", "filterNotNull" ->
                    KType(Target(null, "kotlin.collections.List", true), listOf(element))
                "toSet", "toMutableSet", "toHashSet" -> KType(Target(null, "kotlin.collections.Set", true), listOf(element))
                "asSequence" -> KType(Target(null, "kotlin.sequences.Sequence", true), listOf(element))
                else -> null
            }
        }

        private fun lambdaArgument(e: KtCallExpression, parameter: KType?, receiver: KType?) {
            for (a in e.valueArguments) {
                val x = a.getArgumentExpression()
                if (x is KtLambdaExpression) record(x, lambda(x, parameter, receiver)) else expr(x)
            }
        }

        private fun qualified(e: KtQualifiedExpression): KType? {
            val receiver = e.receiverExpression
            val on = packageQualified(receiver) ?: expr(receiver)
            if (on != null) exprTypes[receiver] = on
            return when (val selector = e.selectorExpression) {
                is KtCallExpression -> if (on == null) unknownCall(selector) else call(selector, on)
                is KtNameReferenceExpression -> if (on == null) null else select(selector, on)
                else -> expr(selector)
            }
        }

        /** A call on a receiver of unknown type: only its arguments are resolved. */
        private fun unknownCall(call: KtCallExpression): KType? {
            arguments(call, null, null)
            return null
        }

        /** `shop.orders.Cart` written in code: a qualified type name, when its first segment is no value or type. */
        private fun packageQualified(receiver: KtExpression): KType? {
            val names = dotted(receiver) ?: return null
            if (names.size < 2) return null
            val first = names[0]
            if (lookup(first) != null || first.firstOrNull()?.isUpperCase() == true || file.imports.containsKey(first)) return null
            for (r in implicit()) if (r.unit?.let { property(it, first, r.static) } != null) return null
            if (topProperty(file, first) != null) return null
            for (cut in names.size downTo 2) {
                val unit = p.types[names.take(cut).joinToString(".")] ?: continue
                if (cut != names.size) return null
                refs[last(receiver)] = Ref.TypeName(Target(unit, unit.id, false))
                return KType(Target(unit, unit.id, false), static = unit.kind != "object")
            }
            return null
        }

        private fun last(e: KtExpression): KtElement = if (e is KtQualifiedExpression) e.selectorExpression ?: e else e

        private fun dotted(e: KtExpression?): List<String>? = when (e) {
            is KtNameReferenceExpression -> listOf(e.getReferencedName())
            is KtQualifiedExpression -> {
                val head = dotted(e.receiverExpression)
                val tail = (e.selectorExpression as? KtNameReferenceExpression)?.getReferencedName()
                if (head != null && tail != null) head + tail else null
            }
            else -> null
        }

        private fun select(selector: KtNameReferenceExpression, on: KType): KType? {
            val name = selector.getReferencedName()
            val unit = on.unit ?: return null
            if (on.static) unit.lineage().firstNotNullOfOrNull { t -> t.nested.firstOrNull { it.name == name } }?.let {
                val target = Target(it, it.id, false)
                refs[selector] = Ref.TypeName(target)
                return KType(target, static = it.kind != "object")
            }
            val member = property(unit, name, on.static) ?: return null
            refs[selector] = Ref.Prop(member, !on.static && !member.isStatic && member.kind != "constant" && member.kind != "literal")
            return if (member.kind == "literal") KType(Target(member.owner!!, member.owner.id, false)) else memberType(member)
        }

        private fun callableReference(e: KtCallableReferenceExpression): KType? {
            val receiver = e.receiverExpression
            val on = receiver?.let { packageQualified(it) ?: expr(it) }
            val name = e.callableReference.getReferencedName()
            val unit = on?.unit
            if (unit != null) {
                val target = method(unit, name, -1, false) ?: method(unit, name, -1, true)
                if (target != null) refs[e] = Ref.Call(target)
                else property(unit, name, on.static)?.let { refs[e] = Ref.Prop(it, true) }
            } else if (receiver == null) {
                topFunction(file, name, -1)?.let { refs[e] = Ref.Call(it) }
                    ?: implicit().firstNotNullOfOrNull { r -> r.unit?.let { method(it, name, -1, r.static) } }?.let { refs[e] = Ref.Call(it) }
                    ?: resolveType(file, owner, listOf(name))?.takeIf { it.unit != null }?.let { refs[e] = Ref.Ctor(it) }
            }
            return KType(Target(null, "kotlin.Function", true), function = true)
        }
    }

    companion object {
        val STRING = KType(Target(null, "kotlin.String", true))
        val RANGES = setOf("IntRange", "LongRange", "CharRange", "IntProgression", "ClosedRange")
        val MAPS = setOf("Map", "MutableMap", "HashMap", "LinkedHashMap", "SortedMap", "TreeMap")
        val COLLECTIONS = setOf("List", "MutableList", "ArrayList", "Set", "MutableSet", "HashSet", "LinkedHashSet", "SortedSet", "TreeSet", "Collection",
            "MutableCollection", "Iterable", "MutableIterable", "Sequence", "Array", "ArrayDeque", "Deque", "Queue", "LinkedList", "Iterator", "Stack") + MAPS
        val BUILDERS = mapOf("listOf" to "kotlin.collections.List", "mutableListOf" to "kotlin.collections.MutableList", "arrayListOf" to "kotlin.collections.ArrayList",
            "setOf" to "kotlin.collections.Set", "mutableSetOf" to "kotlin.collections.MutableSet", "hashSetOf" to "kotlin.collections.HashSet",
            "linkedSetOf" to "kotlin.collections.LinkedHashSet", "arrayOf" to "kotlin.Array", "emptyList" to "kotlin.collections.List",
            "emptySet" to "kotlin.collections.Set", "sequenceOf" to "kotlin.sequences.Sequence")

        /** Types of the default imports of Kotlin/JVM by simple name (kotlin.*, kotlin.collections.*, java.lang.*, …). */
        val DEFAULT_TYPES: Map<String, String> = buildMap {
            for (n in listOf("Any", "Nothing", "Unit", "Boolean", "Byte", "Short", "Int", "Long", "Float", "Double", "Char", "String", "Number", "CharSequence",
                "Array", "IntArray", "LongArray", "ByteArray", "ShortArray", "CharArray", "FloatArray", "DoubleArray", "BooleanArray", "UInt", "ULong", "UByte",
                "UShort", "Pair", "Triple", "Comparable", "Comparator", "Throwable", "Exception", "RuntimeException", "Error", "IllegalArgumentException",
                "IllegalStateException", "IndexOutOfBoundsException", "UnsupportedOperationException", "NullPointerException", "ArithmeticException",
                "ClassCastException", "NumberFormatException", "NoSuchElementException", "ConcurrentModificationException", "AssertionError", "Lazy",
                "Result", "Enum", "Annotation", "Function", "Deprecated", "Suppress", "Cloneable", "AutoCloseable", "Nothing", "KotlinVersion",
                "OptIn", "RequiresOptIn", "PublishedApi", "DslMarker", "SinceKotlin")) put(n, "kotlin.$n")
            for (n in listOf("List", "MutableList", "Set", "MutableSet", "Map", "MutableMap", "Collection", "MutableCollection", "Iterable", "MutableIterable",
                "Iterator", "MutableIterator", "ListIterator", "MutableListIterator", "ArrayList", "HashMap", "HashSet", "LinkedHashMap", "LinkedHashSet",
                "ArrayDeque", "AbstractList", "AbstractMap", "AbstractSet", "AbstractCollection", "RandomAccess")) put(n, "kotlin.collections.$n")
            put("Sequence", "kotlin.sequences.Sequence")
            for (n in listOf("StringBuilder", "Regex", "MatchResult", "Appendable", "Charsets", "RegexOption")) put(n, "kotlin.text.$n")
            for (n in listOf("IntRange", "LongRange", "CharRange", "ClosedRange", "IntProgression")) put(n, "kotlin.ranges.$n")
            for (n in listOf("Target", "Retention", "MustBeDocumented", "Repeatable", "AnnotationTarget", "AnnotationRetention")) put(n, "kotlin.annotation.$n")
            for (n in listOf("JvmStatic", "JvmField", "JvmOverloads", "JvmName", "Throws", "Volatile", "Synchronized", "Transient", "Strictfp", "JvmInline",
                "JvmRecord", "JvmSuppressWildcards")) put(n, "kotlin.jvm.$n")
            for (n in listOf("Thread", "Runnable", "Math", "StrictMath", "System", "Class", "Process", "Runtime", "ThreadLocal", "Character", "Integer",
                "Override", "SecurityException", "InterruptedException", "CloneNotSupportedException", "ReflectiveOperationException", "StackOverflowError",
                "OutOfMemoryError", "InheritableThreadLocal", "Iterable", "Void")) putIfAbsent(n, "java.lang.$n")
        }

        fun isStdlibName(fq: String): Boolean = fq.startsWith("kotlin.") || fq.startsWith("kotlinx.") || fq.startsWith("java.") || fq.startsWith("javax.")
    }
}
