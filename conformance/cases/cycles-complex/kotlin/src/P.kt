package cx.eight

class P {
    lateinit var next: Q
}

class Q {
    lateinit var back: P
    lateinit var side: S
}

class S {
    lateinit var back: Q
}
