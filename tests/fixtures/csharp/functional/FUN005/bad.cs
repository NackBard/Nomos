namespace F;
public static class C
{
    public static int Apply(Func<Func<int, int>, int> f) => f(x => x); // expect
    public static Func<int, Func<int, Func<int, int>>> Curry() => a => b => c => a + b + c; // expect
}
