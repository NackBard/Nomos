package smell.report

import smell.data.Order

class God {
    private var a = 0
    private var b = 0
    private var c = 0
    private var d = 0

    fun one(order: Order): Int {
        if (order.price > 0) {
            return a
        }
        return 0
    }

    fun two(order: Order): Int {
        if (order.tax > 0) {
            return b
        }
        return 0
    }

    fun three(order: Order): Int {
        if (order.fee > 0) {
            return c
        }
        return 0
    }

    fun four(order: Order): Int {
        if (order.price > 0) {
            return d
        }
        return 0
    }
}
