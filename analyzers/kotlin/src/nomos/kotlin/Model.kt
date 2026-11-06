package nomos.kotlin

import org.jetbrains.kotlin.psi.KtClassOrObject
import org.jetbrains.kotlin.psi.KtElement
import org.jetbrains.kotlin.psi.KtExpression
import org.jetbrains.kotlin.psi.KtFile
import org.jetbrains.kotlin.psi.KtParameter
import org.jetbrains.kotlin.psi.KtTypeReference

/** What the analyzer knows about the sources: files, packages, types, their members and functions. */
data class Place(val file: String, val startLine: Int, val startColumn: Int, val endLine: Int, val endColumn: Int) {
    fun json(): Map<String, Any?> = Json.of("file" to file, "startLine" to startLine, "startColumn" to startColumn, "endLine" to endLine, "endColumn" to endColumn)

    fun lines(): Int = endLine - startLine + 1
}

enum class TokenKind { NAME, KEYWORD, LITERAL, OP }

data class Token(val line: Int, val endLine: Int, val kind: TokenKind, val text: String, val start: Int, val end: Int)

data class Comment(val text: String, val startLine: Int, val endLine: Int, val start: Int, val end: Int)

class SourceFile(val path: String, val text: String) {
    val lineStarts: IntArray = lineStarts(text)
    val lines: Int = text.count { it == '\n' } + if (text.isNotEmpty() && !text.endsWith("\n")) 1 else 0
    var loc = 0
    val tokens = ArrayList<Token>()
    val comments = ArrayList<Comment>()
    val directives = Directives()
    val importLines = HashSet<Int>()
    lateinit var kt: KtFile
    var broken = false
    lateinit var module: Module
    /** Package of the file ("" without one), explicit imports by the name they bind, and star-imported packages. */
    var packageName = ""
    val imports = LinkedHashMap<String, String>()
    val starImports = ArrayList<String>()

    fun line(offset: Int): Int = line(lineStarts, offset)

    fun place(start: Int, end: Int): Place {
        val s = maxOf(0, start)
        val e = maxOf(s, end)
        val sl = line(s)
        val el = line(e)
        return Place(path, sl, s - lineStarts[sl - 1] + 1, el, e - lineStarts[el - 1] + 1)
    }

    fun place(element: KtElement): Place = place(element.textRange.startOffset, element.textRange.endOffset)

    /** Whether a comment lies between two offsets. */
    fun hasComment(start: Int, end: Int): Boolean = comments.any { it.start >= start && it.end <= end }

    companion object {
        fun lineStarts(s: String): IntArray {
            val starts = arrayListOf(0)
            for (i in s.indices) if (s[i] == '\n') starts.add(i + 1)
            return starts.toIntArray()
        }

        /** The 1-based line of an offset. */
        fun line(starts: IntArray, offset: Int): Int {
            var lo = 0
            var hi = starts.size - 1
            while (lo < hi) {
                val mid = (lo + hi + 1) ushr 1
                if (starts[mid] <= offset) lo = mid else hi = mid - 1
            }
            return lo + 1
        }
    }
}

class Module(val id: String) {
    val files = ArrayList<SourceFile>()
    /** Every type of the package, nested ones included, in file and declaration order. */
    val types = ArrayList<TypeUnit>()
    /** Top-level functions: units of their own (spec/metrics.md, Kotlin). */
    val functions = ArrayList<Fn>()
    /** Top-level properties. */
    val properties = ArrayList<Member>()

    fun loc(): Int = files.sumOf { it.loc }
}

class TypeUnit(val id: String, val name: String, val module: Module, val file: SourceFile, val decl: KtClassOrObject) {
    lateinit var place: Place
    var kind = "class"
    var isAbstract = false
    var isData = false
    var isSealed = false
    var isFunInterface = false
    var outer: TypeUnit? = null
    val members = ArrayList<Member>()
    val methods = ArrayList<Fn>()
    val nested = ArrayList<TypeUnit>()
    val typeParameters = ArrayList<String>()
    /** The project superclass alone, for DIT. */
    var superclass: TypeUnit? = null
    /** A base class outside the project, written as a constructor call in the supertype list. */
    var externalSuperclass = false
    val projectBases = ArrayList<TypeUnit>()

    fun isClassLike(): Boolean = kind == "class" || kind == "object"

    /** Members and methods of the type and of its project bases, nearest first. */
    fun lineage(): List<TypeUnit> {
        val result = ArrayList<TypeUnit>()
        val queue = ArrayDeque(listOf(this))
        while (queue.isNotEmpty()) {
            val t = queue.removeFirst()
            if (t in result) continue
            result.add(t)
            queue.addAll(t.projectBases)
        }
        return result
    }
}

class Member(val name: String, val owner: TypeUnit?, val module: Module, val file: SourceFile, val decl: KtElement) {
    /** field (@JvmField), property, constant (const val), literal (enum entry). */
    var kind = "property"
    var visibility = "public"
    var isStatic = false
    /** val: no setter. */
    var isFinal = false
    var typeRef: KtTypeReference? = null
    var initializer: KtExpression? = null
    lateinit var place: Place
}

class Fn(val name: String, val owner: TypeUnit?, val module: Module, val file: SourceFile, val decl: KtElement) {
    lateinit var id: String
    /** function (top level), method, constructor, accessor. */
    var kind = "method"
    var visibility = "public"
    var isStatic = false
    var isAbstract = false
    lateinit var place: Place
    val parameters = ArrayList<KtParameter>()
    var receiver: KtTypeReference? = null
    var returnType: KtTypeReference? = null
    /** The code of the function: its body, or the init blocks of a primary constructor. */
    val body = ArrayList<KtElement>()
    var hasBody = false
    /** An expression body without a written result type: the result is inferred from it. */
    var expressionBody: KtExpression? = null
    val typeParameters = HashSet<String>()

    /** An instance method with a body: the methods of TCC, LCOM4 and foreignMembers. */
    fun isInstanceMethod(): Boolean = owner != null && owner.isClassLike() && hasBody && kind == "method" && !isStatic

    /** The unit the function belongs to: its type, or itself at the top level. */
    fun unitId(): String = owner?.id ?: id
}
