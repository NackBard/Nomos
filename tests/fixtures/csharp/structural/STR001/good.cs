namespace F;
public class C
{
    public int Go(int a)
    {
        while (a > 0) a--;
        switch (a) { case 0: goto case 1; case 1: return 1; default: return a; }
    }
}
