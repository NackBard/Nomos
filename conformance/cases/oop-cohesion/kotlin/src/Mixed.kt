package oc

class Data {
    var value = 0
    var other = 0
}

open class Mixed {
    private var a = 0
    private var b = 0
    var source = Data()

    fun incA() {
        a++
    }

    fun readA(): Int {
        return a
    }

    fun incB() {
        b++
    }

    fun peek(): Int {
        return source.value + source.other
    }
}

class Derived : Mixed()
