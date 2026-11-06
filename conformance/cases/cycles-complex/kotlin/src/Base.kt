package cx.mixed

open class Base {
    fun make(): Any {
        return Derived()
    }
}

class Derived : Base() {
}
