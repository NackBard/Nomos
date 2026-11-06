package nomos.kotlin

import java.io.IOException
import java.nio.file.Files
import java.nio.file.Path

/** The workspace file (contracts/nomos.schema.json) and the rules and practices of spec. */
class Config(raw: Map<String, Any?>) {
    /** The input is unusable: exit code 3. */
    class ConfigError(message: String) : Exception(message)

    val analyzers: List<Any?> = Json.array(raw["analyzers"])
    val ruleSettings: Map<String, Any?> = Json.obj(raw["rules"])
    val practiceIds: List<Any?>? = if (raw["practices"] is List<*>) Json.array(raw["practices"]) else null
    val paradigms: Map<String, Any?> = Json.obj(raw["paradigms"])
    val layers: List<Any?> = Json.array(raw["layers"])
    val categoryWeights: Map<String, Any?>
    val severityPenalties = linkedMapOf("info" to 0.0, "minor" to 1.0, "major" to 3.0, "critical" to 8.0)
    val confidenceFactors = linkedMapOf("low" to 0.25, "medium" to 0.6, "high" to 1.0)
    val decayPerKloc: Double
    val minKloc: Double

    init {
        val scoring = Json.obj(raw["scoring"])
        categoryWeights = Json.obj(scoring["categoryWeights"])
        Json.obj(scoring["severityPenalties"]).forEach { (k, v) -> severityPenalties[k] = number(v) }
        Json.obj(scoring["confidenceFactors"]).forEach { (k, v) -> confidenceFactors[k] = number(v) }
        val decay = number(scoring["decayPerKloc"])
        decayPerKloc = if (decay != 0.0) decay else 20.0
        val min = number(scoring["minKloc"])
        minKloc = if (min != 0.0) min else 0.2
    }

    /** The include and exclude globs of this language. */
    fun scope(): Pair<List<String>, List<String>> {
        for (a in analyzers) {
            val entry = Json.obj(a)
            if (entry["language"] == LANGUAGE) return strings(entry["include"]) to strings(entry["exclude"])
        }
        return emptyList<String>() to emptyList()
    }

    /** D-011: the functional style is opt-in, as in the other analyzers. */
    fun enabledParadigms(): Set<String> {
        val own = paradigms[LANGUAGE]
        if (own is List<*>) return strings(own).toSet()
        return setOf("oop", "structural")
    }

    /** For each rule outside the selected practices, the message for skippedRules (D-051); null selects all. */
    fun outsidePractices(): Map<String, String>? {
        val ids = practiceIds ?: return null
        val selected = strings(ids).toSet()
        val owners = sortedMapOf<String, MutableList<String>>()
        for (practice in specPractices()) {
            for (rule in strings(practice["rules"])) owners.getOrPut(rule) { mutableListOf() }.add(practice["id"] as String)
        }
        val outside = sortedMapOf<String, String>()
        for ((rule, owned) in owners) {
            if (owned.none { it in selected }) {
                outside[rule] = "Rule belongs to practice " + owned.sorted().joinToString(" or ") +
                    ", which is not selected; 'practices' in nomos.json selects them"
            }
        }
        return outside
    }

    fun rule(id: String): Map<String, Any?> = Json.obj(ruleSettings[id])

    fun threshold(rule: Map<String, Any?>, name: String): Any? {
        val own = Json.obj(rule(rule["id"] as String)["threshold"])
        if (own.containsKey(name)) return own[name]
        return Json.obj(rule["threshold"])[name]
    }

    fun number(rule: Map<String, Any?>, name: String): Double = number(threshold(rule, name))

    fun layerOf(module: String): Map<String, Any?>? {
        for (l in layers) {
            val layer = Json.obj(l)
            for (pattern in strings(layer["patterns"])) {
                val expression = pattern.split("*").joinToString(".*") { Regex.escape(it) }
                if (Regex(expression, setOf(RegexOption.IGNORE_CASE)).matches(module)) return layer
            }
        }
        return null
    }

    companion object {
        const val LANGUAGE = "kotlin"

        private var rules: List<Map<String, Any?>>? = null
        private var practices: List<Map<String, Any?>>? = null

        /** The rules of spec/rules, generated into rules.json by npm run spec-json in conformance/runner. */
        @Synchronized
        fun specRules(): List<Map<String, Any?>> = rules ?: resource("rules.json").also { rules = it }

        /** The practice catalog of spec/practices.yaml (practices.json). */
        @Synchronized
        fun specPractices(): List<Map<String, Any?>> = practices ?: resource("practices.json").also { practices = it }

        private fun resource(name: String): List<Map<String, Any?>> {
            val stream = Config::class.java.getResourceAsStream(name) ?: throw IllegalStateException("$name is missing from the analyzer")
            val text = stream.use { String(it.readAllBytes(), Charsets.UTF_8) }
            return Json.array(Json.parse(text)).map { Json.obj(it) }
        }

        fun number(value: Any?): Double = (value as? Number)?.toDouble() ?: 0.0

        fun strings(value: Any?): List<String> = Json.array(value).filterIsInstance<String>()

        /** Reads the file named by --config; no path gives the defaults. */
        fun load(file: String?): Config {
            if (file.isNullOrEmpty()) return Config(emptyMap())
            var text = try {
                Files.readString(Path.of(file), Charsets.UTF_8)
            } catch (e: IOException) {
                throw ConfigError("config file not found: $file")
            }
            if (text.startsWith("﻿")) text = text.substring(1)
            val raw = try {
                Json.parse(text)
            } catch (e: Json.ParseError) {
                throw ConfigError("$file: ${e.message}")
            }
            val map = Json.obj(raw)
            val version = map["schemaVersion"]
            if (version !is String || !version.startsWith("1.")) {
                throw ConfigError("$file: expected schemaVersion 1.x, found '${version as? String ?: ""}'")
            }
            if (map["practices"] is List<*>) {
                val known = specPractices().map { it["id"] as String }.toSet()
                for (practice in strings(map["practices"])) {
                    if (practice !in known) throw ConfigError("$file: unknown practice '$practice'")
                }
            }
            return Config(map)
        }
    }
}
