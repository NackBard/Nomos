package smell.report

import smell.data.Money
import smell.data.Order

class Printer {
    private var copies = 0
    private var width = 0
    private var depth = 0

    constructor() {
        copies = 1
    }

    fun envy(order: Order): Int {
        return order.price + order.tax + order.fee
    }

    fun balanced(order: Order): Int {
        return order.price + order.tax + order.fee + copies + width + depth
    }

    fun few(order: Order): Int {
        return order.price + order.tax
    }

    fun readsMoney(money: Money): Int {
        return money.amount + money.cents + money.rate
    }

    companion object {
        fun sum(order: Order): Int {
            return order.price + order.tax + order.fee
        }
    }
}
