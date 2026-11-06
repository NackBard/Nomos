package metrics;

public class Basics {
    public static int straight(int a) {
        return a + 1;
    }

    // A comment line inside the type: it counts toward lines but not toward loc.
    public static int branches(int a, int b) {
        if (a > 0 && b > 0) {
            return 1;
        } else if (a < 0 || b < 0) {
            return -1;
        }

        return 0;
    }

    public static int loops(int[] items, int limit) {
        int total = 0;
        for (int item : items) {
            for (int i = 0; i < limit; i++) {
                if (item > i) {
                    total += item;
                }
            }
        }

        return total;
    }

    public static String switches(int kind, String text) {
        try {
            switch (kind) {
                case 1:
                    return "one";
                case 2:
                    return "two";
                default:
                    return text;
            }
        } catch (IllegalStateException e) {
            return kind > 0 ? "error" : "unknown";
        }
    }
}
