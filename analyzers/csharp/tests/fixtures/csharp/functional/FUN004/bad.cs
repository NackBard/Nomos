namespace F;
public static class C
{
    public static int Fact(int n) => n <= 1 ? 1 : n * Fact(n - 1); // expect
}
