namespace F;
public static class C
{
    public static int Fact(int n, int acc) => n <= 1 ? acc : Fact(n - 1, acc * n);
}
