package alg.code

class Memory {
    fun none(a: Int): Int {
        return a
    }

    fun grows(items: IntArray): List<Int> {
        val list = ArrayList<Int>()
        for (x in items) {
            list.add(x)
        }
        return list
    }

    fun grid(a: IntArray, b: IntArray): Int {
        val list = ArrayList<Int>()
        for (x in a) {
            for (y in b) {
                list.add(x + y)
            }
        }
        return list.size
    }

    fun sized(n: Int): IntArray {
        return IntArray(n)
    }

    fun constant(): IntArray {
        return IntArray(8)
    }

    fun deep(n: Int): Int {
        if (n < 1) {
            return 0
        }
        return deep(n - 1)
    }

    fun newInNested(a: IntArray, b: IntArray): Int {
        var n = 0
        for (x in a) {
            for (y in b) {
                n += Box().size + x + y
            }
        }
        return n
    }

    fun newInLoop(a: IntArray): Int {
        var n = 0
        for (x in a) {
            n += Box().size + x
        }
        return n
    }
}

class Box {
    var size = 0
}
