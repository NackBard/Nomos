namespace F;
public class P { }
public class C
{
    public int Go(List<int> a, int[] b)
    {
        var n = 0;
        foreach (var x in a)
        {
            n += a.ToList().Count; // expect
            foreach (var y in b)
            {
                var p = new P(); // expect
                n += p.GetHashCode();
            }
        }
        return n;
    }
}
