namespace F;
public class C
{
    public int Twice(int x) => x * 2;
    public int Sum(List<int> items)
    {
        var total = 0;
        items.ForEach(x => total += x); // expect
        return total;
    }
}
