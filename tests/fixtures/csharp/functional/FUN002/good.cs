namespace F;
public class C
{
    public int Sum(List<int> items) => items.Select(x => { var y = x * 2; y += 1; return y; }).Sum();
}
