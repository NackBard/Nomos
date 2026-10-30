namespace F;
public class C
{
    public int Common(List<int> a, List<int> b)
    {
        var n = 0;
        foreach (var x in a)
            if (b.Contains(x)) n++; // expect
        return n;
    }
    public string Join(string[] parts)
    {
        var s = "";
        foreach (var p in parts) s += p; // expect
        return s;
    }
    public void Drain(List<int> a)
    {
        while (a.Count > 0) a.RemoveAt(0); // expect
    }
}
