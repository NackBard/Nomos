package nomos.kotlin

import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.nio.file.Files
import java.nio.file.Path
import org.jetbrains.kotlin.CoreEnvironmentDeprecation
import org.jetbrains.kotlin.cli.extensionsStorage
import org.jetbrains.kotlin.cli.jvm.compiler.EnvironmentConfigFiles
import org.jetbrains.kotlin.cli.jvm.compiler.KotlinCoreEnvironment
import org.jetbrains.kotlin.com.intellij.openapi.util.Disposer
import org.jetbrains.kotlin.com.intellij.psi.PsiComment
import org.jetbrains.kotlin.com.intellij.psi.PsiElement
import org.jetbrains.kotlin.com.intellij.psi.PsiErrorElement
import org.jetbrains.kotlin.com.intellij.psi.PsiWhiteSpace
import org.jetbrains.kotlin.compiler.plugin.CompilerPluginRegistrar
import org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi
import org.jetbrains.kotlin.config.CompilerConfiguration
import org.jetbrains.kotlin.lexer.KtKeywordToken
import org.jetbrains.kotlin.lexer.KtTokens
import org.jetbrains.kotlin.psi.KtAnnotated
import org.jetbrains.kotlin.psi.KtClass
import org.jetbrains.kotlin.psi.KtClassOrObject
import org.jetbrains.kotlin.psi.KtDeclaration
import org.jetbrains.kotlin.psi.KtElement
import org.jetbrains.kotlin.psi.KtEnumEntry
import org.jetbrains.kotlin.psi.KtFile
import org.jetbrains.kotlin.psi.KtModifierListOwner
import org.jetbrains.kotlin.psi.KtNamedFunction
import org.jetbrains.kotlin.psi.KtObjectDeclaration
import org.jetbrains.kotlin.psi.KtParameter
import org.jetbrains.kotlin.psi.KtPrimaryConstructor
import org.jetbrains.kotlin.psi.KtProperty
import org.jetbrains.kotlin.psi.KtPropertyAccessor
import org.jetbrains.kotlin.psi.KtPsiFactory
import org.jetbrains.kotlin.psi.KtSecondaryConstructor
import org.jetbrains.kotlin.psi.KtStringTemplateExpression
import org.jetbrains.kotlin.psi.KtSuperTypeCallEntry
import org.jetbrains.kotlin.psi.KtTypeReference

/**
 * Everything loaded from a root: the PSI of every file from the parser of the Kotlin compiler, without resolution
 * (D-059). Names are resolved by Resolver over the declarations of the project; library types are known by name only.
 */
class Project(root: Path) {
    val root: Path = root.toAbsolutePath().normalize()
    val files = ArrayList<SourceFile>()
    val modules = ArrayList<Module>()
    val byId = HashMap<String, Module>()
    val types = sortedMapOf<String, TypeUnit>()
    val functions = sortedMapOf<String, Fn>()
    val notes = ArrayList<Map<String, Any?>>()
    private val ids = HashSet<String>()
    val typeOfDecl = HashMap<KtClassOrObject, TypeUnit>()
    val fnOfDecl = HashMap<KtElement, Fn>()
    val memberOfDecl = HashMap<KtElement, Member>()
    lateinit var resolver: Resolver

    fun relative(full: Path): String = root.relativize(full.toAbsolutePath().normalize()).toString().replace('\\', '/')

    fun load(include: List<String>, exclude: List<String>) {
        val found = ArrayList<Path>()
        walk(root, include, exclude, found)
        found.sortWith { a, b -> relative(a).compareTo(relative(b)) }
        for (full in found) files.add(SourceFile(relative(full), readSource(full)))
        if (files.isNotEmpty()) parse()
        for (f in files) {
            val id = if (f.packageName.isEmpty()) GLOBAL else f.packageName
            val m = byId.getOrPut(id) { Module(id).also { modules.add(it) } }
            m.files.add(f)
            f.module = m
        }
        modules.sortBy { it.id }
        for (f in files) declare(f)
        resolver = Resolver(this)
        for (t in types.values) link(t)
        resolver.resolveAll()
    }

    private fun walk(folder: Path, include: List<String>, exclude: List<String>, found: MutableList<Path>) {
        val entries = try {
            Files.list(folder).use { it.toList() }
        } catch (e: java.io.IOException) {
            return
        }.sortedBy { it.fileName.toString() }
        for (full in entries) {
            val name = full.fileName.toString()
            if (Files.isDirectory(full)) {
                if (name in SKIPPED_FOLDERS || name.startsWith(".")) continue
                walk(full, include, exclude, found)
            } else if (name.endsWith(".kt") && Files.isRegularFile(full)) {
                val rel = relative(full)
                if ((include.isEmpty() || anyGlob(include, rel)) && !anyGlob(exclude, rel)) found.add(full)
            }
        }
    }

    // Parsing ----------------------------------------------------------------------------------------------------------

    @OptIn(CompilerConfiguration.Internals::class, CoreEnvironmentDeprecation::class, ExperimentalCompilerApi::class)
    private fun parse() {
        val disposable = Disposer.newDisposable()
        val config = CompilerConfiguration()
        config.extensionsStorage = CompilerPluginRegistrar.ExtensionStorage()
        val environment = KotlinCoreEnvironment.createForProduction(disposable, config, EnvironmentConfigFiles.JVM_CONFIG_FILES)
        val factory = KtPsiFactory(environment.project, false)
        for ((i, f) in files.withIndex()) {
            // The name only labels the PSI file; it never reaches the facts.
            f.kt = factory.createFile("nomos$i.kt", f.text)
            f.broken = hasError(f.kt)
            scan(f, f.kt)
            val code = BooleanArray(f.lineStarts.size + 2)
            for (t in f.tokens) for (l in t.line..t.endLine) code[l] = true
            f.loc = code.count { it }
            for (c in f.comments) f.directives.add(c.text, c.startLine, c.endLine)
            f.packageName = f.kt.packageFqName.asString()
            f.kt.packageDirective?.let { if (it.textLength > 0) lines(f, it) }
            for (imp in f.kt.importDirectives) {
                lines(f, imp)
                val path = imp.importPath ?: continue
                val fq = path.fqName.asString()
                if (path.isAllUnder) f.starImports.add(fq)
                else f.imports[path.importedName?.asString() ?: fq.substringAfterLast('.')] = fq
            }
        }
    }

    private fun lines(f: SourceFile, e: KtElement) {
        val p = f.place(e)
        for (l in p.startLine..p.endLine) f.importLines.add(l)
    }

    private fun hasError(e: PsiElement): Boolean {
        if (e is PsiErrorElement) return true
        var c = e.firstChild
        while (c != null) {
            if (hasError(c)) return true
            c = c.nextSibling
        }
        return false
    }

    /** Tokens and comments in source order; a string template is one literal token, as a text block is in Java. */
    private fun scan(f: SourceFile, e: PsiElement) {
        if (e is PsiWhiteSpace) return
        if (e is PsiComment) {
            val start = e.textRange.startOffset
            val end = e.textRange.endOffset
            f.comments.add(Comment(e.text, f.line(start), f.line(maxOf(start, end - 1)), start, end))
            return
        }
        if (e is KtStringTemplateExpression || e.firstChild == null) {
            val start = e.textRange.startOffset
            val end = e.textRange.endOffset
            if (end <= start) return
            val kind = when {
                e is KtStringTemplateExpression -> TokenKind.LITERAL
                else -> tokenKind(e)
            }
            f.tokens.add(Token(f.line(start), f.line(maxOf(start, end - 1)), kind, e.text, start, end))
            return
        }
        var c = e.firstChild
        while (c != null) {
            scan(f, c)
            c = c.nextSibling
        }
    }

    private fun tokenKind(e: PsiElement): TokenKind {
        val type = e.node.elementType
        return when {
            type == KtTokens.TRUE_KEYWORD || type == KtTokens.FALSE_KEYWORD || type == KtTokens.NULL_KEYWORD -> TokenKind.LITERAL
            type == KtTokens.INTEGER_LITERAL || type == KtTokens.FLOAT_LITERAL || type == KtTokens.CHARACTER_LITERAL -> TokenKind.LITERAL
            type is KtKeywordToken -> TokenKind.KEYWORD
            type == KtTokens.IDENTIFIER || type == KtTokens.FIELD_IDENTIFIER -> TokenKind.NAME
            else -> TokenKind.OP
        }
    }

    // Places ----------------------------------------------------------------------------------------------------------

    /** The span of a declaration from its first token after KDoc and annotations to its end (spec/metrics.md, lines). */
    fun declarationPlace(f: SourceFile, d: KtElement): Place {
        val start = d.textRange.startOffset
        val end = d.textRange.endOffset
        val annotations = (d as? KtAnnotated)?.annotationEntries?.map { it.textRange } ?: emptyList()
        val first = f.tokens.firstOrNull { t -> t.start >= start && t.start < end && annotations.none { it.startOffset <= t.start && t.start < it.endOffset } }
        return f.place(first?.start ?: start, end)
    }

    // Declarations ----------------------------------------------------------------------------------------------------

    fun uniqueId(base: String): String {
        var candidate = base
        var n = 2
        while (candidate in ids) candidate = "$base#${n++}"
        ids.add(candidate)
        return candidate
    }

    private fun declare(f: SourceFile) {
        val m = f.module
        val top = ArrayList<KtNamedFunction>()
        for (d in f.kt.declarations) {
            when (d) {
                is KtClassOrObject -> declareType(f, d, null)
                is KtNamedFunction -> if (d.name != null) top.add(d)
                is KtProperty -> m.properties.add(declareProperty(f, null, d, static = true))
                else -> {}
            }
        }
        val counts = top.groupingBy { it.name!! }.eachCount()
        for (d in top) {
            val fn = Fn(d.name!!, null, m, f, d)
            fn.kind = "function"
            function(fn, d)
            fn.id = uniqueId(qualified(m, fn.name) + overload(fn, counts.getValue(fn.name) > 1))
            m.functions.add(fn)
            functions[fn.id] = fn
            fnOfDecl[d] = fn
        }
    }

    private fun qualified(m: Module, name: String) = if (m.id == GLOBAL) name else "${m.id}.$name"

    private fun declareType(f: SourceFile, d: KtClassOrObject, outer: TypeUnit?) {
        val name = d.name ?: return
        val base = if (outer != null) "${outer.id}.$name" else qualified(f.module, name)
        val t = TypeUnit(uniqueId(base), name, f.module, f, d)
        t.outer = outer
        if (d is KtClass) {
            t.kind = when {
                d.isInterface() -> "interface"
                d.isEnum() -> "enum"
                d.isAnnotation() -> "annotation"
                else -> "class"
            }
            t.isData = d.isData()
            t.isSealed = d.isSealed()
            t.isFunInterface = d.isInterface() && d.hasModifier(KtTokens.FUN_KEYWORD)
            for (p in d.typeParameters) p.name?.let { t.typeParameters.add(it) }
        } else {
            t.kind = "object"
        }
        t.isAbstract = t.kind == "interface" || t.kind == "annotation" || d.hasModifier(KtTokens.ABSTRACT_KEYWORD) || d.hasModifier(KtTokens.SEALED_KEYWORD)
        t.place = declarationPlace(f, d)
        typeOfDecl[d] = t
        types[t.id] = t
        f.module.types.add(t)
        outer?.nested?.add(t)

        val functions = ArrayList<Pair<Fn, KtElement>>()
        val nested = ArrayList<KtClassOrObject>()
        // Members of the companion object are static members of the type itself (spec/metrics.md, Kotlin).
        fun body(owner: KtClassOrObject, static: Boolean) {
            if (owner is KtClass) {
                for (entry in owner.body?.enumEntries ?: emptyList()) t.members.add(enumEntry(f, t, entry))
            }
            for (member in owner.declarations) {
                when (member) {
                    is KtEnumEntry -> {}
                    is KtObjectDeclaration -> if (member.isCompanion() && !static) body(member, true) else nested.add(member)
                    is KtClassOrObject -> nested.add(member)
                    is KtProperty -> {
                        val m = declareProperty(f, t, member, static)
                        t.members.add(m)
                        for (accessor in member.accessors) {
                            if (accessor.bodyExpression == null) continue
                            val fn = Fn(m.name, t, t.module, f, accessor)
                            fn.kind = "accessor"
                            fn.isStatic = static
                            fn.visibility = visibility(accessor, m.visibility)
                            accessorFunction(fn, accessor)
                            functions.add(fn to accessor)
                        }
                    }
                    is KtNamedFunction -> if (member.name != null) {
                        val fn = Fn(member.name!!, t, t.module, f, member)
                        fn.isStatic = static
                        function(fn, member)
                        functions.add(fn to member)
                    }
                    is KtSecondaryConstructor -> {
                        val fn = Fn(name, t, t.module, f, member)
                        fn.kind = "constructor"
                        fn.visibility = visibility(member, "public")
                        fn.parameters.addAll(member.valueParameters)
                        member.bodyExpression?.let { fn.body.add(it) }
                        member.getDelegationCallOrNull()?.let { if (!it.isImplicit) fn.body.add(it) }
                        fn.hasBody = true
                        fn.place = declarationPlace(f, member)
                        functions.add(fn to member)
                    }
                    else -> {}
                }
            }
        }
        if (d is KtClass) {
            val primary = d.primaryConstructor
            for (p in d.primaryConstructorParameters) if (p.hasValOrVar()) t.members.add(constructorProperty(f, t, p))
            if (primary != null) {
                val fn = Fn(name, t, t.module, f, primary)
                fn.kind = "constructor"
                fn.visibility = visibility(primary, "public")
                fn.parameters.addAll(primary.valueParameters)
                for (init in d.getAnonymousInitializers()) init.body?.let { fn.body.add(it) }
                fn.hasBody = true
                fn.place = declarationPlace(f, primary)
                functions.add(fn to primary)
            }
        }
        // An object declaration is a singleton: its members are static, as those of a companion object (spec/metrics.md, Kotlin).
        body(d, d is KtObjectDeclaration)
        val counts = functions.filter { it.first.kind != "accessor" }.groupingBy { it.first.name }.eachCount()
        for ((fn, decl) in functions) {
            if (t.kind == "interface" && fn.visibility != "private") fn.visibility = "public"
            fn.isAbstract = fn.kind == "method" && !fn.hasBody && (t.kind == "interface" || (decl as? KtModifierListOwner)?.hasModifier(KtTokens.ABSTRACT_KEYWORD) == true)
            val suffix = if (fn.kind == "accessor") ".${if ((decl as KtPropertyAccessor).isGetter) "get" else "set"}"
            else overload(fn, (counts[fn.name] ?: 0) > 1)
            fn.id = uniqueId("${t.id}.${fn.name}$suffix")
            t.methods.add(fn)
            this.functions[fn.id] = fn
            fnOfDecl[decl] = fn
        }
        for (n in nested) declareType(f, n, t)
    }

    /** The parameter types of an overload as written, without spaces; an extension's receiver comes first with a dot. */
    private fun overload(fn: Fn, overloaded: Boolean): String {
        if (!overloaded) return ""
        val parts = fn.parameters.map { p -> (p.typeReference?.text ?: "").replace(Regex("\\s+"), "") + if (p.isVarArg) "..." else "" }
        val receiver = fn.receiver?.text?.replace(Regex("\\s+"), "")?.let { "$it." } ?: ""
        return "(" + receiver + parts.joinToString(",") + ")"
    }

    private fun function(fn: Fn, d: KtNamedFunction) {
        if (fn.kind != "function") fn.kind = "method"
        fn.visibility = visibility(d, "public")
        fn.parameters.addAll(d.valueParameters)
        fn.receiver = d.receiverTypeReference
        fn.returnType = d.typeReference
        for (p in d.typeParameters) p.name?.let { fn.typeParameters.add(it) }
        d.bodyExpression?.let {
            fn.body.add(it)
            if (!d.hasBlockBody() && d.typeReference == null) fn.expressionBody = it
        }
        fn.hasBody = d.bodyExpression != null
        fn.place = declarationPlace(fn.file, d)
    }

    private fun accessorFunction(fn: Fn, a: KtPropertyAccessor) {
        a.parameter?.let { fn.parameters.add(it) }
        a.bodyExpression?.let { fn.body.add(it) }
        fn.hasBody = true
        fn.place = declarationPlace(fn.file, a)
    }

    private fun declareProperty(f: SourceFile, t: TypeUnit?, d: KtProperty, static: Boolean): Member {
        val m = Member(d.name ?: "", t, f.module, f, d)
        m.isFinal = !d.isVar
        m.isStatic = static
        m.typeRef = d.typeReference
        m.initializer = d.initializer ?: d.delegateExpression
        val inInterface = t != null && (t.kind == "interface" || t.kind == "annotation")
        m.visibility = if (inInterface && !d.hasModifier(KtTokens.PRIVATE_KEYWORD)) "public" else visibility(d, "public")
        m.kind = when {
            d.hasModifier(KtTokens.CONST_KEYWORD) -> "constant"
            d.annotationEntries.any { it.shortName?.asString() == "JvmField" } -> "field"
            else -> "property"
        }
        if (m.kind == "constant") m.isStatic = false
        m.place = declarationPlace(f, d)
        memberOfDecl[d] = m
        return m
    }

    private fun constructorProperty(f: SourceFile, t: TypeUnit, p: KtParameter): Member {
        val m = Member(p.name ?: "", t, t.module, f, p)
        m.isFinal = !p.isMutable
        m.typeRef = p.typeReference
        m.visibility = visibility(p, "public")
        m.kind = if (p.annotationEntries.any { it.shortName?.asString() == "JvmField" }) "field" else "property"
        m.place = declarationPlace(f, p)
        memberOfDecl[p] = m
        return m
    }

    private fun enumEntry(f: SourceFile, t: TypeUnit, e: KtEnumEntry): Member {
        val m = Member(e.name ?: "", t, t.module, f, e)
        m.kind = "literal"
        m.isFinal = true
        m.place = declarationPlace(f, e)
        memberOfDecl[e] = m
        return m
    }

    /** Project bases of a type; the superclass is the base called as a constructor, or a project class named. */
    private fun link(t: TypeUnit) {
        for (entry in t.decl.superTypeListEntries) {
            val ref = entry.typeReference ?: continue
            val target = resolver.typeOfReference(t.file, t, null, ref)
            val unit = target?.unit
            if (unit != null && unit !== t) {
                if (unit !in t.projectBases) t.projectBases.add(unit)
                if (unit.kind == "class" && t.kind != "interface") t.superclass = unit
            } else if (entry is KtSuperTypeCallEntry && unit == null) {
                t.externalSuperclass = target?.name != "kotlin.Any"
            }
        }
    }

    fun allTypes(): List<TypeUnit> = types.values.toList()

    fun allFunctions(): List<Fn> = functions.values.toList()

    /** The functions of a module: methods of its types, then its top-level functions. */
    fun moduleFunctions(m: Module): List<Fn> = m.types.flatMap { it.methods } + m.functions

    fun note(level: String, message: String, code: String): Map<String, Any?> = Json.of("level" to level, "message" to message, "code" to code)

    companion object {
        const val GLOBAL = "(global)"
        /** Build output, dependencies and tool folders; hidden folders are skipped as well. */
        val SKIPPED_FOLDERS = setOf("node_modules", "target", "build", "out", "bin")

        fun glob(pattern: String): Regex {
            val b = StringBuilder("^")
            var i = 0
            while (i < pattern.length) {
                when {
                    pattern.startsWith("**/", i) -> { b.append("(.*/)?"); i += 3 }
                    pattern.startsWith("**", i) -> { b.append(".*"); i += 2 }
                    pattern[i] == '*' -> { b.append("[^/]*"); i++ }
                    else -> { b.append(Regex.escape(pattern[i].toString())); i++ }
                }
            }
            return Regex(b.append("$").toString())
        }

        fun anyGlob(patterns: List<String>, value: String): Boolean = patterns.any { glob(it).matches(value) }

        fun readSource(path: Path): String {
            val data = Files.readAllBytes(path)
            var text = try {
                Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(data)).toString()
            } catch (e: CharacterCodingException) {
                String(data, Charsets.ISO_8859_1)
            }
            if (text.startsWith("﻿")) text = text.substring(1)
            return text.replace("\r\n", "\n").replace('\r', '\n')
        }

        fun visibility(d: KtModifierListOwner, default: String): String = when {
            d.hasModifier(KtTokens.PRIVATE_KEYWORD) -> "private"
            d.hasModifier(KtTokens.PROTECTED_KEYWORD) -> "protected"
            d.hasModifier(KtTokens.INTERNAL_KEYWORD) -> "internal"
            d.hasModifier(KtTokens.PUBLIC_KEYWORD) -> "public"
            else -> default
        }
    }
}
