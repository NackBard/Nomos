// nomos-disable ALG001
namespace Sup.Whole;

public class Quiet
{
    public int Pairs(int[] a) { var n = 0; foreach (var x in a) { foreach (var y in a) { n += x * y; } } return n; }
}
