namespace F;
public class C
{
    public int Chain(int a)
    {
        if (a > 4) return 5;
        else if (a > 3) return 4;
        else if (a > 2) return 3;
        else if (a > 1) return 2;
        else if (a > 0) return 1;
        return 0;
    }
}
