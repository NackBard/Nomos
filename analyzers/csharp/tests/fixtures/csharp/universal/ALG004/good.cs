namespace F;
public class C
{
    public List<int> Copy(int[] a)
    {
        var r = new List<int>();
        foreach (var x in a) r.Add(x);
        return r;
    }
}
