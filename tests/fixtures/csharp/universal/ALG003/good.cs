namespace F;
public class C
{
    public int Go(List<int> a)
    {
        var copy = a.ToList();
        var n = 0;
        foreach (var x in copy) n += x;
        return n;
    }
}
