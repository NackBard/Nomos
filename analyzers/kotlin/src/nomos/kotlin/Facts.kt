package nomos.kotlin

import java.nio.file.Files
import java.nio.file.Path

/** The manifest, facts and SARIF of one run. */
object Facts {
    const val NAME = "nomos-kotlin"
    const val VERSION = "0.1.0"
    const val FACTS_VERSION = "1.3.0"
    const val MANIFEST_VERSION = "1.2.0"

    fun rulesById(): Map<String, Map<String, Any?>> = Config.specRules().associateBy { it["id"] as String }

    fun sortedParadigms(rule: Map<String, Any?>): List<String> = Config.strings(rule["paradigms"]).sorted()

    fun manifest(): Map<String, Any?> {
        val byId = rulesById()
        val rules = Rules.SUPPORTED.map { id ->
            val r = byId.getValue(id)
            Json.of("id" to id, "category" to r["category"], "paradigms" to sortedParadigms(r), "title" to r["title"])
        }
        return Json.of(
            "name" to NAME, "language" to Config.LANGUAGE, "version" to VERSION, "schemaVersion" to MANIFEST_VERSION,
            "paradigms" to listOf("functional", "oop", "structural"),
            "files" to listOf("**/*.kt"),
            // No type checker runs: names are resolved over the project's declarations (D-059).
            "capabilities" to Json.of("semantic" to false, "supportedRules" to Rules.SUPPORTED, "partialAnalysis" to false, "sarif" to true),
            "rules" to rules)
    }

    private fun notApplicable(paradigm: String) = when (paradigm) {
        "oop" -> "OOP rule not applicable: module has no classes"
        "functional" -> "Functional rule not applicable: module shows no functional style"
        "structural" -> "Structural rule not applicable: module has no free functions or branching"
        else -> "Rule for paradigm '$paradigm' not applicable: no evidence of it in the module"
    }

    private fun level(severity: String) = when (severity) {
        "critical" -> "error"
        "info" -> "note"
        else -> "warning"
    }

    private fun weight(config: Config, category: String): Double = (config.categoryWeights[category] as? Number)?.toDouble() ?: 1.0

    private fun score(config: Config, loc: Int, findings: List<Finding>, categories: List<String>): LinkedHashMap<String, Any?> {
        val totalWeight = categories.sumOf { weight(config, it) }
        val kloc = maxOf(loc / 1000.0, config.minKloc)
        var total = 0.0
        val result = ArrayList<Any?>()
        for (category in categories) {
            var penalty = 0.0
            var own = 0
            for (f in findings) {
                if (f.category != category) continue
                own++
                penalty += (config.severityPenalties[f.severity] ?: 0.0) * (config.confidenceFactors[f.confidence] ?: 0.0)
            }
            val value = 100 * Math.exp(-penalty / kloc / config.decayPerKloc)
            val share = if (totalWeight > 0) weight(config, category) / totalWeight else 0.0
            total += value * share
            result.add(Json.of("category" to category, "score" to Text.round(value, 1), "weight" to Text.round(share, 3), "penalty" to Text.round(penalty, 2), "findingCount" to own))
        }
        return Json.of("score" to total, "categories" to result,
            "explanation" to listOf("Weighted mean over ${categories.size} categories, normalized by ${String.format(java.util.Locale.ROOT, "%.3f", kloc)} KLOC."))
    }

    class Result(val facts: String, val partial: Boolean)

    private fun skip(rule: String, module: String?, reason: String, message: String): Map<String, Any?> {
        val s = Json.of("ruleId" to rule)
        if (module != null) s["module"] = module
        s["reason"] = reason
        s["message"] = message
        return s
    }

    fun analyze(p: Project, sarifFile: String?, selected: Set<String>?, config: Config): Result {
        val edges = Graphing.collect(p)
        val graphs = Graphing.build(p, edges)
        val estimates = Estimate.all(p)
        val run = Run(p, config, edges, graphs, estimates)
        val pure = Paradigms.pure(p)
        val enabled = config.enabledParadigms()
        val report = Json.obj(config.rule("MNT004")["threshold"])["report"]
        if (report is String && report.isNotEmpty()) {
            run.coverage = try {
                Coverage.load(p.root.resolve(report))
            } catch (e: java.io.IOException) {
                null
            }
        }
        val evidence = HashMap<String, List<Map<String, Any?>>>()
        val shown = HashMap<String, List<String>>()
        for (m in p.modules) {
            evidence[m.id] = Paradigms.evidence(p, m, pure)
            shown[m.id] = Paradigms.active(evidence.getValue(m.id))
            run.active[m.id] = shown.getValue(m.id).filter { it in enabled }.toSortedSet()
        }

        val rules = Config.specRules()
        val supported = Rules.SUPPORTED.toSortedSet()
        val outside = config.outsidePractices()
        val skips = ArrayList<Map<String, Any?>>()
        val categories = sortedSetOf<String>()
        val inputs = mapOf("layer-config" to config.layers.isNotEmpty(), "coverage-report" to (run.coverage != null))
        for (rule in rules) {
            val id = rule["id"] as String
            if (id !in supported) {
                if ('.' !in id) skips.add(skip(id, null, "not-supported", if (id == "STR001") "Kotlin has no goto" else "Rule is not implemented for Kotlin"))
                continue
            }
            val explicit = config.rule(id)["enabled"]
            val byConfig = explicit == false || (selected != null && id !in selected)
            val practiceMessage = if (outside != null && explicit == null) outside[id] else null
            val paradigms = Config.strings(rule["paradigms"])
            val anyEnabled = paradigms.isEmpty() || paradigms.any { it in enabled }
            when {
                !anyEnabled -> skips.add(skip(id, null, "disabled-by-config",
                    "Rule needs paradigm ${paradigms.sorted().joinToString(" or ")}, which is off for this language; 'paradigms' in nomos.json selects them"))
                byConfig -> skips.add(skip(id, null, "disabled-by-config", "Rule is off by nomos.json or by --rules"))
                practiceMessage != null -> skips.add(skip(id, null, "disabled-by-config", practiceMessage))
            }
            if (byConfig || practiceMessage != null || !anyEnabled) continue
            run.rule = rule
            run.ran[id] = rule
            categories.add(rule["category"] as String)
            Rules.DETECTORS.getValue(id)(run)
            for (needed in Config.strings(rule["requires"])) {
                if (inputs[needed] != true) skips.add(skip(id, null, "missing-input", "Rule not applied: no $needed in the configuration"))
            }
        }
        for (rule in rules) {
            val id = rule["id"] as String
            val paradigms = Config.strings(rule["paradigms"])
            if (id !in supported || paradigms.isEmpty()) continue
            val ran = run.ran.containsKey(id)
            for (m in p.modules) {
                val own = shown.getValue(m.id)
                val applies = paradigms.any { it in own }
                val active = paradigms.any { it in own && it in enabled }
                if (!applies) skips.add(skip(id, m.id, "paradigm-not-detected", notApplicable(paradigms[0])))
                else if (ran && !active) skips.add(skip(id, m.id, "disabled-by-config", "Rule not applied: every paradigm the module shows for it is off for this language"))
            }
        }
        skips.sortWith(compareBy<Map<String, Any?>>({ it["ruleId"] as String }, { it["module"] as String? ?: "" }, { it["reason"] as String }))

        val byFile = p.files.associateBy { it.path }
        val ordered = Rules.sort(run.findings)
        val findings = ordered.filter { f -> byFile[f.place.file]?.directives?.covers(f.rule, f.place.startLine) != true }
        val suppressed = ordered.size - findings.size
        for (f in findings) if (f.module.isEmpty()) byFile[f.place.file]?.let { f.module = it.module.id }
        val categoryList = categories.toList()

        val diagnostics = ArrayList<Any?>(p.notes)
        var partial = false
        val files = ArrayList<Any?>()
        for (f in p.files) {
            val entry = Json.of("path" to f.path, "lines" to f.lines, "loc" to f.loc)
            run.coverage?.percent(f.path)?.let { entry["coverage"] = it }
            entry["module"] = f.module.id
            entry["parsed"] = !f.broken
            if (f.broken) {
                partial = true
                diagnostics.add(Json.of("level" to "warning", "message" to "Syntax errors: the declarations of this file may be incomplete in the facts.", "file" to f.path,
                    "code" to "syntax-error"))
            }
            files.add(entry)
        }
        if (suppressed > 0) diagnostics.add(Json.of("level" to "info", "message" to "$suppressed finding(s) suppressed by directives.", "code" to "suppressed"))
        if (p.files.isEmpty()) {
            diagnostics.add(Json.of("level" to "info", "message" to "No Kotlin files under the root outside build, dependency and hidden folders.", "code" to "no-files"))
        }

        var total = 0.0
        var totalLoc = 0
        val modules = ArrayList<Any?>()
        for (m in p.modules) {
            val loc = m.loc()
            val own = findings.filter { it.module == m.id }
            val health = score(config, loc, own, categoryList)
            val value = health["score"] as Double
            total += value * loc
            totalLoc += loc
            health["score"] = Text.round(value, 1)
            modules.add(Json.of("id" to m.id, "name" to m.id, "files" to m.files.map { it.path }, "loc" to loc, "metrics" to run.martin(m),
                "paradigmEvidence" to evidence[m.id], "activeParadigms" to shown[m.id], "health" to health))
        }
        val projectScore = if (totalLoc > 0) total / totalLoc else 100.0
        val projectCategories = categoryList.map { c ->
            (score(config, maxOf(totalLoc, 1), findings.filter { it.category == c }, listOf(c))["categories"] as List<*>)[0]
        }

        val types = ArrayList<Any?>()
        for (t in p.allTypes()) {
            val metrics = Json.of("lines" to t.place.lines(), "memberCount" to Rules.memberCount(t), "methodCount" to Rules.methodCount(t),
                "blastRadius" to (graphs.radius[t.id] ?: 0))
            if (t.isClassLike()) {
                metrics["dit"] = Metrics.dit(t)
                metrics["cbo"] = run.cbo(t)
                metrics["lcom4"] = Metrics.lcom4(p, t)
                metrics["wmc"] = Metrics.wmc(t)
                metrics["atfd"] = Metrics.atfd(p, t)
                metrics["tcc"] = Metrics.tcc(p, t)
            }
            val entry = Json.of("id" to t.id, "name" to t.name, "module" to t.module.id, "kind" to t.kind, "isAbstract" to t.isAbstract, "location" to t.place.json())
            if (t.typeParameters.isNotEmpty()) entry["typeParameters"] = t.typeParameters
            val members = Structure.members(p, t)
            if (members.isNotEmpty()) entry["members"] = members
            entry["metrics"] = metrics
            types.add(entry)
        }

        val functions = ArrayList<Any?>()
        for (f in p.allFunctions()) {
            val metrics = linkedMapOf<String, Any?>(
                "cyclomatic" to Metrics.cyclomatic(f), "maxNesting" to Metrics.maxNesting(f), "parameterCount" to Metrics.parameterCount(f), "lines" to f.place.lines(),
                "hofOrder" to Metrics.hofOrder(p, f), "lambdaNesting" to Metrics.lambdaNesting(f), "typeTests" to Metrics.testedTypes(p, f).size,
                "blastRadius" to (graphs.radius[f.unitId()] ?: 0))
            for (key in listOf("timeDegree", "timeLogFactor", "timeExponential", "spaceDegree", "allocationDepth", "foreignMembers", "ownMembers", "halsteadVolume",
                "maintainabilityIndex")) metrics[key] = null
            if (f.hasBody) {
                Metrics.halsteadVolume(f)?.let { volume ->
                    metrics["halsteadVolume"] = Text.round(volume, 4)
                    metrics["maintainabilityIndex"] = Metrics.maintainabilityIndex(f)?.let { Text.round(it, 4) }
                }
                estimates[f.id]?.let { growth ->
                    metrics["timeExponential"] = if (growth.exponential) 1 else 0
                    if (!growth.exponential) {
                        metrics["timeDegree"] = growth.degree
                        metrics["timeLogFactor"] = growth.log
                    }
                    metrics["spaceDegree"] = Metrics.spaceDegree(p, f, Estimate.selfCalls(p, f).size)
                    metrics["allocationDepth"] = Metrics.allocationDepth(p, f)
                }
            }
            if (f.isInstanceMethod()) {
                metrics["foreignMembers"] = Metrics.mostUsedForeign(p, f).second.size
                metrics["ownMembers"] = Metrics.memberUse(p, f).own.size
            }
            val entry = Json.of("id" to f.id, "name" to f.name, "module" to f.module.id)
            f.owner?.let { entry["type"] = it.id }
            entry["kind"] = f.kind
            entry["visibility"] = f.visibility
            entry["location"] = f.place.json()
            entry["parameters"] = Structure.parameters(f)
            Structure.returnTypeName(f)?.let { entry["returnTypeName"] = it }
            if (f.isStatic) entry["isStatic"] = true
            if (f.isAbstract) entry["isAbstract"] = true
            entry["metrics"] = metrics
            functions.add(entry)
        }

        val merged = sortedMapOf<String, LinkedHashMap<String, Any?>>()
        for (e in edges) {
            val key = "${e.from}\u0000${e.to}\u0000${e.kind}\u0000runtime"
            val known = merged[key]
            if (known != null) known["count"] = (known["count"] as Int) + 1
            else merged[key] = Json.of("from" to e.from, "to" to e.to, "kind" to e.kind, "phase" to "runtime", "external" to e.external, "stdlib" to e.stdlib,
                "count" to 1, "location" to e.place.json())
        }
        val cycles = Graphing.components(graphs.units).map { Json.of("level" to "type", "members" to it) } +
            Graphing.components(graphs.modules).map { Json.of("level" to "module", "members" to it) }

        val document = Json.of(
            "schemaVersion" to FACTS_VERSION,
            "analyzer" to Json.of("name" to NAME, "version" to VERSION, "language" to Config.LANGUAGE, "semantic" to false),
            "files" to files, "modules" to modules, "types" to types, "functions" to functions, "dependencies" to merged.values.toList(), "cycles" to cycles,
            "health" to Json.of("score" to Text.round(projectScore, 1), "categories" to projectCategories,
                "explanation" to listOf("Mean of ${modules.size} module score(s), weighted by lines of code ($totalLoc total).")),
            "skippedRules" to skips,
            "diagnostics" to diagnostics)
        if (sarifFile != null) {
            Files.writeString(Path.of(sarifFile), sarif(findings), Charsets.UTF_8)
            document["checks"] = Json.of("sarifFile" to sarifFile, "resultCount" to findings.size)
        }
        return Result(Json.write(document), partial)
    }

    private fun keyOf(rule: Map<String, Any?>?, template: String): String? {
        if (rule == null) return null
        return Json.obj(rule["messages"]).filter { (_, m) -> Json.obj(m)["text"] == template }.keys.minOrNull()
    }

    private fun sarif(findings: List<Finding>): String {
        val byId = rulesById()
        val ids = Rules.SUPPORTED.sorted()
        val index = ids.withIndex().associate { it.value to it.index }
        val rules = ids.map { id ->
            val rule = byId.getValue(id)
            val entry = Json.of("id" to id, "name" to rule["title"], "shortDescription" to Json.of("text" to rule["description"]),
                "fullDescription" to Json.of("text" to rule["rationale"]), "defaultConfiguration" to Json.of("level" to level(rule["severity"] as String)),
                "properties" to Json.of("category" to rule["category"], "paradigms" to sortedParadigms(rule)))
            val messages = Json.obj(rule["messages"])
            if (messages.isNotEmpty()) entry["messageStrings"] = LinkedHashMap(messages.toSortedMap().mapValues { (_, m) -> Json.of("text" to Json.obj(m)["text"]) })
            entry
        }
        val results = findings.map { f ->
            val rule = byId[f.rule]
            val properties = Json.of("severity" to f.severity, "confidence" to f.confidence, "explanation" to f.explanation)
            if (f.module.isNotEmpty()) properties["module"] = f.module
            if (f.entity.isNotEmpty()) properties["entity"] = f.entity
            if (f.measured != null) properties["measured"] = f.measured
            keyOf(rule, f.explanationText.template)?.let { properties["explanationMessage"] = Json.of("id" to it, "arguments" to f.explanationText.args) }
            val message = Json.of("text" to f.message)
            keyOf(rule, f.messageText.template)?.let {
                message["id"] = it
                message["arguments"] = f.messageText.args
            }
            Json.of("ruleId" to f.rule, "ruleIndex" to index[f.rule], "level" to level(f.severity), "message" to message,
                "locations" to listOf(Json.of("physicalLocation" to Json.of("artifactLocation" to Json.of("uri" to f.place.file),
                    "region" to Json.of("startLine" to f.place.startLine, "startColumn" to f.place.startColumn, "endLine" to f.place.endLine, "endColumn" to f.place.endColumn)))),
                "partialFingerprints" to Json.of("nomos/v1" to Rules.fingerprint(f)),
                "properties" to properties)
        }
        val document = Json.of("\$schema" to "https://json.schemastore.org/sarif-2.1.0.json", "version" to "2.1.0",
            "runs" to listOf(Json.of("tool" to Json.of("driver" to Json.of("name" to NAME, "version" to VERSION, "semanticVersion" to VERSION, "rules" to rules)), "results" to results)))
        return Json.write(document)
    }
}
