package nomos.java;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * JSON without dependencies: the standard library of Java has no parser (D-058). Objects are LinkedHashMap in source
 * order, arrays ArrayList, numbers Long or Double; the writer formats like JSON.stringify(value, null, 2).
 */
final class Json {
    private Json() {
    }

    static final class ParseError extends Exception {
        private static final long serialVersionUID = 1L;

        ParseError(String message) {
            super(message);
        }
    }

    static Object parse(String text) throws ParseError {
        Reader r = new Reader(text);
        r.space();
        Object value = r.value();
        r.space();
        if (r.at < text.length()) throw new ParseError("unexpected text at offset " + r.at);
        return value;
    }

    private static final class Reader {
        final String s;
        int at;

        Reader(String s) {
            this.s = s;
        }

        void space() {
            while (at < s.length() && " \t\r\n".indexOf(s.charAt(at)) >= 0) at++;
        }

        ParseError error(String what) {
            return new ParseError(what + " at offset " + at);
        }

        Object value() throws ParseError {
            if (at >= s.length()) throw error("unexpected end");
            char c = s.charAt(at);
            switch (c) {
                case '{': {
                    at++;
                    Map<String, Object> map = new LinkedHashMap<>();
                    space();
                    if (peek('}')) return map;
                    while (true) {
                        space();
                        if (at >= s.length() || s.charAt(at) != '"') throw error("expected a key");
                        String key = string();
                        space();
                        expect(':');
                        space();
                        map.put(key, value());
                        space();
                        if (peek('}')) return map;
                        expect(',');
                    }
                }
                case '[': {
                    at++;
                    List<Object> list = new ArrayList<>();
                    space();
                    if (peek(']')) return list;
                    while (true) {
                        space();
                        list.add(value());
                        space();
                        if (peek(']')) return list;
                        expect(',');
                    }
                }
                case '"':
                    return string();
                case 't':
                    word("true");
                    return Boolean.TRUE;
                case 'f':
                    word("false");
                    return Boolean.FALSE;
                case 'n':
                    word("null");
                    return null;
                default:
                    return number();
            }
        }

        boolean peek(char c) {
            if (at < s.length() && s.charAt(at) == c) {
                at++;
                return true;
            }
            return false;
        }

        void expect(char c) throws ParseError {
            if (!peek(c)) throw error("expected '" + c + "'");
        }

        void word(String w) throws ParseError {
            if (!s.startsWith(w, at)) throw error("unexpected token");
            at += w.length();
        }

        Object number() throws ParseError {
            int start = at;
            while (at < s.length() && "+-0123456789.eE".indexOf(s.charAt(at)) >= 0) at++;
            String text = s.substring(start, at);
            if (text.isEmpty()) throw error("unexpected character");
            try {
                if (text.matches("-?\\d+")) return Long.parseLong(text);
                return Double.parseDouble(text);
            } catch (NumberFormatException e) {
                throw error("bad number");
            }
        }

        String string() throws ParseError {
            at++;
            StringBuilder b = new StringBuilder();
            while (true) {
                if (at >= s.length()) throw error("unterminated string");
                char c = s.charAt(at++);
                if (c == '"') return b.toString();
                if (c != '\\') {
                    b.append(c);
                    continue;
                }
                if (at >= s.length()) throw error("unterminated string");
                char e = s.charAt(at++);
                switch (e) {
                    case 'n' -> b.append('\n');
                    case 't' -> b.append('\t');
                    case 'r' -> b.append('\r');
                    case 'b' -> b.append('\b');
                    case 'f' -> b.append('\f');
                    case 'u' -> {
                        if (at + 4 > s.length()) throw error("bad escape");
                        b.append((char) Integer.parseInt(s.substring(at, at + 4), 16));
                        at += 4;
                    }
                    default -> b.append(e);
                }
            }
        }
    }

    // Writing ---------------------------------------------------------------------------------------------------------

    static String write(Object value) {
        StringBuilder b = new StringBuilder();
        write(b, value, "");
        return b.append('\n').toString();
    }

    private static void write(StringBuilder b, Object value, String indent) {
        if (value == null) {
            b.append("null");
        } else if (value instanceof String text) {
            quote(b, text);
        } else if (value instanceof Boolean flag) {
            b.append(flag);
        } else if (value instanceof Integer || value instanceof Long) {
            b.append(value);
        } else if (value instanceof Double number) {
            b.append(number(number));
        } else if (value instanceof Map<?, ?> map) {
            if (map.isEmpty()) {
                b.append("{}");
                return;
            }
            String inner = indent + "  ";
            b.append("{\n");
            int i = 0;
            for (Map.Entry<?, ?> e : map.entrySet()) {
                b.append(inner);
                quote(b, (String) e.getKey());
                b.append(": ");
                write(b, e.getValue(), inner);
                if (++i < map.size()) b.append(',');
                b.append('\n');
            }
            b.append(indent).append('}');
        } else if (value instanceof List<?> list) {
            if (list.isEmpty()) {
                b.append("[]");
                return;
            }
            String inner = indent + "  ";
            b.append("[\n");
            for (int i = 0; i < list.size(); i++) {
                b.append(inner);
                write(b, list.get(i), inner);
                if (i + 1 < list.size()) b.append(',');
                b.append('\n');
            }
            b.append(indent).append(']');
        } else {
            throw new IllegalArgumentException("not a JSON value: " + value.getClass());
        }
    }

    /** A whole number without a fraction, any other in plain notation: 0.0001, not 1.0E-4, as JavaScript writes it. */
    static String number(double value) {
        if (Double.isNaN(value) || Double.isInfinite(value)) return "null";
        if (value == Math.rint(value) && Math.abs(value) < 1e15) return Long.toString((long) value);
        return new BigDecimal(Double.toString(value)).stripTrailingZeros().toPlainString();
    }

    private static void quote(StringBuilder b, String s) {
        b.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"' -> b.append("\\\"");
                case '\\' -> b.append("\\\\");
                case '\n' -> b.append("\\n");
                case '\r' -> b.append("\\r");
                case '\t' -> b.append("\\t");
                case '\b' -> b.append("\\b");
                case '\f' -> b.append("\\f");
                default -> {
                    if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
                    else b.append(c);
                }
            }
        }
        b.append('"');
    }

    // Reading helpers ---------------------------------------------------------------------------------------------------

    @SuppressWarnings("unchecked")
    static Map<String, Object> object(Object value) {
        return value instanceof Map<?, ?> ? (Map<String, Object>) value : Map.of();
    }

    @SuppressWarnings("unchecked")
    static List<Object> array(Object value) {
        return value instanceof List<?> ? (List<Object>) value : List.of();
    }

    static String string(Object value) {
        return value instanceof String s ? s : null;
    }

    /** An ordered object built from key-value pairs. */
    static Map<String, Object> obj(Object... pairs) {
        Map<String, Object> map = new LinkedHashMap<>();
        for (int i = 0; i < pairs.length; i += 2) map.put((String) pairs[i], pairs[i + 1]);
        return map;
    }
}
