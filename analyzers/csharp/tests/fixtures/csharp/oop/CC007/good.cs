namespace F;
public class C(int seed)
{
    private readonly int _used = 1;
    public int Property { get; } = seed;
    public int Go(object o)
    {
        switch (o)
        {
            case int i when Allowed(i): return i;
            default: return _used;
        }
    }
    private bool Allowed(int i) => i > 0;
}
