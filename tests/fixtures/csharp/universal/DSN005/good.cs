namespace F;
public class Order
{
    public int Price { get; set; }
    public int Tax { get; set; }
    public int Total() => Price + Tax;
}
public sealed record Line(int A, int B, int C);
public class Printer
{
    public int Sum(Line l) => l.A + l.B + l.C;
}
