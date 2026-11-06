package blast.ring

class R1 {
    lateinit var next: R2
}

class R2 {
    lateinit var next: R3
}

class R3 {
    lateinit var next: R1
    lateinit var end: Leaf
}

class Tail {
    lateinit var head: R1
}

class Leaf {
    lateinit var last: blast.chain.C4
}
