namespace F;
public enum Kind { A, B, C }
public class Prices
{
    public int Price(Kind k)
    {
        switch (k) // expect
        {
            case Kind.A: return 1;
            case Kind.B: return 2;
            default: return 3;
        }
    }
    public string Name(Kind k) => k switch { Kind.A => "a", Kind.B => "b", _ => "c" };
}
