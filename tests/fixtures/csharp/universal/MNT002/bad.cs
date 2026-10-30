namespace F;
public class C
{
    public int Go(int a) // expect
    {
        var b = a + 1;
        var c = b * 2;
        if (c > 3) { b = c - a; }
        for (var i = 0; i < a; i++) { c += i * b; }
        while (c > 100) { c /= 2; b++; }
        return b + c;
    }
}
