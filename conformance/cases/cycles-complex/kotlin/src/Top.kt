package cx.dag

class Top {
    lateinit var m1: Mid1
    lateinit var m2: Mid2
}

class Mid1 {
    lateinit var end: Bottom
}

class Mid2 {
    lateinit var end: Bottom
}

class Bottom {
}

class Self {
    lateinit var next: Self
}
