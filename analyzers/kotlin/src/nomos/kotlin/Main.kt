package nomos.kotlin

import java.io.PrintStream
import java.nio.file.Files
import java.nio.file.Path
import kotlin.system.exitProcess

/** The protocol of docs/ARCHITECTURE.md: facts to stdout, SARIF to the file named by --sarif, messages to stderr (D-059). */
object Main {
    const val SUCCESS = 0
    const val UNEXPECTED = 1
    const val USAGE = 2
    const val BAD_INPUT = 3
    const val PARTIAL = 4

    fun usage(err: PrintStream, message: String): Int {
        err.println(message)
        err.println("Usage: nomos-kotlin manifest | analyze --root <path> [--sarif <file>] [--config <nomos.json>] [--rules <ids>]")
        return USAGE
    }

    fun run(args: List<String>, out: PrintStream, err: PrintStream): Int {
        return try {
            when {
                args.size == 1 && args[0] == "manifest" -> {
                    out.print(Json.write(Facts.manifest()))
                    out.flush()
                    SUCCESS
                }
                args.isNotEmpty() && args[0] == "analyze" -> analyze(args.drop(1), out, err)
                else -> usage(err, "Unknown command or option: ${args.joinToString(" ")}")
            }
        } catch (e: StackOverflowError) {
            err.println("error: the syntax tree is too deep")
            UNEXPECTED
        } catch (e: Exception) {
            // An analyzer bug must not look like a finding: exit code 1 and the stack for the author.
            err.print("error: ")
            e.printStackTrace(err)
            UNEXPECTED
        }
    }

    private fun analyze(args: List<String>, out: PrintStream, err: PrintStream): Int {
        val values = HashMap<String, String>()
        var i = 0
        while (i < args.size) {
            if (i + 1 >= args.size) return usage(err, "Missing value for ${args[i]}")
            if (args[i] !in setOf("--root", "--sarif", "--config", "--rules", "--files")) return usage(err, "Unknown option: ${args[i]}")
            values[args[i]] = args[i + 1] // --files is ignored: the analyzer always reads the whole root (partialAnalysis = false)
            i += 2
        }
        val root = values["--root"]
        if (root.isNullOrEmpty()) return usage(err, "--root is required")
        if (!Files.isDirectory(Path.of(root))) {
            err.println("error: root does not exist: $root")
            return BAD_INPUT
        }
        val config = try {
            Config.load(values["--config"])
        } catch (e: Config.ConfigError) {
            err.println("error: ${e.message}")
            return BAD_INPUT
        }
        var selected: Set<String>? = null
        val rules = values["--rules"]
        if (!rules.isNullOrEmpty()) {
            val set = sortedSetOf<String>()
            for (raw in rules.split(",")) {
                val rule = raw.trim()
                if (rule !in Rules.SUPPORTED) return usage(err, "Unknown rule: $rule")
                set.add(rule)
            }
            selected = set
        }
        val (include, exclude) = config.scope()
        val project = Project(Path.of(root))
        project.load(include, exclude)
        val result = Facts.analyze(project, values["--sarif"], selected, config)
        out.print(result.facts)
        out.flush()
        return if (result.partial) PARTIAL else SUCCESS // findings never change the exit code, only an incomplete result does
    }
}

fun main(args: Array<String>) {
    // The compiler's PSI writes nothing on its own; the output stays only what the protocol says.
    System.setProperty("idea.io.use.nio2", "true")
    exitProcess(Main.run(args.toList(), PrintStream(System.out, true, "UTF-8"), PrintStream(System.err, true, "UTF-8")))
}
