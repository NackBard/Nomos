namespace Pa.Hof;

public class Apply
{
    public static int Twice(System.Func<int, int> f, int x)
    {
        return f(f(x));
    }
}
