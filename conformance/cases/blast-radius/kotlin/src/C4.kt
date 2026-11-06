package blast.chain

class C1 {
}

class C2 {
    lateinit var prev: C1
}

class C3 {
    lateinit var prev: C2
}

class C4 {
    lateinit var prev: C3
}
