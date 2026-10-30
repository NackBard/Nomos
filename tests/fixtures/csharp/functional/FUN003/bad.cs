namespace F;
public class Box // expect
{
    public int Value { get; set; }
}
public static class C
{
    public static int Go() // expect
    {
        var x = 1;
        x = 2;
        return x;
    }
}
