package metrics

class Basics {
    companion object {
        fun straight(a: Int): Int {
            return a + 1
        }

        // A comment line inside the type: it counts toward lines but not toward loc.
        fun branches(a: Int, b: Int): Int {
            if (a > 0 && b > 0) {
                return 1
            } else if (a < 0 || b < 0) {
                return -1
            }

            return 0
        }

        fun loops(items: IntArray, limit: Int): Int {
            var total = 0
            for (item in items) {
                for (i in 0 until limit) {
                    if (item > i) {
                        total += item
                    }
                }
            }

            return total
        }

        fun switches(kind: Int, text: String): String {
            try {
                when (kind) {
                    1 -> return "one"
                    2 -> return "two"
                    else -> return text
                }
            } catch (e: IllegalStateException) {
                return if (kind > 0) "error" else "unknown"
            }
        }
    }
}
