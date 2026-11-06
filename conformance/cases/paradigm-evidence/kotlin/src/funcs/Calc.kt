package pe.funcs

class Calc {
    companion object {
        var counter = 0

        fun add(a: Int, b: Int): Int {
            return a + b
        }

        fun bump() {
            counter++
        }
    }
}
