namespace F;
public class Totals
{
    public int Sum(int[] items)
    {
        var total = 0;
        foreach (var item in items) { total += item; }
        return total;
    }
    public int Largest(int[] values)
    {
        var best = 0;
        foreach (var value in values) { if (value > best) { best = value; } }
        return best;
    }
}
