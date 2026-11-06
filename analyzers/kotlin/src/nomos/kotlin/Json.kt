package nomos.kotlin

import java.math.BigDecimal

/**
 * JSON without a dependency of its own: the Kotlin standard library has no parser (D-059). Objects are LinkedHashMap
 * in source order, arrays ArrayList, numbers Long or Double; the writer formats like JSON.stringify(value, null, 2).
 */
object Json {
    class ParseError(message: String) : Exception(message)

    fun parse(text: String): Any? {
        val r = Reader(text)
        r.space()
        val value = r.value()
        r.space()
        if (r.at < text.length) throw ParseError("unexpected text at offset ${r.at}")
        return value
    }

    private class Reader(val s: String) {
        var at = 0

        fun space() {
            while (at < s.length && s[at] in " \t\r\n") at++
        }

        fun error(what: String) = ParseError("$what at offset $at")

        fun value(): Any? {
            if (at >= s.length) throw error("unexpected end")
            return when (s[at]) {
                '{' -> objectValue()
                '[' -> arrayValue()
                '"' -> string()
                't' -> { word("true"); true }
                'f' -> { word("false"); false }
                'n' -> { word("null"); null }
                else -> number()
            }
        }

        private fun objectValue(): Map<String, Any?> {
            at++
            val map = LinkedHashMap<String, Any?>()
            space()
            if (peek('}')) return map
            while (true) {
                space()
                if (at >= s.length || s[at] != '"') throw error("expected a key")
                val key = string()
                space()
                expect(':')
                space()
                map[key] = value()
                space()
                if (peek('}')) return map
                expect(',')
            }
        }

        private fun arrayValue(): List<Any?> {
            at++
            val list = ArrayList<Any?>()
            space()
            if (peek(']')) return list
            while (true) {
                space()
                list.add(value())
                space()
                if (peek(']')) return list
                expect(',')
            }
        }

        fun peek(c: Char): Boolean {
            if (at < s.length && s[at] == c) {
                at++
                return true
            }
            return false
        }

        fun expect(c: Char) {
            if (!peek(c)) throw error("expected '$c'")
        }

        fun word(w: String) {
            if (!s.startsWith(w, at)) throw error("unexpected token")
            at += w.length
        }

        fun number(): Any {
            val start = at
            while (at < s.length && s[at] in "+-0123456789.eE") at++
            val text = s.substring(start, at)
            if (text.isEmpty()) throw error("unexpected character")
            return try {
                if (Regex("-?\\d+").matches(text)) text.toLong() else text.toDouble()
            } catch (e: NumberFormatException) {
                throw error("bad number")
            }
        }

        fun string(): String {
            at++
            val b = StringBuilder()
            while (true) {
                if (at >= s.length) throw error("unterminated string")
                val c = s[at++]
                if (c == '"') return b.toString()
                if (c != '\\') {
                    b.append(c)
                    continue
                }
                if (at >= s.length) throw error("unterminated string")
                when (val e = s[at++]) {
                    'n' -> b.append('\n')
                    't' -> b.append('\t')
                    'r' -> b.append('\r')
                    'b' -> b.append('\b')
                    'f' -> b.append('\u000C')
                    'u' -> {
                        if (at + 4 > s.length) throw error("bad escape")
                        b.append(s.substring(at, at + 4).toInt(16).toChar())
                        at += 4
                    }
                    else -> b.append(e)
                }
            }
        }
    }

    fun write(value: Any?): String {
        val b = StringBuilder()
        write(b, value, "")
        return b.append('\n').toString()
    }

    private fun write(b: StringBuilder, value: Any?, indent: String) {
        when (value) {
            null -> b.append("null")
            is String -> quote(b, value)
            is Boolean -> b.append(value)
            is Int, is Long -> b.append(value)
            is Double -> b.append(number(value))
            is Map<*, *> -> {
                if (value.isEmpty()) {
                    b.append("{}")
                    return
                }
                val inner = "$indent  "
                b.append("{\n")
                var i = 0
                for ((k, v) in value) {
                    b.append(inner)
                    quote(b, k as String)
                    b.append(": ")
                    write(b, v, inner)
                    if (++i < value.size) b.append(',')
                    b.append('\n')
                }
                b.append(indent).append('}')
            }
            is List<*> -> {
                if (value.isEmpty()) {
                    b.append("[]")
                    return
                }
                val inner = "$indent  "
                b.append("[\n")
                for ((i, item) in value.withIndex()) {
                    b.append(inner)
                    write(b, item, inner)
                    if (i + 1 < value.size) b.append(',')
                    b.append('\n')
                }
                b.append(indent).append(']')
            }
            else -> throw IllegalArgumentException("not a JSON value: ${value.javaClass}")
        }
    }

    /** A whole number without a fraction, any other in plain notation: 0.0001, not 1.0E-4, as JavaScript writes it. */
    fun number(value: Double): String {
        if (value.isNaN() || value.isInfinite()) return "null"
        if (value == Math.rint(value) && Math.abs(value) < 1e15) return value.toLong().toString()
        return BigDecimal(value.toString()).stripTrailingZeros().toPlainString()
    }

    private fun quote(b: StringBuilder, s: String) {
        b.append('"')
        for (c in s) {
            when (c) {
                '"' -> b.append("\\\"")
                '\\' -> b.append("\\\\")
                '\n' -> b.append("\\n")
                '\r' -> b.append("\\r")
                '\t' -> b.append("\\t")
                '\b' -> b.append("\\b")
                '\u000C' -> b.append("\\f")
                else -> if (c < ' ') b.append(String.format("\\u%04x", c.code)) else b.append(c)
            }
        }
        b.append('"')
    }

    @Suppress("UNCHECKED_CAST")
    fun obj(value: Any?): Map<String, Any?> = value as? Map<String, Any?> ?: emptyMap()

    @Suppress("UNCHECKED_CAST")
    fun array(value: Any?): List<Any?> = value as? List<Any?> ?: emptyList()

    /** An ordered object built from key-value pairs. */
    fun of(vararg pairs: Pair<String, Any?>): LinkedHashMap<String, Any?> = linkedMapOf(*pairs)
}
