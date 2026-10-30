namespace F;
internal interface IOnly { } // expect
internal class Single : IOnly
{
    public int Go() => Helper(1, 2);
    private int Helper(int used, int unused) => used; // expect
}
