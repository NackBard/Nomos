package sup.code

class Loops {
    fun reported(a: IntArray): Int { var n = 0; for (x in a) { for (y in a) { n += x * y } }; return n }

    // nomos-disable-next-line ALG001
    fun next(a: IntArray): Int { var n = 0; for (x in a) { for (y in a) { n += x * y } }; return n }

    fun same(a: IntArray): Int { var n = 0; for (x in a) { for (y in a) { n += x * y } }; return n } // nomos-disable-line ALG001

    // nomos-disable-next-line CC001
    fun otherRule(a: IntArray): Int { var n = 0; for (x in a) { for (y in a) { n += x * y } }; return n }

    fun reasoned(a: IntArray): Int { var n = 0; for (x in a) { for (y in a) { n += x * y } }; return n } // nomos-disable-line alg001, CC003 -- input is bounded
}
