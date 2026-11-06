// nomos-disable ALG001
package sup.whole

class Quiet {
    fun pairs(a: IntArray): Int { var n = 0; for (x in a) { for (y in a) { n += x * y } }; return n }
}
