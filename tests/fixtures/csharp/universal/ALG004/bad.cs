namespace F;
public class C
{
    public List<int> Table(int[] a, int[] b) // expect
    {
        var r = new List<int>();
        foreach (var x in a) { foreach (var y in b) { r.Add(x * y); } }
        return r;
    }
    public int[,] Grid(int n) => new int[n, n]; // expect
}
