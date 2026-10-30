namespace F;
public class A
{
    public int Go(int a) { var b = a + 1; if (b > 2) { return b * 3; } return b - 4; }
}
public class B // expect
{
    public int Run(int x) { var y = x + 5; if (y > 6) { return y * 7; } return y - 8; }
}
