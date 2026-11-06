package nomos.kotlin

import java.nio.file.Files
import java.nio.file.Path
import java.util.Locale

/** A finding text: an English template of spec/rules ({0}, {1}...) and its arguments (spec/l10n.md). */
data class Text(val template: String, val args: List<String>) {
    /** The template with its arguments; {{ and }} are braces. */
    fun render(): String {
        val out = StringBuilder()
        var i = 0
        val t = template
        while (i < t.length) {
            val c = t[i]
            if ((c == '{' || c == '}') && i + 1 < t.length && t[i + 1] == c) {
                out.append(c)
                i++
            } else if (c == '{') {
                val end = t.indexOf('}', i)
                out.append(args[t.substring(i + 1, end).toInt()])
                i = end
            } else {
                out.append(c)
            }
            i++
        }
        return out.toString()
    }

    companion object {
        /** A number with a fixed count of decimals, culture-free and rounded half away from zero, as JavaScript does. */
        fun fixed(value: Double, digits: Int): String = String.format(Locale.ROOT, "%.${digits}f", round(value, digits))

        /** Math.round of JavaScript to a count of decimals. */
        fun round(value: Double, digits: Int): Double {
            val scale = Math.pow(10.0, digits.toDouble())
            return Math.floor(value * scale + 0.5) / scale
        }
    }
}

/** Builds a text from a literal template of spec/rules; the test templatesAreInSpec reads these calls from the source. */
fun tx(template: String, vararg args: Any): Text {
    val list = args.map {
        require(it !is Boolean) { "a boolean is not an argument of a finding text" }
        require(it !is Double && it !is Float) { "argument $it is not an integer; format it with fixed()" }
        it.toString()
    }
    return Text(template, list)
}

/** The suppressions of one file (spec/suppressions.md). */
class Directives {
    private val file = mutableListOf<String>()
    private val lines = HashMap<Int, MutableList<String>>()

    /** Reads a comment spanning lines start to end. */
    fun add(comment: String, start: Int, end: Int) {
        val m = DIRECTIVE.find(comment) ?: return
        val ids = m.groupValues[2].split(Regex("[ \\t,]+")).filter { it.isNotEmpty() }.ifEmpty { listOf("*") }
        when (m.groupValues[1]) {
            "-line" -> lines.getOrPut(start) { mutableListOf() }.addAll(ids)
            "-next-line" -> lines.getOrPut(end + 1) { mutableListOf() }.addAll(ids)
            else -> file.addAll(ids)
        }
    }

    fun covers(rule: String, line: Int): Boolean = matches(file, rule) || matches(lines[line] ?: emptyList(), rule)

    private fun matches(ids: List<String>, rule: String) = ids.any { it == "*" || it.equals(rule, ignoreCase = true) }

    companion object {
        private val DIRECTIVE = Regex("nomos-disable(-next-line|-line)?([ \\t,\\w.*]*)")
    }
}

/** Line coverage from a Cobertura or LCOV report (spec/metrics.md). */
class Coverage private constructor() {
    private val files = sortedMapOf<String, MutableMap<Int, Long>>()

    /** The covered share of a file, null when the report does not mention it. */
    fun percent(file: String): Double? {
        val own = file.lowercase(Locale.ROOT)
        for ((key, lines) in files) {
            val reported = key.replace('\\', '/').lowercase(Locale.ROOT)
            if (reported == own || reported.endsWith("/$own")) {
                if (lines.isEmpty()) return 100.0
                val covered = lines.values.count { it > 0 }
                return Math.floor(100.0 * covered / lines.size * 10000 + 0.5) / 10000
            }
        }
        return null
    }

    companion object {
        private val CLASS = Regex("<class\\b[^>]*\\bfilename=\"([^\"]*)\"[^>]*>([\\s\\S]*?)</class>")
        private val LINE = Regex("<line\\b[^>]*>")
        private val NUMBER = Regex("\\bnumber=\"(\\d+)\"")
        private val HITS = Regex("\\bhits=\"(\\d+)\"")

        /** Reads a report; the extension .xml means Cobertura. */
        fun load(file: Path): Coverage {
            var text = Files.readString(file, Charsets.UTF_8)
            if (text.startsWith("\uFEFF")) text = text.substring(1)
            val c = Coverage()
            if (file.fileName.toString().lowercase(Locale.ROOT).endsWith(".xml")) {
                for (cls in CLASS.findAll(text)) {
                    val lines = c.files.getOrPut(cls.groupValues[1]) { sortedMapOf() }
                    for (line in LINE.findAll(cls.groupValues[2])) {
                        val n = NUMBER.find(line.value)
                        val h = HITS.find(line.value)
                        if (n != null && h != null) lines.merge(n.groupValues[1].toInt(), h.groupValues[1].toLong(), ::maxOf)
                    }
                }
                return c
            }
            var current: MutableMap<Int, Long>? = null
            for (raw in text.split(Regex("\r?\n"))) {
                val line = raw.trim()
                if (line.startsWith("SF:")) {
                    current = sortedMapOf()
                    c.files[line.substring(3)] = current
                } else if (line.startsWith("DA:") && current != null) {
                    val parts = line.substring(3).split(",")
                    if (parts.size >= 2) current[parts[0].trim().toInt()] = parts[1].trim().toLong()
                }
            }
            return c
        }
    }
}
