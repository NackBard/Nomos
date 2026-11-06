package pa.lambdas

class Scanner {
    companion object {
        fun scan(xs: IntArray): Int {
            return xs.filter { x -> xs.any { y -> y == x } }.firstOrNull() ?: 0
        }
    }
}
