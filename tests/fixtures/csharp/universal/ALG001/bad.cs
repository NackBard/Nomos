namespace F;
public class C
{
    public int Pairs(int[] a, int[] b) // expect
    {
        var n = 0;
        foreach (var x in a) { foreach (var y in b) { n += x * y; } }
        return n;
    }
    public int Fib(int n) => n < 2 ? n : Fib(n - 1) + Fib(n - 2); // expect
}
