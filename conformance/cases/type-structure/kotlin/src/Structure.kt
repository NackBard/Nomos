package ts

interface Shape {
    fun area(): Double
}

abstract class Base : Shape {
    protected var name: String = ""

    abstract override fun area(): Double
}

enum class Scale {
    MM,
    CM,
}

class Square(private val side: Double) : Base() {
    var unit: Scale? = null

    override fun area(): Double {
        return side * side
    }

    companion object {
        const val SIDES = 4
        var created = 0
    }
}

class Drawing<T> {
    private val items: MutableList<T> = ArrayList()
    private var frame: Square? = null

    fun add(item: T, vararg tags: String) {
        items.add(item)
    }

    companion object {
        fun <T> empty(): Drawing<T> {
            return Drawing()
        }
    }
}

class Painter {
    fun paint(square: Square): Double {
        return square.area()
    }
}

data class Point(val x: Int, val y: Int)
