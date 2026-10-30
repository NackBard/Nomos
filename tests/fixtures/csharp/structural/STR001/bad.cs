namespace F;
public class C
{
    public int Go(int a)
    {
        again:
        a--;
        if (a > 0) goto again; // expect
        return a;
    }
}
