namespace F;
public class C
{
    public int Go(int a) // expect
    {
        if (a > 0 && a < 5) return 1;
        return a > 9 ? 2 : 3;
    }
}
