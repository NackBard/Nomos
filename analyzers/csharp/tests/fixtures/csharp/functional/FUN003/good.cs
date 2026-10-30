namespace F;
public sealed record Box(int Value);
public static class C
{
    public static int Go() { var x = 1; var y = x + 1; return y; }
    public static int Loop() { var t = 0; for (var i = 0; i < 3; i++) { } return t; }
}
