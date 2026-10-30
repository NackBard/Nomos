namespace F;
public static class Constants
{
    public const int Max = 1;
    public static readonly string Name = "n";
    private static int _cache;
    public static int Cached() => _cache++;
}
