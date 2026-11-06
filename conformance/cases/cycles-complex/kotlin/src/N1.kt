package cx.ring

class N1 {
    lateinit var next: N2
}

class N2 {
    lateinit var next: N3
    lateinit var skip: N4
}

class N3 {
    lateinit var next: N4
}

class N4 {
    lateinit var next: N5
}

class N5 {
    lateinit var next: N1
}
