package cyc.d

class D1 {
    lateinit var peer: cyc.d.D2
    lateinit var entry: cyc.a.A1
}

class D2 {
    lateinit var peer: cyc.d.D1
}
