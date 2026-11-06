// nomos-disable ALG001
package sup.whole;

public class Quiet {
    public int pairs(int[] a) { int n = 0; for (int x : a) { for (int y : a) { n += x * y; } } return n; }
}
