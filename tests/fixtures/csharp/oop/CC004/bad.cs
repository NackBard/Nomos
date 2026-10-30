namespace F;
public class C
{
    public int Deep(int a) // expect
    {
        if (a > 0) { if (a > 1) { if (a > 2) { if (a > 3) { if (a > 4) { return 1; } } } } }
        return 0;
    }
}
