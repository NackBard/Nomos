package nomos.java;

import java.util.ArrayList;
import java.util.List;

/** A finding text: an English template of spec/rules ({0}, {1}...) and its arguments (spec/l10n.md). */
record Text(String template, List<String> args) {

    /** Builds a text from a literal template of spec/rules; TextTest reads these calls from the source. */
    static Text tx(String template, Object... args) {
        List<String> list = new ArrayList<>();
        for (Object a : args) {
            if (a instanceof Boolean) throw new IllegalArgumentException("a boolean is not an argument of a finding text");
            if (a instanceof Double || a instanceof Float) throw new IllegalArgumentException("argument " + a + " is not an integer; format it with fixed()");
            list.add(String.valueOf(a));
        }
        return new Text(template, List.copyOf(list));
    }

    /** A number with a fixed count of decimals, culture-free and rounded half away from zero, as JavaScript does. */
    static String fixed(double value, int digits) {
        double scale = Math.pow(10, digits);
        double rounded = Math.floor(value * scale + 0.5) / scale;
        return String.format(java.util.Locale.ROOT, "%." + digits + "f", rounded);
    }

    /** Math.round of JavaScript to a count of decimals. */
    static double round(double value, int digits) {
        double scale = Math.pow(10, digits);
        return Math.floor(value * scale + 0.5) / scale;
    }

    /** The template with its arguments; {{ and }} are braces. */
    String render() {
        StringBuilder out = new StringBuilder();
        String t = template;
        for (int i = 0; i < t.length(); i++) {
            char c = t.charAt(i);
            if ((c == '{' || c == '}') && i + 1 < t.length() && t.charAt(i + 1) == c) {
                out.append(c);
                i++;
            } else if (c == '{') {
                int end = t.indexOf('}', i);
                out.append(args.get(Integer.parseInt(t.substring(i + 1, end))));
                i = end;
            } else {
                out.append(c);
            }
        }
        return out.toString();
    }
}
