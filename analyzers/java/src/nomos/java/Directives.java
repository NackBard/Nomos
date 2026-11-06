package nomos.java;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** The suppressions of one file (spec/suppressions.md). */
final class Directives {
    private static final Pattern DIRECTIVE = Pattern.compile("nomos-disable(-next-line|-line)?([ \\t,\\w.*]*)");
    private final List<String> file = new ArrayList<>();
    private final Map<Integer, List<String>> lines = new HashMap<>();

    /** Reads a comment spanning lines start to end. */
    void add(String comment, int start, int end) {
        Matcher m = DIRECTIVE.matcher(comment);
        if (!m.find()) return;
        List<String> ids = new ArrayList<>();
        for (String id : m.group(2).split("[ \\t,]+")) if (!id.isEmpty()) ids.add(id);
        if (ids.isEmpty()) ids.add("*");
        String form = m.group(1);
        if ("-line".equals(form)) lines.computeIfAbsent(start, k -> new ArrayList<>()).addAll(ids);
        else if ("-next-line".equals(form)) lines.computeIfAbsent(end + 1, k -> new ArrayList<>()).addAll(ids);
        else file.addAll(ids);
    }

    boolean covers(String rule, int line) {
        return matches(file, rule) || matches(lines.getOrDefault(line, List.of()), rule);
    }

    private static boolean matches(List<String> ids, String rule) {
        for (String id : ids) if (id.equals("*") || id.equalsIgnoreCase(rule)) return true;
        return false;
    }
}
