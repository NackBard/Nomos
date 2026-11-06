package nomos.java;

import java.io.IOException;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

/** The protocol of docs/ARCHITECTURE.md: facts to stdout, SARIF to the file named by --sarif, messages to stderr (D-058). */
public final class Main {
    static final int SUCCESS = 0;
    static final int UNEXPECTED = 1;
    static final int USAGE = 2;
    static final int BAD_INPUT = 3;
    static final int PARTIAL = 4;

    private Main() {
    }

    public static void main(String[] args) {
        System.exit(run(args, new PrintStream(System.out, true, StandardCharsets.UTF_8), new PrintStream(System.err, true, StandardCharsets.UTF_8)));
    }

    static int usage(PrintStream err, String message) {
        err.println(message);
        err.println("Usage: nomos-java manifest | analyze --root <path> [--sarif <file>] [--config <nomos.json>] [--rules <ids>]");
        return USAGE;
    }

    static int run(String[] args, PrintStream out, PrintStream err) {
        try {
            if (args.length == 1 && args[0].equals("manifest")) {
                out.print(Json.write(Facts.manifest()));
                out.flush();
                return SUCCESS;
            }
            if (args.length > 0 && args[0].equals("analyze")) return analyze(List.of(args).subList(1, args.length), out, err);
            return usage(err, "Unknown command or option: " + String.join(" ", args));
        } catch (StackOverflowError e) {
            err.println("error: the syntax tree is too deep");
            return UNEXPECTED;
        } catch (RuntimeException | IOException e) {
            // An analyzer bug must not look like a finding: exit code 1 and the stack for the author.
            err.print("error: ");
            e.printStackTrace(err);
            return UNEXPECTED;
        }
    }

    private static int analyze(List<String> args, PrintStream out, PrintStream err) throws IOException {
        Map<String, String> values = new HashMap<>();
        for (int i = 0; i < args.size(); i += 2) {
            if (i + 1 >= args.size()) return usage(err, "Missing value for " + args.get(i));
            if (!Set.of("--root", "--sarif", "--config", "--rules", "--files").contains(args.get(i))) return usage(err, "Unknown option: " + args.get(i));
            values.put(args.get(i), args.get(i + 1)); // --files is ignored: the analyzer always reads the whole root (partialAnalysis = false)
        }
        String root = values.get("--root");
        if (root == null || root.isEmpty()) return usage(err, "--root is required");
        if (!Files.isDirectory(Path.of(root))) {
            err.println("error: root does not exist: " + root);
            return BAD_INPUT;
        }
        Config config;
        try {
            config = Config.load(values.get("--config"));
        } catch (Config.ConfigError e) {
            err.println("error: " + e.getMessage());
            return BAD_INPUT;
        }
        Set<String> selected = null;
        String rules = values.get("--rules");
        if (rules != null && !rules.isEmpty()) {
            selected = new TreeSet<>();
            for (String raw : rules.split(",")) {
                String rule = raw.strip();
                if (!Rules.SUPPORTED.contains(rule)) return usage(err, "Unknown rule: " + rule);
                selected.add(rule);
            }
        }
        List<List<String>> scope = config.scope();
        Project project = new Project(Path.of(root));
        project.load(scope.get(0), scope.get(1));
        Facts.Result result = Facts.analyze(project, values.get("--sarif"), selected, config);
        out.print(result.facts);
        out.flush();
        return result.partial ? PARTIAL : SUCCESS; // findings never change the exit code, only an incomplete result does
    }
}
