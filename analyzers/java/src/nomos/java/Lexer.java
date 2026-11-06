package nomos.java;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;

/**
 * Tokens of a Java source for lines of code, Halstead volume, clones and suppression comments. javac keeps its scanner
 * in an internal package, so the analyzer has its own; it only has to find token boundaries, not parse.
 */
final class Lexer {
    enum Kind { NAME, KEYWORD, LITERAL, OP }

    record Token(int line, int endLine, Kind kind, String text, int start, int end) {
    }

    record Comment(String text, int startLine, int endLine, int start, int end) {
    }

    record Result(List<Token> tokens, List<Comment> comments, int loc) {
    }

    static final Set<String> KEYWORDS = Set.of(
        "abstract", "assert", "boolean", "break", "byte", "case", "catch", "char", "class", "const", "continue", "default", "do", "double", "else", "enum",
        "extends", "final", "finally", "float", "for", "goto", "if", "implements", "import", "instanceof", "int", "interface", "long", "native", "new",
        "package", "private", "protected", "public", "return", "short", "static", "strictfp", "super", "switch", "synchronized", "this", "throw", "throws",
        "transient", "try", "void", "volatile", "while", "var", "record", "yield", "sealed", "permits", "non-sealed");
    private static final Set<String> LITERAL_WORDS = Set.of("true", "false", "null");
    private static final String[] OPERATORS = {
        ">>>=", "<<=", ">>=", ">>>", "...", "->", "::", "++", "--", "&&", "||", "==", "!=", "<=", ">=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<", ">>",
    };

    private Lexer() {
    }

    static Result scan(String s) {
        List<Token> tokens = new ArrayList<>();
        List<Comment> comments = new ArrayList<>();
        int[] lineStarts = lineStarts(s);
        int i = 0;
        int n = s.length();
        while (i < n) {
            char c = s.charAt(i);
            if (Character.isWhitespace(c)) {
                i++;
                continue;
            }
            int start = i;
            if (c == '/' && i + 1 < n && s.charAt(i + 1) == '/') {
                while (i < n && s.charAt(i) != '\n') i++;
                comments.add(new Comment(s.substring(start, i), line(lineStarts, start), line(lineStarts, start), start, i));
                continue;
            }
            if (c == '/' && i + 1 < n && s.charAt(i + 1) == '*') {
                int end = s.indexOf("*/", i + 2);
                i = end < 0 ? n : end + 2;
                comments.add(new Comment(s.substring(start, i), line(lineStarts, start), line(lineStarts, Math.max(start, i - 1)), start, i));
                continue;
            }
            Kind kind;
            if (c == '"' && s.startsWith("\"\"\"", i)) {
                i += 3;
                while (i < n && !s.startsWith("\"\"\"", i)) i += s.charAt(i) == '\\' ? 2 : 1;
                i = Math.min(n, i + 3);
                kind = Kind.LITERAL;
            } else if (c == '"' || c == '\'') {
                i++;
                while (i < n && s.charAt(i) != c && s.charAt(i) != '\n') i += s.charAt(i) == '\\' ? 2 : 1;
                i = Math.min(n, i + 1);
                kind = Kind.LITERAL;
            } else if (Character.isDigit(c) || (c == '.' && i + 1 < n && Character.isDigit(s.charAt(i + 1)))) {
                i++;
                while (i < n) {
                    char d = s.charAt(i);
                    if (Character.isLetterOrDigit(d) || d == '_' || d == '.') {
                        i++;
                    } else if ((d == '+' || d == '-') && "eEpP".indexOf(s.charAt(i - 1)) >= 0 && !s.substring(start, i).startsWith("0x")) {
                        i++;
                    } else {
                        break;
                    }
                }
                kind = Kind.LITERAL;
            } else if (Character.isJavaIdentifierStart(c)) {
                while (i < n && Character.isJavaIdentifierPart(s.charAt(i))) i++;
                String word = s.substring(start, i);
                if (word.equals("non") && s.startsWith("-sealed", i)) {
                    i += "-sealed".length();
                    word = "non-sealed";
                }
                kind = LITERAL_WORDS.contains(word) ? Kind.LITERAL : KEYWORDS.contains(word) ? Kind.KEYWORD : Kind.NAME;
            } else {
                String op = String.valueOf(c);
                for (String candidate : OPERATORS) {
                    if (s.startsWith(candidate, i)) {
                        op = candidate;
                        break;
                    }
                }
                i += op.length();
                kind = Kind.OP;
            }
            tokens.add(new Token(line(lineStarts, start), line(lineStarts, Math.max(start, i - 1)), kind, s.substring(start, i), start, i));
        }
        boolean[] code = new boolean[lineStarts.length + 2];
        for (Token t : tokens) for (int l = t.line(); l <= t.endLine(); l++) code[l] = true;
        int loc = 0;
        for (boolean b : code) if (b) loc++;
        return new Result(tokens, comments, loc);
    }

    static int[] lineStarts(String s) {
        List<Integer> starts = new ArrayList<>();
        starts.add(0);
        for (int i = 0; i < s.length(); i++) if (s.charAt(i) == '\n') starts.add(i + 1);
        int[] result = new int[starts.size()];
        for (int i = 0; i < result.length; i++) result[i] = starts.get(i);
        return result;
    }

    /** The 1-based line of an offset. */
    static int line(int[] starts, int offset) {
        int lo = 0;
        int hi = starts.length - 1;
        while (lo < hi) {
            int mid = (lo + hi + 1) >>> 1;
            if (starts[mid] <= offset) lo = mid;
            else hi = mid - 1;
        }
        return lo + 1;
    }
}
