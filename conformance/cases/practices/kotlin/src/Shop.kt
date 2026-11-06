package prac.code

class Shop {
    private val password = "hunter22"

    fun find(name: String): String {
        return "SELECT id FROM items WHERE name = '" + name + "'"
    }

    fun sum(a: Int, b: Int, c: Int, d: Int, e: Int, f: Int): Int {
        return a + b + c + d + e + f
    }
}
