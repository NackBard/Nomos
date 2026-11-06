package pa.hof

class Apply {
    companion object {
        fun twice(f: (Int) -> Int, x: Int): Int {
            return f(f(x))
        }
    }
}
