package alg.code

class Estimates {
    fun constant(a: Int): Int {
        return a + 1
    }

    fun linear(items: IntArray): Int {
        var n = 0
        for (x in items) {
            n += x
        }
        return n
    }

    fun quadratic(a: IntArray, b: IntArray): Int {
        var n = 0
        for (x in a) {
            for (y in b) {
                n += x * y
            }
        }
        return n
    }

    fun halving(size: Int): Int {
        var steps = 0
        var i = size
        while (i > 0) {
            i /= 2
            steps++
        }
        return steps
    }

    fun linearLog(items: IntArray): Int {
        var n = 0
        for (x in items) {
            n += halving(x)
        }
        return n
    }

    fun fixed(): Int {
        var n = 0
        for (i in 0 until 10) {
            n += i
        }
        return n
    }

    fun fib(n: Int): Int {
        if (n < 2) {
            return n
        }
        return fib(n - 1) + fib(n - 2)
    }

    fun factorial(n: Int): Int {
        if (n < 2) {
            return 1
        }
        return n * factorial(n - 1)
    }

    fun search(items: IntArray, low: Int, high: Int): Int {
        if (low >= high) {
            return low
        }
        val mid = (low + high) / 2
        if (items[mid] > 0) {
            return search(items, low, mid)
        }
        return search(items, mid, high)
    }

    fun cubicViaCallee(items: IntArray): Int {
        var n = 0
        for (x in items) {
            n += quadratic(items, items)
        }
        return n
    }
}
