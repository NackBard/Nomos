namespace F;
public class C
{
    public int Common(List<int> a, HashSet<int> b)
    {
        var n = 0;
        foreach (var x in a)
            if (b.Contains(x)) n++;
        return n;
    }
}
