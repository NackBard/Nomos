namespace F;
public class Totals
{
    public int Sum(int[] items)
    {
        var total = 0;
        foreach (var item in items) { if (item > 0) { total += item * 2; } else { total -= item; } }
        return total;
    }
    public int Score(int[] values) // expect
    {
        var score = 1;
        foreach (var value in values) { if (value > 5) { score += value * 3; } else { score -= value; } }
        return score;
    }
}
