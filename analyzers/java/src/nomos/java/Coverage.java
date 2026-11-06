package nomos.java;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Locale;
import java.util.Map;
import java.util.TreeMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Line coverage from a Cobertura or LCOV report (spec/metrics.md). */
final class Coverage {
    private static final Pattern CLASS = Pattern.compile("<class\\b[^>]*\\bfilename=\"([^\"]*)\"[^>]*>([\\s\\S]*?)</class>");
    private static final Pattern LINE = Pattern.compile("<line\\b[^>]*>");
    private static final Pattern NUMBER = Pattern.compile("\\bnumber=\"(\\d+)\"");
    private static final Pattern HITS = Pattern.compile("\\bhits=\"(\\d+)\"");

    private final Map<String, Map<Integer, Long>> files = new TreeMap<>();

    /** Reads a report; the extension .xml means Cobertura. */
    static Coverage load(Path file) throws IOException {
        String text = Files.readString(file, StandardCharsets.UTF_8);
        if (text.startsWith("\uFEFF")) text = text.substring(1);
        Coverage c = new Coverage();
        if (file.getFileName().toString().toLowerCase(Locale.ROOT).endsWith(".xml")) {
            Matcher cls = CLASS.matcher(text);
            while (cls.find()) {
                Map<Integer, Long> lines = c.files.computeIfAbsent(cls.group(1), k -> new TreeMap<>());
                Matcher line = LINE.matcher(cls.group(2));
                while (line.find()) {
                    Matcher n = NUMBER.matcher(line.group());
                    Matcher h = HITS.matcher(line.group());
                    if (n.find() && h.find()) lines.merge(Integer.parseInt(n.group(1)), Long.parseLong(h.group(1)), Math::max);
                }
            }
            return c;
        }
        Map<Integer, Long> current = null;
        for (String raw : text.split("\r?\n")) {
            String line = raw.strip();
            if (line.startsWith("SF:")) {
                current = new TreeMap<>();
                c.files.put(line.substring(3), current);
            } else if (line.startsWith("DA:") && current != null) {
                String[] parts = line.substring(3).split(",");
                if (parts.length >= 2) current.put(Integer.parseInt(parts[0].trim()), Long.parseLong(parts[1].trim()));
            }
        }
        return c;
    }

    /** The covered share of a file, null when the report does not mention it. */
    Double percent(String file) {
        String own = file.toLowerCase(Locale.ROOT);
        for (Map.Entry<String, Map<Integer, Long>> e : files.entrySet()) {
            String reported = e.getKey().replace('\\', '/').toLowerCase(Locale.ROOT);
            if (reported.equals(own) || reported.endsWith("/" + own)) {
                Map<Integer, Long> lines = e.getValue();
                if (lines.isEmpty()) return 100.0;
                long covered = lines.values().stream().filter(h -> h > 0).count();
                return Math.floor(100.0 * covered / lines.size() * 10000 + 0.5) / 10000;
            }
        }
        return null;
    }
}
