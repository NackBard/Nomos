package pa.dispatch

class A {
}

class B {
}

class C {
}

class Router {
    companion object {
        fun route(x: Any): Int {
            if (x is A) {
                return 1
            }

            if (x is B) {
                return 2
            }

            if (x is C) {
                return 3
            }

            return 0
        }
    }
}
