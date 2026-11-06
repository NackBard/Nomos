package nomos.kotlin

import org.jetbrains.kotlin.psi.KtPropertyAccessor
import org.jetbrains.kotlin.psi.KtTypeReference

/** Structure of types and functions for facts 1.3.0, as spec/structure.md defines it for Kotlin. */
object Structure {
    /** A type as written, line breaks and runs of spaces collapsed. */
    fun typeText(ref: KtTypeReference?): String? = ref?.text?.replace(Regex("\\s+"), " ")?.trim()?.takeIf { it.isNotEmpty() }

    /** The project type a member is about and whether it holds a collection of it; T? is T. */
    fun target(type: KType?): Pair<String?, Boolean> {
        if (type == null) return null to false
        type.unit?.let { return it.id to false }
        val name = type.simple ?: return null to false
        if (name in Resolver.COLLECTIONS && type.args.isNotEmpty()) return type.args.last()?.unit?.id to true
        return null to false
    }

    fun members(p: Project, t: TypeUnit): List<Map<String, Any?>> = t.members.map { m ->
        val entry = Json.of("name" to m.name, "kind" to m.kind, "visibility" to m.visibility)
        if (m.kind != "literal") {
            typeText(m.typeRef)?.let { entry["typeName"] = it }
            val (target, collection) = target(p.resolver.memberType(m))
            if (target != null) entry["type"] = target
            if (m.isStatic) entry["isStatic"] = true
            if (collection) entry["isCollection"] = true
        }
        entry
    }

    fun parameters(f: Fn): List<Map<String, Any?>> = f.parameters.map { v ->
        val entry = Json.of("name" to (v.name ?: "_"))
        typeText(v.typeReference)?.let { entry["typeName"] = if (v.isVarArg) "vararg $it" else it }
        entry
    }

    fun returnTypeName(f: Fn): String? {
        if (f.kind == "constructor") return null
        val accessor = f.decl as? KtPropertyAccessor
        val ref = if (accessor != null) (if (accessor.isGetter) accessor.typeReference ?: accessor.property.typeReference else null) else f.returnType
        val text = typeText(ref)
        return if (text == null || text == "Unit") null else text
    }
}
